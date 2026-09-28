import "server-only";

import { pipeline } from "stream/promises";
import { Writable } from "stream";
import { randomUUID, timingSafeEqual } from "crypto";
import { AdminRole, Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/db";
import { canWithOverrides } from "@/lib/admin/rbac";
import { verifyPassword } from "@/lib/admin/password";
import { audit } from "@/lib/admin/audit";

import {
  loadBackupSubkeys,
  wipeSubkeys,
  createBackupDecryptStream,
  timingSafeStringEquals,
  IV_BYTES,
  TAG_BYTES,
  BackupCryptoConfigError
} from "./crypto";
import {
  openPublishedReadStream,
  statPublishedBackup,
  publishedBackupExists,
  assertValidBackupId,
  BackupStorageError
} from "./storage";
import {
  parseAndVerifyManifest,
  ManifestParseError,
  ManifestHmacError
} from "./manifest";
import { MODEL_ORDER, DROP_ORDER, type BackupModelName } from "./model-order";
import { decodeRow, BackupSerializerError } from "./serializer";
import { runBackupDump } from "./dump";
import { verifyBackup } from "./verify";
import { BackupServiceError, type Actor } from "./service";

// ─── Restore engine (Phase 7) ───────────────────────────────────────────────
//
// A restore is the most destructive operation this system exposes. It
// is designed around SAFETY, VALIDATION, ISOLATION, and RECOVERABILITY.
//
// GUARANTEES:
//   • No destructive action runs until Phase 5 verification of the source
//     backup returns VERIFIED.
//   • A pre-destruction safety backup is CREATED and VERIFIED before the
//     destructive apply. Failure to create/verify aborts the restore.
//   • The destructive apply is one Postgres RepeatableRead transaction:
//     either all rows are replaced or none are.
//   • The RestoreOperation, safety Backup, and source Backup rows are
//     preserved across the destructive boundary (upserted after the row
//     wipe) so the audit chain survives the operation that wiped it.
//   • Only ONE restore can run at a time. Enforced via a check-then-
//     insert-then-re-check sequence: (1) refuse if any Backup is
//     PENDING/RUNNING OR any RestoreOperation is INITIATED/PREFLIGHT/
//     RUNNING; (2) insert our RestoreOperation row; (3) re-scan and
//     abort if any OTHER RestoreOperation is now in flight (both
//     racers would abort, no destructive action taken by either). Not
//     a hard DB-level lock — that would need an advisory-lock or
//     SELECT FOR UPDATE on a dedicated singleton row; for BIS 2027's
//     scale the check+re-check pattern is race-safe (both racers see
//     each other and both abort). Documented so a future contributor
//     doesn't mis-assume atomicity.
//   • The actor must present a matching confirmation phrase AND their
//     admin password. Both are timing-safe compared.
//   • Schema mismatch is refused unless the actor is SUPER_ADMIN AND
//     passes `force: true` — audited with meta.forced=true.
//   • After a successful restore, ALL AdminSession + AccountSession rows
//     are deleted; every user re-authenticates.
//
// EXPLICITLY DEFERRED to future work:
//   • Staging-restore isolation — this project has ONE Postgres schema
//     accessible to Prisma at runtime. A true staged-then-promoted
//     restore would need infrastructure the project does not yet have.
//     Documented in the review.
//   • Automatic rollback via safety backup on post-restore-verify
//     failure — the operator triggers a follow-up restore explicitly.
//     Auto-rollback risks compounding damage if the safety backup itself
//     is somehow degraded.

// ─── Public API ─────────────────────────────────────────────────────────────

export interface RunRestoreOptions {
  actor: Actor;
  backupId: string;
  confirmationPhrase: string;
  adminPassword: string;
  /**
   * Allow restore against a schema-incompatible backup. SUPER_ADMIN only.
   * Audited with `meta.forced=true`. Data loss is possible.
   */
  force?: boolean;
  /** Prisma client override (tests). */
  client?: PrismaClient;
}

export type RestoreFailureCode =
  | "UNAUTHORIZED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFIRMATION_INVALID"
  | "CONCURRENCY_CONFLICT"
  | "VERIFICATION_FAILED"
  | "SCHEMA_INCOMPATIBLE"
  | "SAFETY_BACKUP_FAILED"
  | "STORAGE_UNAVAILABLE"
  | "CRYPTO_UNAVAILABLE"
  | "ACTOR_NOT_IN_SOURCE"
  | "APPLY_FAILED"
  | "POST_RESTORE_VERIFY_FAILED"
  | "INTERNAL";

export interface RestoreResult {
  ok: boolean;
  code: RestoreFailureCode | "OK";
  restoreOperationId?: string;
  safetyBackupId?: string;
  publicMessage: string;
  operationId: string;
  durationMs: number;
}

export class BackupRestoreError extends Error {
  constructor(
    public readonly code: RestoreFailureCode,
    public readonly publicMessage: string,
    public readonly internal?: string
  ) {
    super(`${code}: ${publicMessage}`);
    this.name = "BackupRestoreError";
  }
}

const PUBLIC_MESSAGE: Record<RestoreFailureCode | "OK", string> = {
  OK: "Restauration terminée avec succès.",
  UNAUTHORIZED: "Permission refusée.",
  INVALID_INPUT: "Entrée invalide.",
  NOT_FOUND: "Sauvegarde introuvable.",
  CONFIRMATION_INVALID: "Confirmation ou mot de passe invalide.",
  CONCURRENCY_CONFLICT:
    "Une autre opération de sauvegarde ou de restauration est déjà en cours.",
  VERIFICATION_FAILED:
    "La sauvegarde n’a pas passé la vérification d’intégrité.",
  SCHEMA_INCOMPATIBLE:
    "Le schéma de cette sauvegarde ne correspond pas au schéma actuel.",
  SAFETY_BACKUP_FAILED:
    "La création de la sauvegarde de sécurité a échoué — restauration abandonnée.",
  STORAGE_UNAVAILABLE:
    "Le fichier de sauvegarde est indisponible ou inaccessible.",
  CRYPTO_UNAVAILABLE: "Clé de chiffrement des sauvegardes non configurée.",
  ACTOR_NOT_IN_SOURCE:
    "Votre compte administrateur n’existait pas au moment de cette sauvegarde — la restauration abandonnerait votre accès et est refusée.",
  APPLY_FAILED:
    "L’application destructive a échoué. La base de données a été restaurée à son état antérieur.",
  POST_RESTORE_VERIFY_FAILED:
    "La vérification post-restauration a échoué — état incertain, consulter les logs.",
  INTERNAL: "Erreur interne — voir les logs pour l’operationId indiqué."
};

// Resource caps for the restore payload — parallel to the verifier caps.
const MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ROWS = 100_000_000;
const NEWLINE = 0x0a;
const MODEL_SET = new Set<string>(MODEL_ORDER);
const CUID_RE = /^c[a-z0-9]{24}$/;

// Models whose rows we DO NOT re-insert during restore. The DROP_ORDER
// wipe above still deletes existing rows for these tables — the net
// effect is "session tables end up empty", which is what §7 of the
// implementation plan calls for ("every user re-authenticates").
//
// Doing this via skip-on-insert (rather than insert-then-delete) means:
//   • No brief window where source-backup session tokenHashes sit in
//     the DB, even inside the txn (defence in depth against
//     data-at-rest exposure).
//   • Session wipe is TRANSACTIONAL with the destructive apply — a
//     mid-flight network blip cannot leave live attacker sessions.
//     Post-Phase-6/7 security review HIGH finding.
const RESTORE_SKIP_MODELS = new Set<BackupModelName>([
  "AdminSession",
  "AccountSession"
]);

// Timeout for the destructive apply transaction. Same ceiling logic as
// dump.ts: 30 min default, 2h ceiling, overridable via env.
const DEFAULT_RESTORE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RESTORE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MIN_RESTORE_TIMEOUT_MS = 60 * 1000;

function loadRestoreTimeoutMs(): number {
  const raw = process.env.BACKUP_RESTORE_TIMEOUT_MS;
  if (!raw) return DEFAULT_RESTORE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_RESTORE_TIMEOUT_MS || n > MAX_RESTORE_TIMEOUT_MS) {
    return DEFAULT_RESTORE_TIMEOUT_MS;
  }
  return Math.floor(n);
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Run a full restore. Blocks until either the restore commits or the
 * pipeline fails safely. NEVER throws — all outcomes are returned via
 * the `RestoreResult` sanitized shape. Internal detail lands in the
 * audit log for the operator to look up via `operationId`.
 */
export async function runRestore(opts: RunRestoreOptions): Promise<RestoreResult> {
  const start = Date.now();
  const operationId = randomUuid();
  const client = opts.client ?? prisma;
  let restoreOperationId: string | undefined;
  let safetyBackupId: string | undefined;

  try {
    // ── 1. AUTHZ ─────────────────────────────────────────────────────
    const ok = await canWithOverrides(opts.actor.role, "backup.restore");
    if (!ok) {
      throw new BackupRestoreError(
        "UNAUTHORIZED",
        PUBLIC_MESSAGE.UNAUTHORIZED,
        `actor=${opts.actor.id} role=${opts.actor.role} needs backup.restore`
      );
    }

    // ── 2. INPUT VALIDATION ─────────────────────────────────────────
    if (!CUID_RE.test(opts.backupId)) {
      throw new BackupRestoreError(
        "INVALID_INPUT",
        PUBLIC_MESSAGE.INVALID_INPUT,
        "backupId shape"
      );
    }
    if (typeof opts.confirmationPhrase !== "string" || opts.confirmationPhrase.length === 0) {
      throw new BackupRestoreError(
        "CONFIRMATION_INVALID",
        PUBLIC_MESSAGE.CONFIRMATION_INVALID,
        "empty phrase"
      );
    }
    if (typeof opts.adminPassword !== "string" || opts.adminPassword.length === 0) {
      throw new BackupRestoreError(
        "CONFIRMATION_INVALID",
        PUBLIC_MESSAGE.CONFIRMATION_INVALID,
        "empty password"
      );
    }

    // ── 3. LOAD ACTOR ROW (for password + role reverification) ──────
    const actorRow = await client.adminUser.findUnique({
      where: { id: opts.actor.id },
      select: { id: true, role: true, passwordHash: true, status: true }
    });
    if (!actorRow || actorRow.status !== "ACTIVE") {
      throw new BackupRestoreError(
        "UNAUTHORIZED",
        PUBLIC_MESSAGE.UNAUTHORIZED,
        "actor row missing or inactive"
      );
    }
    if (actorRow.role !== opts.actor.role) {
      // Session was minted under a different role — refuse; the caller
      // should re-authenticate.
      throw new BackupRestoreError(
        "UNAUTHORIZED",
        PUBLIC_MESSAGE.UNAUTHORIZED,
        "actor role drift"
      );
    }

    // ── 4 + 5. CONFIRMATION PHRASE + PASSWORD RE-AUTH ───────────────
    // Both checks run UNCONDITIONALLY. Combining them with a bitwise
    // constant-time AND at the end defeats a wall-clock timing side
    // channel that would otherwise let an attacker distinguish
    // "wrong phrase" (fast, no scrypt) from "wrong password" (slow,
    // scrypt-bound) — protecting the (already RBAC-gated) endpoint
    // from a phrase-enumeration oracle.
    const expectedPhrase = `RESTORE ${opts.backupId.slice(0, 8)}`;
    const phraseOk = timingSafeStringEquals(opts.confirmationPhrase, expectedPhrase);
    // ALWAYS run verifyPassword so scrypt cost is paid either way — this
    // is what defeats the timing side-channel. Once both bits are
    // computed, the final `&&` is nanoseconds vs the scrypt milliseconds
    // so its short-circuit does not leak information.
    const passwordOk = verifyPassword(opts.adminPassword, actorRow.passwordHash);
    if (!(phraseOk && passwordOk)) {
      throw new BackupRestoreError(
        "CONFIRMATION_INVALID",
        PUBLIC_MESSAGE.CONFIRMATION_INVALID,
        phraseOk ? "password mismatch" : "phrase mismatch"
      );
    }

    // ── 6. FORCE FLAG GATE ──────────────────────────────────────────
    if (opts.force === true && actorRow.role !== "SUPER_ADMIN") {
      throw new BackupRestoreError(
        "UNAUTHORIZED",
        PUBLIC_MESSAGE.UNAUTHORIZED,
        "force flag requires SUPER_ADMIN"
      );
    }

    // ── 7. CONCURRENCY GUARD (cheap, runs BEFORE expensive preflight) ─
    // Reject if any Backup is currently PENDING/RUNNING OR any
    // RestoreOperation is INITIATED/PREFLIGHT/RUNNING. Not race-proof
    // on its own — we re-check after inserting the RestoreOperation
    // row below. Order matters: this runs BEFORE the expensive verify
    // call so a concurrent restore does not force us to burn full
    // Phase-5 verification cycles before refusing.
    const inProgressBackup = await client.backup.findFirst({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true }
    });
    if (inProgressBackup) {
      throw new BackupRestoreError(
        "CONCURRENCY_CONFLICT",
        PUBLIC_MESSAGE.CONCURRENCY_CONFLICT,
        `blocking backup=${inProgressBackup.id}`
      );
    }
    const inProgressRestore = await client.restoreOperation.findFirst({
      where: { status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] } },
      select: { id: true }
    });
    if (inProgressRestore) {
      throw new BackupRestoreError(
        "CONCURRENCY_CONFLICT",
        PUBLIC_MESSAGE.CONCURRENCY_CONFLICT,
        `blocking restore=${inProgressRestore.id}`
      );
    }

    // ── 8. PREFLIGHT — verify source backup ─────────────────────────
    await audit({
      userId: opts.actor.id,
      action: "backup.restore.preflight",
      entity: "Backup",
      entityId: opts.backupId,
      meta: { operationId }
    });
    const verifyResult = await verifyBackup({
      backupId: opts.backupId,
      client,
      persist: false,
      compareDb: true
    });
    if (verifyResult.outcome !== "VERIFIED") {
      throw new BackupRestoreError(
        "VERIFICATION_FAILED",
        PUBLIC_MESSAGE.VERIFICATION_FAILED,
        `verify code=${verifyResult.code} stage=${verifyResult.stage}`
      );
    }
    if (verifyResult.schemaCompatible === false && opts.force !== true) {
      throw new BackupRestoreError(
        "SCHEMA_INCOMPATIBLE",
        PUBLIC_MESSAGE.SCHEMA_INCOMPATIBLE,
        "schemaSha256 mismatch, force not set"
      );
    }

    // ── 9. Create RestoreOperation row + race re-check ──────────────
    const op = await client.restoreOperation.create({
      data: {
        backupId: opts.backupId,
        initiatedById: opts.actor.id,
        status: "PREFLIGHT",
        meta: {
          operationId,
          force: opts.force === true,
          schemaCompatible: verifyResult.schemaCompatible
        }
      },
      select: { id: true }
    });
    restoreOperationId = op.id;
    const raceCheck = await client.restoreOperation.findFirst({
      where: {
        id: { not: op.id },
        status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] }
      },
      select: { id: true }
    });
    if (raceCheck) {
      // Lost the race — abort mine.
      await client.restoreOperation.update({
        where: { id: op.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage: "CONCURRENCY_CONFLICT"
        }
      });
      throw new BackupRestoreError(
        "CONCURRENCY_CONFLICT",
        PUBLIC_MESSAGE.CONCURRENCY_CONFLICT,
        `race lost to restoreOperation=${raceCheck.id}`
      );
    }

    // ── 10. SAFETY BACKUP ───────────────────────────────────────────
    await audit({
      userId: opts.actor.id,
      action: "backup.restore.safety.request",
      entity: "RestoreOperation",
      entityId: op.id,
      meta: { operationId }
    });
    let safetyDump;
    try {
      safetyDump = await runBackupDump({
        kind: "SAFETY",
        createdById: opts.actor.id,
        client
      });
    } catch (err) {
      await client.restoreOperation.update({
        where: { id: op.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage: "SAFETY_BACKUP_FAILED"
        }
      });
      throw new BackupRestoreError(
        "SAFETY_BACKUP_FAILED",
        PUBLIC_MESSAGE.SAFETY_BACKUP_FAILED,
        errorName(err)
      );
    }
    safetyBackupId = safetyDump.backupId;
    const safetyVerify = await verifyBackup({
      backupId: safetyDump.backupId,
      client,
      persist: true,
      verifiedById: opts.actor.id
    });
    if (safetyVerify.outcome !== "VERIFIED") {
      await client.restoreOperation.update({
        where: { id: op.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage: "SAFETY_BACKUP_FAILED"
        }
      });
      throw new BackupRestoreError(
        "SAFETY_BACKUP_FAILED",
        PUBLIC_MESSAGE.SAFETY_BACKUP_FAILED,
        `safety verify code=${safetyVerify.code}`
      );
    }
    await client.restoreOperation.update({
      where: { id: op.id },
      data: { safetyBackupId: safetyDump.backupId, status: "RUNNING" }
    });
    await audit({
      userId: opts.actor.id,
      action: "backup.restore.safety.success",
      entity: "RestoreOperation",
      entityId: op.id,
      meta: {
        operationId,
        safetyBackupId: safetyDump.backupId,
        safetyBackupSize: safetyDump.sizeBytes
      }
    });

    // ── 11. DECRYPT + PARSE (in-process, streaming) ─────────────────
    // We fully decode all rows BEFORE opening the destructive txn so
    // any decode error surfaces without leaving the DB half-wiped. The
    // NDJSON parser bounds line size and total row count.
    const grouped = await decryptAndDecode(client, opts.backupId, verifyResult.sizeBytes ?? 0);

    // ── 11b. ACTOR-IN-SOURCE guard ──────────────────────────────────
    // The RestoreOperation upsert inside the destructive txn references
    // `initiatedById = <current actor>` via an FK to AdminUser. If the
    // current actor's AdminUser row is NOT in the source backup (e.g.,
    // this admin was created AFTER the snapshot), the upsert would
    // fail FK and roll back the ENTIRE restore with a cryptic
    // APPLY_FAILED. Detect that up-front here — no destructive action
    // has occurred yet — and surface a specific actionable code.
    // Applies even under force=true: the operator would still lose
    // their own access, which is almost never intended.
    const adminUserRows = grouped.byModel.get("AdminUser") ?? [];
    const actorInSource = adminUserRows.some(
      (r) => typeof r.id === "string" && r.id === opts.actor.id
    );
    if (!actorInSource) {
      throw new BackupRestoreError(
        "ACTOR_NOT_IN_SOURCE",
        PUBLIC_MESSAGE.ACTOR_NOT_IN_SOURCE,
        `actor=${opts.actor.id} not in source AdminUser set`
      );
    }

    // ── 12. Snapshot audit-chain rows for post-restore preservation ─
    // The source Backup row + our RestoreOperation row + the safety
    // Backup row all get destroyed by the row wipe below; we upsert
    // them back afterward so the audit trail survives.
    const [sourceBackupRow, safetyBackupRow, restoreOpRow] = await Promise.all([
      client.backup.findUniqueOrThrow({ where: { id: opts.backupId } }),
      client.backup.findUniqueOrThrow({ where: { id: safetyDump.backupId } }),
      client.restoreOperation.findUniqueOrThrow({ where: { id: op.id } })
    ]);
    const preservedRestoreOp = { ...restoreOpRow };
    const preservedSafety = { ...safetyBackupRow };
    const preservedSource = { ...sourceBackupRow };

    // ── 13. DESTRUCTIVE APPLY ───────────────────────────────────────
    await audit({
      userId: opts.actor.id,
      action: "backup.restore.apply.request",
      entity: "RestoreOperation",
      entityId: op.id,
      meta: {
        operationId,
        sourceBackupId: opts.backupId,
        safetyBackupId: safetyDump.backupId,
        totalRows: grouped.totalRows
      }
    });

    try {
      await client.$transaction(
        async (tx) => {
          await applyRestoreDestructively(tx, grouped, {
            preservedSource,
            preservedSafety,
            preservedRestoreOp
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: loadRestoreTimeoutMs(),
          maxWait: 5_000
        }
      );
    } catch (err) {
      await client.restoreOperation
        .update({
          where: { id: op.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            errorMessage: "APPLY_FAILED"
          }
        })
        .catch(() => undefined);
      throw new BackupRestoreError(
        "APPLY_FAILED",
        PUBLIC_MESSAGE.APPLY_FAILED,
        errorName(err)
      );
    }

    // ── 14. POST-RESTORE VERIFICATION ───────────────────────────────
    const postVerify = await postRestoreVerify(client, grouped);
    if (!postVerify.ok) {
      await client.restoreOperation
        .update({
          where: { id: op.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            errorMessage: `POST_RESTORE_VERIFY_FAILED:${postVerify.reason}`
          }
        })
        .catch(() => undefined);
      // NOTE: we do NOT auto-rollback to the safety backup. The
      // operator will trigger a follow-up restore explicitly (see the
      // review doc). Auto-rollback risks compounding damage if the
      // safety backup itself has drifted or the DB is in a partially
      // inconsistent state.
      throw new BackupRestoreError(
        "POST_RESTORE_VERIFY_FAILED",
        PUBLIC_MESSAGE.POST_RESTORE_VERIFY_FAILED,
        postVerify.reason
      );
    }

    // ── 15. SESSION INVALIDATION ────────────────────────────────────
    // Session tables are handled INSIDE the destructive txn via
    // RESTORE_SKIP_MODELS: they are wiped by DROP_ORDER and never
    // re-inserted, so session-invalidation is atomic with the restore
    // (no window where source-time session cookies are live). No
    // separate post-commit deleteMany needed.

    // ── 16. MARK COMPLETED ──────────────────────────────────────────
    await client.restoreOperation.update({
      where: { id: op.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date()
      }
    });
    await audit({
      userId: opts.actor.id,
      action: "backup.restore.success",
      entity: "RestoreOperation",
      entityId: op.id,
      meta: {
        operationId,
        sourceBackupId: opts.backupId,
        safetyBackupId: safetyDump.backupId,
        totalRows: grouped.totalRows,
        forced: opts.force === true
      }
    });

    return {
      ok: true,
      code: "OK",
      restoreOperationId: op.id,
      safetyBackupId: safetyDump.backupId,
      publicMessage: PUBLIC_MESSAGE.OK,
      operationId,
      durationMs: Date.now() - start
    };
  } catch (err) {
    return await finalizeFailure({
      err,
      operationId,
      start,
      actorId: opts.actor.id,
      restoreOperationId,
      safetyBackupId,
      client
    });
  }
}

// ─── Destructive apply ──────────────────────────────────────────────────────

interface DecodedGroups {
  byModel: Map<BackupModelName, Array<Record<string, unknown>>>;
  totalRows: number;
  rowCountsFromManifest: Record<string, number>;
}

interface Preserved {
  preservedSource: Awaited<ReturnType<PrismaClient["backup"]["findUniqueOrThrow"]>>;
  preservedSafety: Awaited<ReturnType<PrismaClient["backup"]["findUniqueOrThrow"]>>;
  preservedRestoreOp: Awaited<
    ReturnType<PrismaClient["restoreOperation"]["findUniqueOrThrow"]>
  >;
}

/**
 * Run the destructive apply inside an interactive transaction:
 *   1. DELETE all rows in DROP_ORDER
 *   2. INSERT rows per model in MODEL_ORDER (batched createMany)
 *      • Two-pass for BadgeCredential (self-relation): pass 1 inserts
 *        with rotatedFromId=null, pass 2 restores it via bulk UPDATE.
 *   3. Upsert the preserved audit-chain rows so the operation is
 *      visible after the wipe.
 *
 * On any exception, the interactive transaction rolls back — the DB
 * is left EXACTLY as it was before this function was invoked. The
 * caller marks RestoreOperation FAILED.
 */
async function applyRestoreDestructively(
  tx: Prisma.TransactionClient,
  grouped: DecodedGroups,
  preserved: Preserved
): Promise<void> {
  // ── Wipe ────────────────────────────────────────────────────────────
  // DELETE FROM per model in DROP_ORDER (reverse of MODEL_ORDER). Explicit
  // and safe — TRUNCATE CASCADE would silently touch tables outside our
  // list. We rely on Prisma's model → underlying table mapping via the
  // delegate; the actual SQL is DELETE.
  for (const model of DROP_ORDER) {
    // deleteMany() with no where deletes all rows.
    const delegate = tableDelegate(tx, model);
    await delegate.deleteMany({});
  }

  // ── Insert ──────────────────────────────────────────────────────────
  // Two-pass for BadgeCredential. Remember the (id, rotatedFromId) pairs
  // for any row with a non-null self-reference.
  const rotatedFromMap = new Map<string, string>();

  for (const model of MODEL_ORDER) {
    const rows = grouped.byModel.get(model) ?? [];
    if (rows.length === 0) continue;

    // Skip session tables — see RESTORE_SKIP_MODELS docstring.
    if (RESTORE_SKIP_MODELS.has(model)) continue;

    if (model === "BadgeCredential") {
      // Strip rotatedFromId on the first pass. Remember the originals.
      const stripped: Array<Record<string, unknown>> = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const original = rows[i];
        const id = original.id;
        const rotatedFromId = original.rotatedFromId;
        if (typeof id === "string" && typeof rotatedFromId === "string") {
          rotatedFromMap.set(id, rotatedFromId);
        }
        stripped[i] = { ...original, rotatedFromId: null };
      }
      await createManyBatched(tx, model, stripped);
      continue;
    }

    await createManyBatched(tx, model, rows);
  }

  // ── Two-pass BadgeCredential UPDATE ─────────────────────────────────
  if (rotatedFromMap.size > 0) {
    // Sanity: chain heads (id points at itself or missing) — skip.
    for (const [id, rotatedFromId] of rotatedFromMap) {
      if (id === rotatedFromId) continue;
      await tx.badgeCredential.update({
        where: { id },
        data: { rotatedFromId }
      });
    }
  }

  // ── Preserve audit chain across the wipe ────────────────────────────
  // The source Backup row was in the NDJSON (usually with its dump-time
  // status = RUNNING). Overwrite with its CURRENT authoritative state so
  // downstream operations don't see a stale RUNNING row.
  await tx.backup.upsert({
    where: { id: preserved.preservedSource.id },
    create: preservedBackupToCreate(preserved.preservedSource),
    update: preservedBackupToUpdate(preserved.preservedSource)
  });
  // The safety Backup row DID NOT exist at source-dump time, so it is
  // NOT in the NDJSON. Insert it fresh.
  await tx.backup.upsert({
    where: { id: preserved.preservedSafety.id },
    create: preservedBackupToCreate(preserved.preservedSafety),
    update: preservedBackupToUpdate(preserved.preservedSafety)
  });
  // Upsert our RestoreOperation with the CURRENT state (RUNNING) so the
  // audit chain is visible from the moment the tx commits.
  await tx.restoreOperation.upsert({
    where: { id: preserved.preservedRestoreOp.id },
    create: preservedRestoreOpToCreate(preserved.preservedRestoreOp),
    update: preservedRestoreOpToUpdate(preserved.preservedRestoreOp)
  });
}

function preservedBackupToCreate(
  row: Awaited<ReturnType<PrismaClient["backup"]["findUniqueOrThrow"]>>
): Prisma.BackupUncheckedCreateInput {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    sizeBytes: row.sizeBytes,
    fileName: row.fileName,
    contentSha256: row.contentSha256,
    manifestSha256: row.manifestSha256,
    schemaSha256: row.schemaSha256,
    appVersion: row.appVersion,
    formatVersion: row.formatVersion,
    encryptionVersion: row.encryptionVersion,
    rowCounts: (row.rowCounts as Prisma.InputJsonValue) ?? Prisma.JsonNull,
    errorMessage: row.errorMessage,
    createdById: row.createdById,
    verifiedAt: row.verifiedAt,
    verifiedById: row.verifiedById,
    verifyResult: row.verifyResult
  };
}
function preservedBackupToUpdate(
  row: Awaited<ReturnType<PrismaClient["backup"]["findUniqueOrThrow"]>>
): Prisma.BackupUpdateInput {
  return {
    status: row.status,
    kind: row.kind,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    sizeBytes: row.sizeBytes,
    fileName: row.fileName,
    contentSha256: row.contentSha256,
    manifestSha256: row.manifestSha256,
    schemaSha256: row.schemaSha256,
    appVersion: row.appVersion,
    formatVersion: row.formatVersion,
    encryptionVersion: row.encryptionVersion,
    rowCounts: (row.rowCounts as Prisma.InputJsonValue) ?? Prisma.JsonNull,
    errorMessage: row.errorMessage,
    verifiedAt: row.verifiedAt,
    verifyResult: row.verifyResult
  };
}
function preservedRestoreOpToCreate(
  row: Awaited<ReturnType<PrismaClient["restoreOperation"]["findUniqueOrThrow"]>>
): Prisma.RestoreOperationUncheckedCreateInput {
  return {
    id: row.id,
    backupId: row.backupId,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    initiatedById: row.initiatedById,
    safetyBackupId: row.safetyBackupId,
    errorMessage: row.errorMessage,
    meta: (row.meta as Prisma.InputJsonValue) ?? Prisma.JsonNull
  };
}
function preservedRestoreOpToUpdate(
  row: Awaited<ReturnType<PrismaClient["restoreOperation"]["findUniqueOrThrow"]>>
): Prisma.RestoreOperationUncheckedUpdateInput {
  return {
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    // safetyBackupId is a direct scalar on the Unchecked variant — the
    // checked variant would require the nested `safetyBackup: { connect }`
    // syntax and refuse null. We already know the safetyBackupId is
    // either the just-created safety row (which we upsert directly
    // above) or null.
    safetyBackupId: row.safetyBackupId,
    errorMessage: row.errorMessage,
    meta: (row.meta as Prisma.InputJsonValue) ?? Prisma.JsonNull
  };
}

interface AnyDelegate {
  deleteMany(args?: { where?: unknown }): Promise<{ count: number }>;
  createMany(args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }): Promise<{ count: number }>;
  count(args?: { where?: unknown }): Promise<number>;
}

/**
 * Fetch a Prisma delegate by pascal-cased model name (camelCased for
 * client access). Same shape as model-order.ts's helper but typed for
 * the restore-side operations (deleteMany, createMany, count).
 */
function tableDelegate(
  client: Prisma.TransactionClient | PrismaClient,
  model: BackupModelName
): AnyDelegate {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const delegate = (client as unknown as Record<string, unknown>)[key];
  if (!delegate) {
    throw new Error(`No Prisma delegate for model "${model}" (property "${key}")`);
  }
  return delegate as AnyDelegate;
}

const BATCH_SIZE = 500;

async function createManyBatched(
  tx: Prisma.TransactionClient,
  model: BackupModelName,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const delegate = tableDelegate(tx, model);
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await delegate.createMany({ data: chunk, skipDuplicates: false });
  }
}

// ─── Streaming decrypt + decode ─────────────────────────────────────────────

async function decryptAndDecode(
  client: PrismaClient,
  backupId: string,
  expectedSize: number
): Promise<DecodedGroups> {
  assertValidBackupId(backupId);
  if (!(await publishedBackupExists(backupId))) {
    throw new BackupRestoreError(
      "STORAGE_UNAVAILABLE",
      PUBLIC_MESSAGE.STORAGE_UNAVAILABLE,
      "bin file missing"
    );
  }

  // We re-read the manifest to obtain contentSha256 / rowCounts / IV+tag
  // boundaries. Verify was already run; this is a bounded re-read.
  let subkeys;
  try {
    subkeys = loadBackupSubkeys();
  } catch (err) {
    if (err instanceof BackupCryptoConfigError) {
      throw new BackupRestoreError(
        "CRYPTO_UNAVAILABLE",
        PUBLIC_MESSAGE.CRYPTO_UNAVAILABLE
      );
    }
    throw err;
  }

  try {
    const stat = await statPublishedBackup(backupId);
    if (expectedSize && stat.binSize !== expectedSize) {
      throw new BackupRestoreError(
        "STORAGE_UNAVAILABLE",
        PUBLIC_MESSAGE.STORAGE_UNAVAILABLE,
        "size drift since verify"
      );
    }
    if (stat.binSize < IV_BYTES + TAG_BYTES) {
      throw new BackupRestoreError(
        "STORAGE_UNAVAILABLE",
        PUBLIC_MESSAGE.STORAGE_UNAVAILABLE,
        "bin envelope too small"
      );
    }

    // Read manifest bytes (already-verified in preflight) to get
    // rowCounts and confirm identity a second time.
    const manifestBytes = await client.$queryRaw`SELECT 1`.then(async () => {
      // Trivial no-op await to keep transaction adjacency clean — the
      // actual read is via the storage helper.
      const { readPublishedManifest } = await import("./storage");
      return readPublishedManifest(backupId);
    });
    let manifest;
    try {
      manifest = parseAndVerifyManifest(subkeys.hmacKey, manifestBytes);
    } catch (err) {
      if (err instanceof ManifestParseError || err instanceof ManifestHmacError) {
        throw new BackupRestoreError(
          "VERIFICATION_FAILED",
          PUBLIC_MESSAGE.VERIFICATION_FAILED,
          "manifest failed re-read"
        );
      }
      throw err;
    }
    if (manifest.backupId !== backupId) {
      throw new BackupRestoreError(
        "VERIFICATION_FAILED",
        PUBLIC_MESSAGE.VERIFICATION_FAILED,
        "manifest backupId drift"
      );
    }

    // Read IV and tag via bounded range reads.
    const ivChunks: Buffer[] = [];
    await pipeline(
      openPublishedReadStream(backupId, { start: 0, end: IV_BYTES - 1 }),
      new Writable({
        write(c: Buffer, _e, cb) {
          ivChunks.push(c);
          cb();
        }
      })
    );
    const iv = Buffer.concat(ivChunks);

    const tagChunks: Buffer[] = [];
    await pipeline(
      openPublishedReadStream(backupId, {
        start: stat.binSize - TAG_BYTES,
        end: stat.binSize - 1
      }),
      new Writable({
        write(c: Buffer, _e, cb) {
          tagChunks.push(c);
          cb();
        }
      })
    );
    const tag = Buffer.concat(tagChunks);

    const decrypt = createBackupDecryptStream(subkeys.encKey, iv, tag);
    const parser = new RestoreParser({
      expectedBackupId: manifest.backupId,
      expectedSchemaSha256: manifest.schemaSha256,
      expectedRowCounts: manifest.rowCounts
    });

    await pipeline(
      openPublishedReadStream(backupId, {
        start: IV_BYTES,
        end: stat.binSize - TAG_BYTES - 1
      }),
      decrypt.transform,
      parser
    );

    return parser.result();
  } catch (err) {
    if (err instanceof BackupRestoreError) throw err;
    if (err instanceof BackupStorageError) {
      throw new BackupRestoreError(
        "STORAGE_UNAVAILABLE",
        PUBLIC_MESSAGE.STORAGE_UNAVAILABLE,
        "storage refused"
      );
    }
    throw new BackupRestoreError(
      "APPLY_FAILED",
      PUBLIC_MESSAGE.APPLY_FAILED,
      errorName(err)
    );
  } finally {
    wipeSubkeys(subkeys);
  }
}

/**
 * NDJSON parser + decoder for restore. Mirrors verify's parser but
 * COLLECTS decoded rows per model instead of just counting them. The
 * caller feeds decrypted bytes; the parser holds each line under
 * MAX_NDJSON_LINE_BYTES and refuses records outside MODEL_ORDER.
 *
 * Every row's data is fed through `decodeRow` (from serializer.ts) —
 * a value that cannot decode is a restore-critical defect (it would
 * fail a downstream Prisma insert anyway) and is rejected up-front.
 */
class RestoreParser extends Writable {
  private buf = Buffer.alloc(0);
  private state: "AWAIT_META" | "IN_BODY" | "AFTER_END" = "AWAIT_META";
  private meta: unknown = null;
  private endRec: unknown = null;
  private grouped = new Map<BackupModelName, Array<Record<string, unknown>>>();
  private totalRows = 0;
  private readonly opts: {
    expectedBackupId: string;
    expectedSchemaSha256: string;
    expectedRowCounts: Record<string, number>;
  };

  constructor(opts: {
    expectedBackupId: string;
    expectedSchemaSha256: string;
    expectedRowCounts: Record<string, number>;
  }) {
    super();
    this.opts = opts;
    for (const m of MODEL_ORDER) this.grouped.set(m, []);
  }

  override _write(chunk: Buffer, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      const combined = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.buf = Buffer.alloc(0);
      let cursor = 0;
      while (cursor < combined.length) {
        const nl = combined.indexOf(NEWLINE, cursor);
        if (nl === -1) {
          const remainder = combined.subarray(cursor);
          if (remainder.length > MAX_NDJSON_LINE_BYTES) {
            throw new BackupRestoreError(
              "APPLY_FAILED",
              PUBLIC_MESSAGE.APPLY_FAILED,
              "NDJSON line exceeds cap"
            );
          }
          this.buf = Buffer.from(remainder);
          break;
        }
        const line = combined.subarray(cursor, nl);
        if (line.length > MAX_NDJSON_LINE_BYTES) {
          throw new BackupRestoreError(
            "APPLY_FAILED",
            PUBLIC_MESSAGE.APPLY_FAILED,
            "NDJSON line exceeds cap"
          );
        }
        this.processLine(line);
        cursor = nl + 1;
      }
      cb();
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _final(cb: (err?: Error | null) => void): void {
    try {
      if (this.buf.length > 0) {
        this.processLine(this.buf);
        this.buf = Buffer.alloc(0);
      }
      if (this.state !== "AFTER_END") {
        throw new BackupRestoreError(
          "APPLY_FAILED",
          PUBLIC_MESSAGE.APPLY_FAILED,
          "missing __end"
        );
      }
      cb();
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private processLine(bytes: Buffer): void {
    if (bytes.length === 0) {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "empty NDJSON line");
    }
    let obj: unknown;
    try {
      obj = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "invalid JSON in NDJSON");
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "NDJSON record must be object");
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length !== 1) {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "NDJSON record must have one key");
    }
    const kind = keys[0];

    if (this.state === "AWAIT_META") {
      if (kind !== "__meta") {
        throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "first NDJSON must be __meta");
      }
      this.validateMeta(rec.__meta);
      this.meta = rec.__meta;
      this.state = "IN_BODY";
      return;
    }
    if (this.state === "AFTER_END") {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "record after __end");
    }
    if (kind === "__row") {
      this.processRow(rec.__row);
      return;
    }
    if (kind === "__end") {
      this.endRec = rec.__end;
      this.state = "AFTER_END";
      return;
    }
    throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "unknown NDJSON record kind");
  }

  private validateMeta(m: unknown): void {
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "__meta not object");
    }
    const meta = m as Record<string, unknown>;
    if (meta.backupId !== this.opts.expectedBackupId) {
      throw new BackupRestoreError(
        "APPLY_FAILED",
        PUBLIC_MESSAGE.APPLY_FAILED,
        "__meta.backupId differs from manifest"
      );
    }
    if (meta.schemaSha256 !== this.opts.expectedSchemaSha256) {
      throw new BackupRestoreError(
        "APPLY_FAILED",
        PUBLIC_MESSAGE.APPLY_FAILED,
        "__meta.schemaSha256 differs from manifest"
      );
    }
  }

  private processRow(row: unknown): void {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "__row must be object");
    }
    const r = row as { model?: unknown; data?: unknown };
    if (typeof r.model !== "string") {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "__row.model missing");
    }
    if (!MODEL_SET.has(r.model)) {
      throw new BackupRestoreError(
        "APPLY_FAILED",
        PUBLIC_MESSAGE.APPLY_FAILED,
        "unknown model in __row (rejected)"
      );
    }
    if (typeof r.data !== "object" || r.data === null || Array.isArray(r.data)) {
      throw new BackupRestoreError("APPLY_FAILED", PUBLIC_MESSAGE.APPLY_FAILED, "__row.data must be object");
    }
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeRow(r.data);
    } catch (err) {
      if (err instanceof BackupSerializerError) {
        throw new BackupRestoreError(
          "APPLY_FAILED",
          PUBLIC_MESSAGE.APPLY_FAILED,
          "serializer decode failed"
        );
      }
      throw err;
    }
    const bucket = this.grouped.get(r.model as BackupModelName);
    if (!bucket) {
      throw new BackupRestoreError(
        "APPLY_FAILED",
        PUBLIC_MESSAGE.APPLY_FAILED,
        "no bucket for known model — internal invariant"
      );
    }
    bucket.push(decoded);
    this.totalRows += 1;
    if (this.totalRows > MAX_TOTAL_ROWS) {
      throw new BackupRestoreError(
        "APPLY_FAILED",
        PUBLIC_MESSAGE.APPLY_FAILED,
        "row count exceeds cap"
      );
    }
  }

  result(): DecodedGroups {
    return {
      byModel: this.grouped,
      totalRows: this.totalRows,
      rowCountsFromManifest: this.opts.expectedRowCounts
    };
  }
}

// ─── Post-restore verification ──────────────────────────────────────────────

async function postRestoreVerify(
  client: PrismaClient,
  grouped: DecodedGroups
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Compare per-model row count to the source manifest.
  // NOTE: rows we inserted include the source backup NDJSON's row set
  // PLUS one upsert each for the source Backup + safety Backup +
  // RestoreOperation. So the DB row count for Backup and RestoreOperation
  // may exceed the NDJSON row count by up to +1 (safety Backup did not
  // exist at source-dump time). We compare with a tolerance for those
  // two tables.
  for (const model of MODEL_ORDER) {
    const delegate = tableDelegate(client, model);
    const actualCount = await delegate.count();
    const expected = grouped.rowCountsFromManifest[model] ?? 0;

    // Session tables were intentionally NOT re-inserted (see
    // RESTORE_SKIP_MODELS at the top of this file). Post-restore they
    // must be empty regardless of what the manifest recorded.
    if (RESTORE_SKIP_MODELS.has(model)) {
      if (actualCount !== 0) {
        return {
          ok: false,
          reason: `${model}:not-empty-after-skip(${actualCount})`
        };
      }
      continue;
    }

    // Backup and RestoreOperation tables gain up to +2 rows from the
    // audit-chain preservation upserts (source Backup + safety Backup
    // + this RestoreOperation) not present in the source snapshot.
    const tolerance =
      model === "Backup" || model === "RestoreOperation" ? 2 : 0;
    if (actualCount < expected || actualCount > expected + tolerance) {
      return {
        ok: false,
        reason: `${model}:${actualCount}!=${expected}`
      };
    }
  }
  return { ok: true };
}

// ─── Small helpers ──────────────────────────────────────────────────────────

async function finalizeFailure(input: {
  err: unknown;
  operationId: string;
  start: number;
  actorId: string;
  restoreOperationId?: string;
  safetyBackupId?: string;
  client?: PrismaClient;
}): Promise<RestoreResult> {
  let code: RestoreFailureCode;
  let publicMessage: string;
  let internal: string | undefined;

  if (input.err instanceof BackupRestoreError) {
    code = input.err.code;
    publicMessage = input.err.publicMessage;
    internal = input.err.internal;
  } else if (input.err instanceof BackupServiceError) {
    code = "UNAUTHORIZED"; // mapped from service authz layers
    publicMessage = PUBLIC_MESSAGE.UNAUTHORIZED;
    internal = input.err.internal;
  } else {
    code = "INTERNAL";
    publicMessage = PUBLIC_MESSAGE.INTERNAL;
    internal = input.err instanceof Error ? input.err.name : "unknown";
  }

  // Ensure the RestoreOperation row (if any) transitions to a terminal
  // state. Any error surfaced by ACTOR_NOT_IN_SOURCE, APPLY_FAILED,
  // POST_RESTORE_VERIFY_FAILED, or an INTERNAL bubble reaches here after
  // the row was already inserted at PREFLIGHT/RUNNING. Leaving it
  // non-terminal would block every subsequent restore via the
  // concurrency guard — a self-inflicted denial of service.
  if (input.restoreOperationId && input.client) {
    await input.client.restoreOperation
      .updateMany({
        where: {
          id: input.restoreOperationId,
          status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] }
        },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage: code
        }
      })
      .catch(() => undefined);
  }

  await audit({
    userId: input.actorId,
    action: "backup.restore.failure",
    entity: "RestoreOperation",
    entityId: input.restoreOperationId,
    meta: {
      operationId: input.operationId,
      errorCode: code,
      errorClass: input.err instanceof Error ? input.err.name : "primitive",
      internalHint: internal,
      safetyBackupId: input.safetyBackupId
    }
  }).catch(() => undefined);

  return {
    ok: false,
    code,
    restoreOperationId: input.restoreOperationId,
    safetyBackupId: input.safetyBackupId,
    publicMessage,
    operationId: input.operationId,
    durationMs: Date.now() - input.start
  };
}

function randomUuid(): string {
  return randomUUID();
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return "unknown";
}

import "server-only";

// Layer P.2 — Google Drive replication service layer.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §P.2 + §P.3.
//
// This is the ONE server-side surface through which admin server actions
// invoke replication mutations. Every function:
//
//   1. Re-checks the required permission (defence in depth over the
//      server-action-layer `requirePermission` redirect).
//   2. Refuses if `GOOGLE_DRIVE_BACKUP_ENABLED != "true"` OR the config
//      status is not fully OK (§Q.3 fail-closed).
//   3. Validates every input via Zod / assertSafeId.
//   4. Delegates to the existing Layer G / H / I / J services — never
//      re-implements their state machine.
//   5. Emits sanitized audit events (§P.3) on success AND failure.
//   6. Returns a discriminated `ServiceResult` — never a raw exception.
//
// SECURITY INVARIANTS PRESERVED (Layers L / M / R):
//   * Backup.status is never written by any code path in this file (or
//     anything under lib/backup/replication/ per §M.2).
//   * Drive I/O never runs inside a Prisma transaction.
//   * OAuth access token / refresh token / session URI never appear in
//     an audit row, service result, or thrown Error.
//   * The two-key restore gate (`backup.replication.restore` AND
//     `backup.restore`) is enforced by the CALLER — this module trusts
//     that the server action performed both `requireReplicationPermission`
//     calls before invoking `restoreFromDriveService`. The service also
//     re-checks BOTH permissions defensively.
//   * The existing Phase 7 `runRestore` is the sole destructive engine —
//     `restoreFromDriveService` never invents a second destructive path.

import { randomUUID } from "crypto";
import { AdminRole } from "@prisma/client";
import { z } from "zod";

import path from "node:path";
import { promises as fs } from "node:fs";

import { prisma } from "@/lib/db";
import { canWithOverrides, type Permission } from "@/lib/admin/rbac";
import { audit } from "@/lib/admin/audit";
import { loadBackupStorageDir } from "@/lib/backup/config";

import {
  assertGoogleDriveEnabled,
  googleDriveConfigStatus,
  isGoogleDriveConfigReady,
  loadGoogleDriveConfig,
  GoogleDriveConfigError
} from "./config";
import {
  getGoogleDriveAccessToken,
  getGoogleDriveClient,
  getResolvedGoogleDriveHttpTimeoutMs
} from "./drive-client";
import { resolveGoogleDriveFolder } from "./folder";
import { defaultHttpClient } from "./http";
import {
  reconcileReplicationRemote,
  type ReconcileReplicationDeps
} from "./reconcile";
import {
  verifyRemoteFullSha256,
  verifyRemoteMetadata,
  type VerifyRemoteDeps,
  type VerifyRemoteResult
} from "./verify-remote";
import {
  downloadAndVerifyDriveBackup,
  type RemoteRestoreDeps,
  type RemoteRestoreOutcome
} from "./restore-remote";
import { REPLICATION_DESTINATION } from "./uploader";
import { GoogleDriveOperationError } from "./errors";
import { classifyGoogleError } from "./classifier";

// ─── Public types ─────────────────────────────────────────────────────────

export interface Actor {
  id: string;
  role: AdminRole;
}

/**
 * Public error codes surfaced by this module. Mirrors the taxonomy of
 * `lib/backup/service.ts` so the admin UI's inline error rendering
 * treats replication failures identically to plain backup failures.
 */
export type ReplicationServiceErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "STATE_CONFLICT"
  | "CONFIGURATION_ERROR"
  | "REPLICATION_ERROR"
  | "CONFIRMATION_INVALID"
  | "INTERNAL";

export type ReplicationServiceResult<T> =
  | ({ ok: true; operationId: string } & T)
  | {
      ok: false;
      code: ReplicationServiceErrorCode;
      publicMessage: string;
      operationId: string;
    };

class ReplicationServiceError extends Error {
  constructor(
    public readonly code: ReplicationServiceErrorCode,
    public readonly publicMessage: string,
    public readonly internal?: string
  ) {
    super(`${code}: ${publicMessage}`);
    this.name = "ReplicationServiceError";
  }
}

const PUBLIC_MESSAGE: Record<ReplicationServiceErrorCode, string> = {
  UNAUTHORIZED: "Permission refusée.",
  INVALID_INPUT: "Entrée invalide.",
  NOT_FOUND: "Réplication introuvable pour cette sauvegarde.",
  STATE_CONFLICT:
    "Cette opération est incompatible avec l’état actuel de la réplication.",
  CONFIGURATION_ERROR:
    "Configuration Google Drive incomplète — action refusée.",
  REPLICATION_ERROR: "L’opération distante a échoué.",
  CONFIRMATION_INVALID: "Confirmation ou mot de passe invalide.",
  INTERNAL: "Erreur interne — voir les logs pour l’operationId indiqué."
};

// ─── Validation ───────────────────────────────────────────────────────────

const CUID_RE = /^c[a-z0-9]{24}$/;
const backupIdSchema = z.string().regex(CUID_RE, "invalid cuid");
const verifyLevelSchema = z.enum(["METADATA", "FULL_SHA256"]);

// The confirmation phrase is checked exactly by `runRestore`; we only
// enforce shape here so the destructive engine gets a well-formed
// string. Same length ceiling as the backup restore action.
const restoreInputSchema = z.object({
  backupId: backupIdSchema,
  confirmationPhrase: z.string().min(1).max(200),
  adminPassword: z.string().min(1).max(1024)
});

// ─── Permission helper ─────────────────────────────────────────────────────

type ReplicationPermission = Extract<Permission, `backup.replication.${string}`>;

/**
 * Assert the actor has `perm`. On failure throws a sanitized
 * `ReplicationServiceError("UNAUTHORIZED")`. The caller's `try/catch`
 * (in `runOrCatch`) records a `.denied` audit event.
 *
 * Uses `canWithOverrides` so RolePermissionOverride rows are respected.
 */
async function assertReplicationPermission(
  actor: Actor,
  perm: ReplicationPermission | "backup.restore"
): Promise<void> {
  const ok = await canWithOverrides(actor.role, perm);
  if (!ok) {
    throw new ReplicationServiceError(
      "UNAUTHORIZED",
      PUBLIC_MESSAGE.UNAUTHORIZED,
      `actor=${actor.id} role=${actor.role} needed=${perm}`
    );
  }
}

// ─── Fail-closed configuration gate (§Q.3) ────────────────────────────────

/**
 * Refuse every mutating action when the Drive subsystem is not
 * runnable. Encapsulates the plan's §Q.3 fail-closed rule at the
 * service boundary so every action's precondition path is identical.
 *
 * Never mentions any env value or credential — only categorical labels.
 */
async function assertDriveReady(): Promise<void> {
  try {
    assertGoogleDriveEnabled();
  } catch (err) {
    if (err instanceof GoogleDriveConfigError) {
      throw new ReplicationServiceError(
        "CONFIGURATION_ERROR",
        PUBLIC_MESSAGE.CONFIGURATION_ERROR,
        `flag=${err.code}`
      );
    }
    throw err;
  }
  const status = await googleDriveConfigStatus();
  if (!isGoogleDriveConfigReady(status)) {
    throw new ReplicationServiceError(
      "CONFIGURATION_ERROR",
      PUBLIC_MESSAGE.CONFIGURATION_ERROR,
      `flag=${status.flag} credentials=${status.credentials} folder=${status.folder}`
    );
  }
}

// ─── Retry ─────────────────────────────────────────────────────────────────

/**
 * Reset a FAILED or RETRYABLE_FAILURE replication row to PENDING so the
 * next worker tick re-attempts. NEVER touches Backup.status. NEVER makes
 * a Drive call. Idempotent for rows already in PENDING.
 *
 * State transitions permitted:
 *   FAILED             → PENDING (attemptCount RESET to 0 so backoff
 *                        cap does not immediately re-fire on the first
 *                        post-manual-retry attempt).
 *   RETRYABLE_FAILURE  → PENDING (attemptCount preserved — the row was
 *                        already going to retry automatically; the
 *                        admin action just fast-forwards past the
 *                        scheduled `nextRetryAt`).
 * Any other status is a STATE_CONFLICT (COMPLETED, UPLOADING, VERIFYING,
 * PENDING already).
 */
export async function retryReplicationService(input: {
  actor: Actor;
  backupId: string;
}): Promise<
  ReplicationServiceResult<{
    backupId: string;
    previousStatus: string;
    nextStatus: "PENDING";
  }>
> {
  const operationId = randomUUID();
  return runOrCatch(operationId, input.actor.id, "backup.replication.retry", async () => {
    await assertReplicationPermission(input.actor, "backup.replication.retry");
    const parsed = backupIdSchema.safeParse(input.backupId);
    if (!parsed.success) {
      throw new ReplicationServiceError(
        "INVALID_INPUT",
        PUBLIC_MESSAGE.INVALID_INPUT,
        parsed.error.message
      );
    }
    const backupId = parsed.data;
    await assertDriveReady();

    const rep = await prisma.backupReplication.findUnique({
      where: {
        backupId_destination: {
          backupId,
          destination: REPLICATION_DESTINATION
        }
      },
      select: { id: true, status: true, attemptCount: true }
    });
    if (rep === null) {
      throw new ReplicationServiceError("NOT_FOUND", PUBLIC_MESSAGE.NOT_FOUND);
    }
    if (
      rep.status !== "FAILED" &&
      rep.status !== "RETRYABLE_FAILURE"
    ) {
      throw new ReplicationServiceError(
        "STATE_CONFLICT",
        PUBLIC_MESSAGE.STATE_CONFLICT,
        `status=${rep.status}`
      );
    }

    // Reset FAILED's attempt count so the backoff cap does not
    // immediately re-fire. RETRYABLE_FAILURE preserves attemptCount
    // (the row was already re-attempting).
    const attemptResetTo =
      rep.status === "FAILED" ? 0 : rep.attemptCount;
    await prisma.backupReplication.update({
      where: { id: rep.id },
      data: {
        status: "PENDING",
        attemptCount: attemptResetTo,
        errorCode: "NONE",
        errorMessage: null,
        nextRetryAt: null
      }
    });

    await audit({
      userId: input.actor.id,
      action: "backup.replication.retry",
      entity: "BackupReplication",
      entityId: rep.id,
      meta: {
        operationId,
        backupId,
        previousStatus: rep.status,
        nextStatus: "PENDING",
        previousAttemptCount: rep.attemptCount,
        nextAttemptCount: attemptResetTo,
        actorRole: input.actor.role
      }
    });

    return {
      backupId,
      previousStatus: rep.status,
      nextStatus: "PENDING" as const
    };
  });
}

// ─── Verify ────────────────────────────────────────────────────────────────

export async function verifyRemoteService(input: {
  actor: Actor;
  backupId: string;
  level: "METADATA" | "FULL_SHA256";
}): Promise<
  ReplicationServiceResult<{
    backupId: string;
    level: "METADATA_ONLY" | "FULL_SHA256";
    outcome: VerifyRemoteResult["outcome"];
    errorCode?: string;
  }>
> {
  const operationId = randomUUID();
  return runOrCatch(
    operationId,
    input.actor.id,
    "backup.replication.verify",
    async () => {
      await assertReplicationPermission(input.actor, "backup.replication.verify");
      const parsedId = backupIdSchema.safeParse(input.backupId);
      const parsedLvl = verifyLevelSchema.safeParse(input.level);
      if (!parsedId.success || !parsedLvl.success) {
        throw new ReplicationServiceError(
          "INVALID_INPUT",
          PUBLIC_MESSAGE.INVALID_INPUT,
          parsedId.success ? parsedLvl.error!.message : parsedId.error!.message
        );
      }
      const backupId = parsedId.data;
      const level = parsedLvl.data;
      await assertDriveReady();

      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        },
        select: { id: true, status: true }
      });
      if (rep === null) {
        throw new ReplicationServiceError(
          "NOT_FOUND",
          PUBLIC_MESSAGE.NOT_FOUND
        );
      }
      if (rep.status !== "COMPLETED") {
        // §J: deep-verify only makes sense on a COMPLETED row.
        throw new ReplicationServiceError(
          "STATE_CONFLICT",
          PUBLIC_MESSAGE.STATE_CONFLICT,
          `status=${rep.status}`
        );
      }

      const deps = await buildVerifyDeps();
      let result: VerifyRemoteResult;
      const auditAction =
        level === "METADATA"
          ? "backup.replication.verify.metadata"
          : "backup.replication.verify.sha256";
      if (level === "METADATA") {
        result = await verifyRemoteMetadata(rep.id, deps);
      } else {
        result = await verifyRemoteFullSha256(rep.id, deps);
      }

      await audit({
        userId: input.actor.id,
        action: auditAction,
        entity: "BackupReplication",
        entityId: rep.id,
        meta: {
          operationId,
          backupId,
          outcome: result.outcome,
          // `errorCode` is a classified enum, never a raw Google message.
          errorCode: result.outcome === "MISMATCH" ? result.errorCode : undefined,
          actorRole: input.actor.role
        }
      });

      return {
        backupId,
        level: level === "METADATA" ? ("METADATA_ONLY" as const) : ("FULL_SHA256" as const),
        outcome: result.outcome,
        errorCode: result.outcome === "MISMATCH" ? result.errorCode : undefined
      };
    }
  );
}

// ─── Reconcile ────────────────────────────────────────────────────────────

export async function reconcileRemoteService(input: {
  actor: Actor;
  backupId: string;
}): Promise<
  ReplicationServiceResult<{
    backupId: string;
    outcome: string;
    errorCode?: string;
  }>
> {
  const operationId = randomUUID();
  return runOrCatch(
    operationId,
    input.actor.id,
    "backup.replication.reconcile",
    async () => {
      await assertReplicationPermission(input.actor, "backup.replication.reconcile");
      const parsed = backupIdSchema.safeParse(input.backupId);
      if (!parsed.success) {
        throw new ReplicationServiceError(
          "INVALID_INPUT",
          PUBLIC_MESSAGE.INVALID_INPUT,
          parsed.error.message
        );
      }
      const backupId = parsed.data;
      await assertDriveReady();

      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        },
        select: {
          id: true,
          status: true,
          errorCode: true
        }
      });
      if (rep === null) {
        throw new ReplicationServiceError(
          "NOT_FOUND",
          PUBLIC_MESSAGE.NOT_FOUND
        );
      }

      const deps: ReconcileReplicationDeps = {
        prisma,
        drive: getGoogleDriveClient(),
        now: () => new Date()
      };
      const before = { status: rep.status, errorCode: rep.errorCode };
      const result = await reconcileReplicationRemote(rep.id, deps);
      const after = await prisma.backupReplication.findUnique({
        where: { id: rep.id },
        select: { status: true, errorCode: true }
      });

      await audit({
        userId: input.actor.id,
        action: "backup.replication.reconcile",
        entity: "BackupReplication",
        entityId: rep.id,
        meta: {
          operationId,
          backupId,
          outcome: result.outcome,
          before,
          after: after ?? before,
          errorCode:
            result.outcome === "DRIVE_ERROR" ? result.errorCode : undefined,
          actorRole: input.actor.role
        }
      });

      return {
        backupId,
        outcome: result.outcome,
        errorCode:
          result.outcome === "DRIVE_ERROR" ? result.errorCode : undefined
      };
    }
  );
}

// ─── Restore from Drive ────────────────────────────────────────────────────

export type RestoreFromDriveOutcome =
  | "OK"
  | "REFUSED_LOCAL_ALREADY_PRESENT"
  | "REFUSED_NOT_REPLICATED"
  | "VERIFY_FAILED"
  | "DOWNLOAD_FAILED"
  | "RESTORE_FAILED";

export async function restoreFromDriveService(input: {
  actor: Actor;
  backupId: string;
  confirmationPhrase: string;
  adminPassword: string;
}): Promise<
  ReplicationServiceResult<{
    backupId: string;
    outcome: RestoreFromDriveOutcome;
    restoreOperationId?: string;
    downloadedRemoteBinFileId?: string;
  }>
> {
  const operationId = randomUUID();
  return runOrCatch(
    operationId,
    input.actor.id,
    "backup.replication.restore",
    async () => {
      // TWO-KEY GATE — §P.1 rule. Both must pass. The order below emits
      // the replication permission's denial audit first (via runOrCatch's
      // failure hook) if that one fails; if it passes but `backup.restore`
      // does not, the same failure hook still fires (identical audit
      // action for the replication service) and no Drive I/O happens.
      await assertReplicationPermission(input.actor, "backup.replication.restore");
      await assertReplicationPermission(input.actor, "backup.restore");

      const parsed = restoreInputSchema.safeParse({
        backupId: input.backupId,
        confirmationPhrase: input.confirmationPhrase,
        adminPassword: input.adminPassword
      });
      if (!parsed.success) {
        throw new ReplicationServiceError(
          "INVALID_INPUT",
          PUBLIC_MESSAGE.INVALID_INPUT,
          parsed.error.message
        );
      }
      const { backupId, confirmationPhrase, adminPassword } = parsed.data;

      await assertDriveReady();

      await audit({
        userId: input.actor.id,
        action: "backup.replication.restore.request",
        entity: "Backup",
        entityId: backupId,
        meta: {
          operationId,
          backupId,
          actorId: input.actor.id,
          actorRole: input.actor.role
        }
      });

      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        },
        select: {
          status: true,
          remoteBinFileId: true
        }
      });

      const timeoutMs =
        getResolvedGoogleDriveHttpTimeoutMs() ?? 90_000;

      // Phase 1: download + verify. Emits download.start / download.success.
      await audit({
        userId: input.actor.id,
        action: "backup.replication.download.start",
        entity: "Backup",
        entityId: backupId,
        meta: {
          operationId,
          backupId,
          // remoteBinFileId is not a secret (appears in Drive URLs).
          remoteBinFileId: rep?.remoteBinFileId ?? null
        }
      });

      const deps: RemoteRestoreDeps = {
        prisma,
        http: defaultHttpClient(),
        accessToken: await getGoogleDriveAccessToken(),
        now: () => new Date(),
        httpTimeoutMs: timeoutMs
      };

      let downloadOutcome: RemoteRestoreOutcome;
      try {
        downloadOutcome = await downloadAndVerifyDriveBackup(backupId, deps);
      } catch (err) {
        const classified = classifyGoogleErrorForService(err);
        throw new ReplicationServiceError(
          "REPLICATION_ERROR",
          PUBLIC_MESSAGE.REPLICATION_ERROR,
          `code=${classified.code}`
        );
      }

      if (downloadOutcome.outcome === "REFUSED_LOCAL_ALREADY_PRESENT") {
        return {
          backupId,
          outcome: "REFUSED_LOCAL_ALREADY_PRESENT" as const
        };
      }
      if (downloadOutcome.outcome === "REFUSED_NOT_REPLICATED") {
        return {
          backupId,
          outcome: "REFUSED_NOT_REPLICATED" as const
        };
      }
      if (downloadOutcome.outcome === "VERIFY_FAILED") {
        return {
          backupId,
          outcome: "VERIFY_FAILED" as const
        };
      }
      if (downloadOutcome.outcome === "DOWNLOAD_FAILED") {
        return {
          backupId,
          outcome: "DOWNLOAD_FAILED" as const
        };
      }

      // LOCAL_BACKUP_MATERIALIZED — a fresh Backup row + published files
      // now exist. Fire the download.success audit and hand off to the
      // existing Phase 7 restore engine.
      await audit({
        userId: input.actor.id,
        action: "backup.replication.download.success",
        entity: "Backup",
        entityId: backupId,
        meta: {
          operationId,
          backupId,
          // sizeBytes is available via the Backup row we just inserted.
          binPath: undefined
        }
      });

      // Phase 2: chain into the existing restore pipeline. It re-checks
      // `backup.restore`, re-runs confirmation + password verification,
      // creates a safety snapshot, and applies destructively.
      const { runRestore } = await import("@/lib/backup/restore");
      const restoreResult = await runRestore({
        actor: input.actor,
        backupId,
        confirmationPhrase,
        adminPassword,
        force: false
      });

      if (!restoreResult.ok) {
        if (restoreResult.code === "CONFIRMATION_INVALID") {
          throw new ReplicationServiceError(
            "CONFIRMATION_INVALID",
            PUBLIC_MESSAGE.CONFIRMATION_INVALID,
            `restore code=${restoreResult.code}`
          );
        }
        return {
          backupId,
          outcome: "RESTORE_FAILED" as const,
          restoreOperationId: restoreResult.restoreOperationId
        };
      }

      return {
        backupId,
        outcome: "OK" as const,
        restoreOperationId: restoreResult.restoreOperationId
      };
    }
  );
}

// ─── Bootstrap Drive folder ────────────────────────────────────────────────

export async function bootstrapDriveFolderService(input: {
  actor: Actor;
}): Promise<
  ReplicationServiceResult<{
    folderId: string;
    source: "env" | "db" | "marker";
    audit: "bootstrap" | "discovered";
  }>
> {
  const operationId = randomUUID();
  return runOrCatch(
    operationId,
    input.actor.id,
    "backup.replication.settings",
    async () => {
      await assertReplicationPermission(input.actor, "backup.replication.settings");
      await assertDriveReady();

      const cfg = loadGoogleDriveConfig();
      const singleton = await prisma.backupReplicationConfig.findUnique({
        where: { id: "google_drive" },
        select: {
          folderId: true,
          folderName: true,
          folderMarker: true
        }
      });
      if (!singleton) {
        // The seed SQL is missing — refuse rather than invent a row.
        throw new ReplicationServiceError(
          "CONFIGURATION_ERROR",
          PUBLIC_MESSAGE.CONFIGURATION_ERROR,
          "BackupReplicationConfig singleton row missing"
        );
      }

      const drive = getGoogleDriveClient();
      let resolved: { folderId: string; source: "env" | "db" | "marker" };
      try {
        resolved = await resolveGoogleDriveFolder({
          drive,
          folderIdFromEnv: cfg.folderIdFromEnv,
          dbFolderId: singleton.folderId,
          folderMarker: singleton.folderMarker
        });
      } catch (err) {
        // resolveGoogleDriveFolder REFUSES to auto-create a folder — a
        // brand-new deployment must run scripts/backup-drive-bootstrap.ts
        // once from the operator's machine. Bubble a classified
        // CONFIGURATION_ERROR up to the UI so the operator sees the
        // guidance without any raw Google bytes.
        if (err instanceof GoogleDriveOperationError) {
          throw new ReplicationServiceError(
            "CONFIGURATION_ERROR",
            PUBLIC_MESSAGE.CONFIGURATION_ERROR,
            `code=${err.code}`
          );
        }
        const c = classifyGoogleErrorForService(err);
        throw new ReplicationServiceError(
          "CONFIGURATION_ERROR",
          PUBLIC_MESSAGE.CONFIGURATION_ERROR,
          `code=${c.code}`
        );
      }

      // Persist the discovered folder id. Only update `bootstrappedAt`
      // when this is the first time we've adopted an id.
      const auditAction =
        singleton.folderId === null ? ("bootstrap" as const) : ("discovered" as const);
      await prisma.backupReplicationConfig.update({
        where: { id: "google_drive" },
        data: {
          folderId: resolved.folderId,
          bootstrappedAt: auditAction === "bootstrap" ? new Date() : undefined,
          lastReconciledAt: new Date()
        }
      });

      await audit({
        userId: input.actor.id,
        action:
          auditAction === "bootstrap"
            ? "backup.replication.folder.bootstrap"
            : "backup.replication.folder.discovered",
        entity: "BackupReplicationConfig",
        entityId: "google_drive",
        meta: {
          operationId,
          folderId: resolved.folderId,
          folderName: singleton.folderName,
          source: resolved.source,
          actorRole: input.actor.role
        }
      });

      // §P.3 settings.update event captures the state-row delta.
      await audit({
        userId: input.actor.id,
        action: "backup.replication.settings.update",
        entity: "BackupReplicationConfig",
        entityId: "google_drive",
        meta: {
          operationId,
          before: {
            folderId: singleton.folderId,
            bootstrappedAt: null
          },
          after: {
            folderId: resolved.folderId,
            bootstrappedAt: auditAction === "bootstrap" ? "now" : "unchanged"
          },
          actorRole: input.actor.role
        }
      });

      return {
        folderId: resolved.folderId,
        source: resolved.source,
        audit: auditAction
      };
    }
  );
}

// ─── Shared runner + failure normalization ────────────────────────────────

/**
 * Wrap a service body with the standard success/failure audit
 * discipline. On any thrown `ReplicationServiceError`:
 *   * UNAUTHORIZED  → emit `<baseAudit>.denied` (§P.3 requires denied
 *                     replication attempts to be audited).
 *   * every other  → emit `<baseAudit>.failure` with the classified code.
 * On unexpected exceptions, folds to `INTERNAL` and emits `.failure`.
 *
 * `baseAudit` is the plan's action name for this verb (e.g.
 * "backup.replication.retry"). Success-path audits are the caller's
 * responsibility (they carry action-specific meta).
 */
async function runOrCatch<T>(
  operationId: string,
  actorId: string,
  baseAudit:
    | "backup.replication.retry"
    | "backup.replication.verify"
    | "backup.replication.reconcile"
    | "backup.replication.restore"
    | "backup.replication.settings",
  body: () => Promise<T>
): Promise<ReplicationServiceResult<T>> {
  try {
    const value = await body();
    return { ok: true, operationId, ...value };
  } catch (err) {
    if (err instanceof ReplicationServiceError) {
      // Denied-attempt audit path.
      const suffix = err.code === "UNAUTHORIZED" ? "denied" : "failure";
      await audit({
        userId: actorId,
        action: `${baseAudit}.${suffix}`,
        entity: "BackupReplication",
        meta: {
          operationId,
          errorCode: err.code,
          // NEVER expose `err.internal` verbatim — it is the internal
          // hint (e.g. "actor=… needed=…"). Callers only see the code.
          errorClass: err.name
        }
      }).catch(() => undefined);
      return {
        ok: false,
        code: err.code,
        publicMessage: err.publicMessage,
        operationId
      };
    }
    // Unknown throwable — fold to INTERNAL. Never surface `err.message`.
    await audit({
      userId: actorId,
      action: `${baseAudit}.failure`,
      entity: "BackupReplication",
      meta: {
        operationId,
        errorCode: "INTERNAL",
        errorClass: err instanceof Error ? err.name : "unknown"
      }
    }).catch(() => undefined);
    return {
      ok: false,
      code: "INTERNAL",
      publicMessage: PUBLIC_MESSAGE.INTERNAL,
      operationId
    };
  }
}

function classifyGoogleErrorForService(err: unknown): {
  code: string;
} {
  if (err instanceof GoogleDriveOperationError) {
    return { code: err.code };
  }
  const c = classifyGoogleError(err);
  return { code: c.code };
}

// ─── Verify deps builder ──────────────────────────────────────────────────

async function buildVerifyDeps(): Promise<VerifyRemoteDeps> {
  const cfg = loadGoogleDriveConfig();
  const storageDir = loadBackupStorageDir();
  // `verify-remote.ts` uses `mkdtemp(path.join(stagingRoot, "drive-verify-"))`
  // to create its OWN per-verify subdirectory and cleans it up in its
  // own `finally`. We pass the storage root's `staging/` directly so
  // the mkdtemp lands inside the well-known staging tree. We ensure
  // the staging directory exists (idempotent) rather than relying on
  // an earlier bootstrap.
  const stagingRoot = path.join(storageDir, "staging");
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const singleton = await prisma.backupReplicationConfig.findUnique({
    where: { id: "google_drive" },
    select: { folderId: true, folderMarker: true }
  });
  const drive = getGoogleDriveClient();
  const resolved = await resolveGoogleDriveFolder({
    drive,
    folderIdFromEnv: cfg.folderIdFromEnv,
    dbFolderId: singleton?.folderId ?? null,
    folderMarker: singleton?.folderMarker ?? "bis2027-backup-folder-v1"
  });
  return {
    prisma,
    drive,
    http: defaultHttpClient(),
    accessToken: await getGoogleDriveAccessToken(),
    folderId: resolved.folderId,
    stagingRoot,
    now: () => new Date(),
    httpTimeoutMs: getResolvedGoogleDriveHttpTimeoutMs() ?? 90_000
  };
}

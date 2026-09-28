import "server-only";

import { randomUUID } from "crypto";
import { AdminRole, Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { canWithOverrides, type Permission } from "@/lib/admin/rbac";
import { audit } from "@/lib/admin/audit";

import { runBackupDump, BackupDumpError } from "./dump";
import { verifyBackup } from "./verify";
import {
  assertValidBackupId,
  deletePublishedBackup,
  publishedBackupExists,
  BackupStorageError
} from "./storage";

// ─── Backup service layer (Phase 6) ─────────────────────────────────────────
//
// This file is the ONLY entry point for backup / restore operations from
// UI code (server actions, API routes, admin CLI). Its responsibilities:
//
//   1. Authorization (Actor RBAC vs required `backup.<verb>` permission)
//   2. Zod input validation
//   3. State-transition guards (refuse ops on rows in inappropriate status)
//   4. Audit logging on every attempt — success AND failure — with the
//      same `operationId` correlating to any subsequent internal log
//   5. Error sanitization: NEVER return a raw internal error message to
//      a caller; return a `SafeError` with `code` + `publicMessage` +
//      `operationId` (the latter for the operator to look up the full
//      story in the audit log)
//
// EXPLICIT ACTOR: every function takes `actor: { id, role }` from the
// caller. NEVER reads cookies. The server action layer above resolves
// the actor from `requirePermission(...)` and passes it down. This makes
// the service layer testable without a Next.js runtime.
//
// FAIL-CLOSED: an unknown Prisma error (e.g., a network partition to
// Postgres) surfaces as `{ code: "INTERNAL", publicMessage: "backup
// service unavailable", operationId }` — the internal message stays in
// the server logs / audit meta, not the response.
//
// LOW-1 (from the Phase 5 review): the internal `detail` field from the
// verifier is NEVER included in the return value here. Only the code
// enum and human-readable public message travel outbound.

export interface Actor {
  id: string;
  role: AdminRole;
}

// ─── Result / error taxonomy ────────────────────────────────────────────────

/**
 * Public error codes surfaced by the service layer. These are the ONLY
 * codes a browser client ever sees. Internal codes from the underlying
 * verifier / dump engine are folded into the appropriate public code.
 */
export type ServiceErrorCode =
  | "UNAUTHORIZED"           // actor lacks the required permission
  | "INVALID_INPUT"          // zod validation failed
  | "NOT_FOUND"              // backup id does not exist
  | "STATE_CONFLICT"         // op incompatible with the row's current status
  | "IN_PROGRESS_CONFLICT"   // another backup / restore is running
  | "STORAGE_UNAVAILABLE"    // backup file missing on disk
  | "CRYPTO_UNAVAILABLE"     // BACKUP_ENCRYPTION_KEY missing or malformed
  | "INTEGRITY_FAILED"       // verify returned a failure code
  | "SCHEMA_INCOMPATIBLE"    // restore preflight refused a schema mismatch
  | "CONFIRMATION_INVALID"   // restore confirmation phrase / password mismatch
  | "RATE_LIMITED"           // reserved — currently unused
  | "INTERNAL";              // any unexpected error

/**
 * Every service function returns a discriminated union with a code +
 * short public message. `operationId` correlates to an audit row so
 * operators can look up the full internal detail without exposing it
 * to the browser.
 */
export type ServiceResult<T> =
  | ({ ok: true; operationId: string } & T)
  | {
      ok: false;
      code: ServiceErrorCode;
      publicMessage: string;
      operationId: string;
    };

export class BackupServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    public readonly publicMessage: string,
    public readonly internal?: string
  ) {
    super(`${code}: ${publicMessage}`);
    this.name = "BackupServiceError";
  }
}

// Static public messages. Kept intentionally boring — no interpolation
// of ids / paths / field values. Meant for direct display to an
// operator. Localization / i18n can wrap this table later.
const PUBLIC_MESSAGE: Record<ServiceErrorCode, string> = {
  UNAUTHORIZED: "Permission refusée.",
  INVALID_INPUT: "Entrée invalide.",
  NOT_FOUND: "Sauvegarde introuvable.",
  STATE_CONFLICT: "Cette opération est incompatible avec l’état actuel de la sauvegarde.",
  IN_PROGRESS_CONFLICT: "Une opération de sauvegarde ou de restauration est déjà en cours.",
  STORAGE_UNAVAILABLE: "Le fichier de sauvegarde est indisponible.",
  CRYPTO_UNAVAILABLE: "Clé de chiffrement des sauvegardes non configurée.",
  INTEGRITY_FAILED: "La vérification d’intégrité a échoué.",
  SCHEMA_INCOMPATIBLE: "Le schéma de cette sauvegarde ne correspond pas au schéma actuel.",
  CONFIRMATION_INVALID: "Confirmation ou mot de passe invalide.",
  RATE_LIMITED: "Trop de tentatives — veuillez réessayer plus tard.",
  INTERNAL: "Erreur interne — voir les logs pour l’operationId indiqué."
};

// ─── Authorization ──────────────────────────────────────────────────────────

/**
 * Assert the actor has the given backup permission. Throws
 * `BackupServiceError("UNAUTHORIZED")` if not. Every mutating service
 * function calls this at the top — the server-action layer's
 * `requirePermission(...)` is redundant defence, not the primary
 * boundary.
 *
 * Uses `canWithOverrides` so RolePermissionOverride rows are respected
 * (an operator can grant `backup.delete` to a non-SUPER_ADMIN role via
 * the roles admin UI without touching this code).
 */
async function assertBackupPermission(
  actor: Actor,
  perm: Extract<Permission, `backup.${string}`>
): Promise<void> {
  const ok = await canWithOverrides(actor.role, perm);
  if (!ok) {
    throw new BackupServiceError(
      "UNAUTHORIZED",
      PUBLIC_MESSAGE.UNAUTHORIZED,
      `actor=${actor.id} role=${actor.role} needed=${perm}`
    );
  }
}

// ─── Input schemas ──────────────────────────────────────────────────────────

const CUID_RE = /^c[a-z0-9]{24}$/;
const backupIdSchema = z.string().regex(CUID_RE, "invalid cuid");

const listInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
  status: z
    .enum([
      "PENDING",
      "RUNNING",
      "COMPLETED",
      "VERIFIED",
      "FAILED",
      "DELETED",
      "MISSING"
    ])
    .optional()
});

const scheduleInputSchema = z.object({
  enabled: z.boolean(),
  frequencyHours: z.number().int().min(1).max(168),
  retentionCount: z.number().int().min(1).max(365),
  // 0 disables the age rule. Ceiling of 3650d (10y) is a defensive cap
  // against a client passing Number.MAX_SAFE_INTEGER.
  retentionAgeDays: z.number().int().min(0).max(3650).default(90)
});

// ─── Public service functions ───────────────────────────────────────────────

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Trigger a manual backup. Non-destructive; simply produces a new file.
 * Refuses if another backup or restore is already `PENDING`/`RUNNING`.
 */
export async function createBackupService(input: {
  actor: Actor;
}): Promise<
  ServiceResult<{
    backupId: string;
    sizeBytes: number;
    totalRows: number;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.create");

    // Concurrency guard: refuse if any backup is currently PENDING or
    // RUNNING — Phase 8's scheduler tick will use the same predicate.
    const active = await prisma.backup.findFirst({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true }
    });
    if (active) {
      throw new BackupServiceError(
        "IN_PROGRESS_CONFLICT",
        PUBLIC_MESSAGE.IN_PROGRESS_CONFLICT,
        `blockingBackupId=${active.id}`
      );
    }

    await audit({
      userId: input.actor.id,
      action: "backup.create.request",
      entity: "Backup",
      meta: { operationId, actorRole: input.actor.role }
    });

    let dump;
    try {
      dump = await runBackupDump({ kind: "MANUAL", createdById: input.actor.id });
    } catch (err) {
      await audit({
        userId: input.actor.id,
        action: "backup.create.failure",
        entity: "Backup",
        meta: {
          operationId,
          errorClass: err instanceof Error ? err.name : "unknown",
          // Safe: BackupDumpError messages are code-authored.
          errorHint: err instanceof BackupDumpError ? err.message : undefined
        }
      });
      throw serviceErrorFromDump(err);
    }

    await audit({
      userId: input.actor.id,
      action: "backup.create.success",
      entity: "Backup",
      entityId: dump.backupId,
      meta: {
        operationId,
        sizeBytes: dump.sizeBytes,
        totalRows: dump.totalRows
      }
    });

    return {
      ok: true,
      operationId,
      backupId: dump.backupId,
      sizeBytes: dump.sizeBytes,
      totalRows: dump.totalRows
    };
  } catch (err) {
    return serviceFailure(operationId, err, input.actor.id, "backup.create.failure");
  }
}

// ── Verify ──────────────────────────────────────────────────────────────────

/**
 * Re-run the Phase 5 verifier against a backup and persist the outcome.
 * Non-destructive. Returns a sanitized outcome — the internal `detail`
 * string never crosses this boundary.
 */
export async function verifyBackupService(input: {
  actor: Actor;
  backupId: string;
}): Promise<
  ServiceResult<{
    outcome: "VERIFIED" | "FAILED";
    code: string;
    stage: string;
    contentSha256?: string;
    totalRows?: number;
    schemaCompatible?: boolean;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.verify");
    const parsed = backupIdSchema.safeParse(input.backupId);
    if (!parsed.success) {
      throw new BackupServiceError(
        "INVALID_INPUT",
        PUBLIC_MESSAGE.INVALID_INPUT,
        parsed.error.message
      );
    }
    const backupId = parsed.data;

    await audit({
      userId: input.actor.id,
      action: "backup.verify.request",
      entity: "Backup",
      entityId: backupId,
      meta: { operationId }
    });

    const result = await verifyBackup({
      backupId,
      verifiedById: input.actor.id,
      persist: true
    });

    await audit({
      userId: input.actor.id,
      action: "backup.verify.result",
      entity: "Backup",
      entityId: backupId,
      meta: {
        operationId,
        outcome: result.outcome,
        code: result.code,
        stage: result.stage,
        totalRows: result.totalRows,
        schemaCompatible: result.schemaCompatible
      }
    });

    return {
      ok: true,
      operationId,
      outcome: result.outcome,
      // Public: expose code + stage + high-level shape. NEVER `detail`.
      code: result.code,
      stage: result.stage,
      contentSha256: result.contentSha256,
      totalRows: result.totalRows,
      schemaCompatible: result.schemaCompatible
    };
  } catch (err) {
    return serviceFailure(operationId, err, input.actor.id, "backup.verify.failure");
  }
}

// ── List ────────────────────────────────────────────────────────────────────

/**
 * Paginated list of backups. Never exposes filesystem paths — only
 * metadata already stored on the row.
 */
export async function listBackupsService(input: {
  actor: Actor;
  limit?: number;
  offset?: number;
  status?: z.infer<typeof listInputSchema>["status"];
}): Promise<
  ServiceResult<{
    total: number;
    items: Array<{
      id: string;
      status: string;
      kind: string;
      startedAt: string;
      completedAt: string | null;
      sizeBytes: string | null;
      appVersion: string;
      formatVersion: string;
      encryptionVersion: string;
      verifiedAt: string | null;
      verifyResult: string | null;
      createdById: string | null;
    }>;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.view");
    const parsed = listInputSchema.safeParse({
      limit: input.limit,
      offset: input.offset,
      status: input.status
    });
    if (!parsed.success) {
      throw new BackupServiceError(
        "INVALID_INPUT",
        PUBLIC_MESSAGE.INVALID_INPUT,
        parsed.error.message
      );
    }

    const where = parsed.data.status
      ? { status: parsed.data.status as Prisma.EnumBackupStatusFilter["equals"] }
      : {};

    const [total, rows] = await Promise.all([
      prisma.backup.count({ where }),
      prisma.backup.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: parsed.data.limit,
        skip: parsed.data.offset,
        select: {
          id: true,
          status: true,
          kind: true,
          startedAt: true,
          completedAt: true,
          sizeBytes: true,
          appVersion: true,
          formatVersion: true,
          encryptionVersion: true,
          verifiedAt: true,
          verifyResult: true,
          createdById: true
          // NEVER expose: fileName, contentSha256, manifestSha256,
          // schemaSha256, rowCounts, errorMessage — those are internal
          // or PII-sensitive.
        }
      })
    ]);

    return {
      ok: true,
      operationId,
      total,
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        kind: r.kind,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        // Serialize BigInt as string to avoid JSON overflow / lossy .toJSON.
        sizeBytes: r.sizeBytes === null ? null : r.sizeBytes.toString(),
        appVersion: r.appVersion,
        formatVersion: r.formatVersion,
        encryptionVersion: r.encryptionVersion,
        verifiedAt: r.verifiedAt?.toISOString() ?? null,
        verifyResult: r.verifyResult,
        createdById: r.createdById
      }))
    };
  } catch (err) {
    return serviceFailure(operationId, err, input.actor.id, "backup.list.failure");
  }
}

// ── Get one ─────────────────────────────────────────────────────────────────

/**
 * Fetch a single backup's public metadata. Returns NOT_FOUND for both
 * "no such id" and "id exists but caller not authorized to see" — this
 * is deliberate: we already refused `backup.view` above, so if we reach
 * here the actor has read authority for ALL backups (the RBAC model is
 * not per-object). NOT_FOUND therefore always means the row does not
 * exist. Documented so future work does not weaken it.
 */
export async function getBackupService(input: {
  actor: Actor;
  backupId: string;
}): Promise<
  ServiceResult<{
    id: string;
    status: string;
    kind: string;
    startedAt: string;
    completedAt: string | null;
    sizeBytes: string | null;
    appVersion: string;
    formatVersion: string;
    encryptionVersion: string;
    rowCounts: Record<string, number> | null;
    verifiedAt: string | null;
    verifyResult: string | null;
    createdById: string | null;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.view");
    const parsed = backupIdSchema.safeParse(input.backupId);
    if (!parsed.success) {
      throw new BackupServiceError(
        "INVALID_INPUT",
        PUBLIC_MESSAGE.INVALID_INPUT,
        parsed.error.message
      );
    }
    const backupId = parsed.data;

    const row = await prisma.backup.findUnique({
      where: { id: backupId },
      select: {
        id: true,
        status: true,
        kind: true,
        startedAt: true,
        completedAt: true,
        sizeBytes: true,
        appVersion: true,
        formatVersion: true,
        encryptionVersion: true,
        rowCounts: true,
        verifiedAt: true,
        verifyResult: true,
        createdById: true
      }
    });
    if (!row) {
      throw new BackupServiceError("NOT_FOUND", PUBLIC_MESSAGE.NOT_FOUND);
    }
    return {
      ok: true,
      operationId,
      id: row.id,
      status: row.status,
      kind: row.kind,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      sizeBytes: row.sizeBytes === null ? null : row.sizeBytes.toString(),
      appVersion: row.appVersion,
      formatVersion: row.formatVersion,
      encryptionVersion: row.encryptionVersion,
      // rowCounts is Prisma Json; ensure it looks like Record<string, number>
      // or return null. Zod-narrow to protect the client from a malformed
      // value ever landing in this table.
      rowCounts: isRowCountsShape(row.rowCounts) ? row.rowCounts : null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      verifyResult: row.verifyResult,
      createdById: row.createdById
    };
  } catch (err) {
    return serviceFailure(operationId, err, input.actor.id, "backup.get.failure");
  }
}

function isRowCountsShape(v: unknown): v is Record<string, number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== "number" || !Number.isFinite(val)) return false;
  }
  return true;
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a backup's on-disk artefacts and mark the row `DELETED`.
 * Refuses:
 *   • If the row is currently `PENDING` or `RUNNING` (never delete an
 *     in-progress dump).
 *   • If any `RestoreOperation` references this backup in an active
 *     state (PREFLIGHT, RUNNING) — the underlying FK is RESTRICT-typed,
 *     but we surface a clean STATE_CONFLICT rather than letting Prisma
 *     bubble a P2003 with the value.
 *
 * Enforces a retention floor of 1: at least one COMPLETED / VERIFIED
 * backup must remain after the delete. This is a belt-and-braces guard
 * against an operator delete-all pattern; the scheduled retention prune
 * (Phase 8) uses the same predicate.
 */
export async function deleteBackupService(input: {
  actor: Actor;
  backupId: string;
}): Promise<ServiceResult<{ backupId: string }>> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.delete");
    const parsed = backupIdSchema.safeParse(input.backupId);
    if (!parsed.success) {
      throw new BackupServiceError(
        "INVALID_INPUT",
        PUBLIC_MESSAGE.INVALID_INPUT,
        parsed.error.message
      );
    }
    const backupId = parsed.data;

    const row = await prisma.backup.findUnique({
      where: { id: backupId },
      select: { id: true, status: true }
    });
    if (!row) {
      throw new BackupServiceError("NOT_FOUND", PUBLIC_MESSAGE.NOT_FOUND);
    }
    if (row.status === "PENDING" || row.status === "RUNNING") {
      throw new BackupServiceError(
        "STATE_CONFLICT",
        PUBLIC_MESSAGE.STATE_CONFLICT,
        `status=${row.status}`
      );
    }
    // Refuse if an active restore references this backup as its source
    // OR its safety snapshot. Delete-safety > convenience.
    const referencingRestore = await prisma.restoreOperation.findFirst({
      where: {
        status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] },
        OR: [{ backupId }, { safetyBackupId: backupId }]
      },
      select: { id: true }
    });
    if (referencingRestore) {
      throw new BackupServiceError(
        "STATE_CONFLICT",
        PUBLIC_MESSAGE.STATE_CONFLICT,
        `restoreOperationId=${referencingRestore.id}`
      );
    }

    // Retention floor of 1.
    const remaining = await prisma.backup.count({
      where: {
        id: { not: backupId },
        status: { in: ["COMPLETED", "VERIFIED"] }
      }
    });
    if (remaining < 1) {
      throw new BackupServiceError(
        "STATE_CONFLICT",
        PUBLIC_MESSAGE.STATE_CONFLICT,
        "would violate retention floor of 1"
      );
    }

    await audit({
      userId: input.actor.id,
      action: "backup.delete.request",
      entity: "Backup",
      entityId: backupId,
      meta: { operationId, previousStatus: row.status }
    });

    // Files may already be missing (e.g., MISSING status) — always safe.
    try {
      await deletePublishedBackup(backupId);
    } catch (err) {
      if (err instanceof BackupStorageError) {
        throw new BackupServiceError(
          "INTERNAL",
          PUBLIC_MESSAGE.INTERNAL,
          "storage delete refused"
        );
      }
      throw err;
    }

    await prisma.backup.update({
      where: { id: backupId },
      data: {
        status: "DELETED",
        // Explicit `completedAt` for retention book-keeping when the row
        // was previously PENDING/RUNNING (defensive — we already refused
        // those above).
        completedAt: row.status === "COMPLETED" || row.status === "VERIFIED"
          ? undefined
          : new Date()
      }
    });

    await audit({
      userId: input.actor.id,
      action: "backup.delete.success",
      entity: "Backup",
      entityId: backupId,
      meta: { operationId }
    });

    return { ok: true, operationId, backupId };
  } catch (err) {
    return serviceFailure(operationId, err, input.actor.id, "backup.delete.failure");
  }
}

// ── Schedule ────────────────────────────────────────────────────────────────

const SCHEDULE_ID = "singleton";

export async function getScheduleService(input: {
  actor: Actor;
}): Promise<
  ServiceResult<{
    enabled: boolean;
    frequencyHours: number;
    retentionCount: number;
    retentionAgeDays: number;
    updatedAt: string | null;
    updatedById: string | null;
    lastRunAt: string | null;
    lastRunOutcome: string | null;
    lastRunBackupId: string | null;
    lastRunError: string | null;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.view");
    // Row is auto-created on first read; enforces the singleton invariant
    // via WHERE id='singleton' rather than a fresh cuid default.
    const row = await prisma.backupSchedule.upsert({
      where: { id: SCHEDULE_ID },
      create: { id: SCHEDULE_ID },
      update: {},
      select: {
        enabled: true,
        frequencyHours: true,
        retentionCount: true,
        retentionAgeDays: true,
        updatedAt: true,
        updatedById: true,
        lastRunAt: true,
        lastRunOutcome: true,
        lastRunBackupId: true,
        lastRunError: true
      }
    });
    return {
      ok: true,
      operationId,
      enabled: row.enabled,
      frequencyHours: row.frequencyHours,
      retentionCount: row.retentionCount,
      retentionAgeDays: row.retentionAgeDays,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      updatedById: row.updatedById,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastRunOutcome: row.lastRunOutcome,
      lastRunBackupId: row.lastRunBackupId,
      lastRunError: row.lastRunError
    };
  } catch (err) {
    return serviceFailure(operationId, err, input.actor.id, "backup.schedule.get.failure");
  }
}

export async function updateScheduleService(input: {
  actor: Actor;
  enabled: boolean;
  frequencyHours: number;
  retentionCount: number;
  retentionAgeDays?: number;
}): Promise<
  ServiceResult<{
    enabled: boolean;
    frequencyHours: number;
    retentionCount: number;
    retentionAgeDays: number;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.settings");
    const parsed = scheduleInputSchema.safeParse({
      enabled: input.enabled,
      frequencyHours: input.frequencyHours,
      retentionCount: input.retentionCount,
      retentionAgeDays: input.retentionAgeDays
    });
    if (!parsed.success) {
      throw new BackupServiceError(
        "INVALID_INPUT",
        PUBLIC_MESSAGE.INVALID_INPUT,
        parsed.error.message
      );
    }

    // upsert with a FIXED id string enforces the singleton pattern —
    // impossible to accidentally create a second row.
    const row = await prisma.backupSchedule.upsert({
      where: { id: SCHEDULE_ID },
      create: {
        id: SCHEDULE_ID,
        enabled: parsed.data.enabled,
        frequencyHours: parsed.data.frequencyHours,
        retentionCount: parsed.data.retentionCount,
        retentionAgeDays: parsed.data.retentionAgeDays,
        updatedById: input.actor.id
      },
      update: {
        enabled: parsed.data.enabled,
        frequencyHours: parsed.data.frequencyHours,
        retentionCount: parsed.data.retentionCount,
        retentionAgeDays: parsed.data.retentionAgeDays,
        updatedById: input.actor.id
      },
      select: {
        enabled: true,
        frequencyHours: true,
        retentionCount: true,
        retentionAgeDays: true
      }
    });

    await audit({
      userId: input.actor.id,
      action: "backup.schedule.update",
      entity: "BackupSchedule",
      entityId: SCHEDULE_ID,
      meta: {
        operationId,
        after: {
          enabled: row.enabled,
          frequencyHours: row.frequencyHours,
          retentionCount: row.retentionCount,
          retentionAgeDays: row.retentionAgeDays
        }
      }
    });

    return { ok: true, operationId, ...row };
  } catch (err) {
    return serviceFailure(operationId, err, input.actor.id, "backup.schedule.update.failure");
  }
}

// ─── Error normalization ────────────────────────────────────────────────────

/**
 * Convert an internal exception into a sanitized `ServiceResult` failure.
 * Every code path logs an audit row with the raw error class name and a
 * bounded hint — enough for the operator to correlate via `operationId`
 * without leaking a Prisma value into the response.
 */
async function serviceFailure(
  operationId: string,
  err: unknown,
  actorId: string,
  auditAction: string
): Promise<{
  ok: false;
  code: ServiceErrorCode;
  publicMessage: string;
  operationId: string;
}> {
  let code: ServiceErrorCode;
  let publicMessage: string;
  let internal: string | undefined;

  if (err instanceof BackupServiceError) {
    code = err.code;
    publicMessage = err.publicMessage;
    internal = err.internal;
  } else if (err instanceof BackupStorageError) {
    code = "STORAGE_UNAVAILABLE";
    publicMessage = PUBLIC_MESSAGE.STORAGE_UNAVAILABLE;
    internal = "storage error";
  } else {
    code = "INTERNAL";
    publicMessage = PUBLIC_MESSAGE.INTERNAL;
    internal = err instanceof Error ? err.name : "unknown";
  }

  await audit({
    userId: actorId,
    action: auditAction,
    entity: "Backup",
    meta: {
      operationId,
      errorCode: code,
      errorClass:
        err instanceof Error
          ? err.name
          : typeof err === "object" && err !== null
          ? (err.constructor?.name ?? "object")
          : "primitive",
      internalHint: internal
    }
  }).catch(() => undefined);

  return { ok: false, code, publicMessage, operationId };
}

/**
 * Fold a dump-engine exception into the appropriate `BackupServiceError`.
 * Never surfaces the raw Prisma message.
 */
function serviceErrorFromDump(err: unknown): BackupServiceError {
  if (err instanceof BackupServiceError) return err;
  if (err instanceof BackupStorageError) {
    return new BackupServiceError(
      "STORAGE_UNAVAILABLE",
      PUBLIC_MESSAGE.STORAGE_UNAVAILABLE
    );
  }
  const name = err instanceof Error ? err.name : "unknown";
  if (name === "BackupCryptoConfigError") {
    return new BackupServiceError(
      "CRYPTO_UNAVAILABLE",
      PUBLIC_MESSAGE.CRYPTO_UNAVAILABLE
    );
  }
  return new BackupServiceError("INTERNAL", PUBLIC_MESSAGE.INTERNAL, name);
}

// Re-exported so callers (server actions, tests) can inspect after a
// verify without importing verifyBackup directly. Keeps the boundary tight.
export { publishedBackupExists, assertValidBackupId };

// ─── Phase 8: manual scheduler + retention triggers ─────────────────────────
//
// Both wrap the scheduler/retention orchestrators with the RBAC + audit
// + error-sanitization discipline of the rest of this file. The concrete
// scheduling logic lives in `lib/backup/scheduler.ts` / `retention.ts`;
// these are thin adapters exposed to the admin UI.

/**
 * Manually invoke the scheduler tick. Requires `backup.create`. Bypasses
 * the "not due" gate so the operator can force an immediate scheduled
 * backup; all other protections (concurrency lock, active-backup
 * refusal, disabled-schedule refusal in non-manual mode) remain in
 * force. Manual mode explicitly ignores the "enabled" flag so an
 * operator can trigger a one-off scheduled-kind backup even while
 * automated cron is paused.
 */
export async function runSchedulerTickService(input: {
  actor: Actor;
}): Promise<
  ServiceResult<{
    outcome: string;
    backupId: string | null;
    errorCode: string | null;
    durationMs: number;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.create");
    const { runSchedulerTick } = await import("./scheduler");
    const r = await runSchedulerTick({
      actorId: input.actor.id,
      operationId,
      manual: true
    });
    return {
      ok: true,
      operationId,
      outcome: r.outcome,
      backupId: r.backupId ?? null,
      errorCode: r.errorCode ?? null,
      durationMs: r.durationMs
    };
  } catch (err) {
    return serviceFailure(
      operationId,
      err,
      input.actor.id,
      "backup.scheduler.manual.failure"
    );
  }
}

/**
 * Trigger a manual retention prune. Requires `backup.settings` — pruning
 * is a destructive schedule-adjacent action, not an ordinary delete of a
 * single row. Errors are folded into the standard sanitized shape.
 */
export async function runRetentionService(input: {
  actor: Actor;
}): Promise<
  ServiceResult<{
    outcome: string;
    scanned: number;
    deleted: number;
    protectedCount: number;
    failures: number;
    orphansObserved: number;
  }>
> {
  const operationId = randomUUID();
  try {
    await assertBackupPermission(input.actor, "backup.settings");
    const { runRetention } = await import("./retention");
    const r = await runRetention({
      actorId: input.actor.id,
      operationId
    });
    return {
      ok: true,
      operationId,
      outcome: r.outcome,
      scanned: r.scanned,
      deleted: r.deleted,
      protectedCount: r.protectedCount,
      failures: r.failures,
      orphansObserved: r.orphansObserved
    };
  } catch (err) {
    return serviceFailure(
      operationId,
      err,
      input.actor.id,
      "backup.retention.manual.failure"
    );
  }
}

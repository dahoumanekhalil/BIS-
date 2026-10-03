import "server-only";

// Layer G — Google Drive off-site backup replication worker + enqueue.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §H, §K, §L.
//
// Responsibilities (this module ONLY):
//   1. `enqueueReplicationForBackup(backupId)` — scheduler post-verify
//      handoff. Idempotent INSERT of a `BackupReplication` PENDING row
//      for `destination=GOOGLE_DRIVE`. NEVER performs Drive I/O. NEVER
//      throws — a failed enqueue is audit-only.
//   2. `runReplicationWorkerTick(opts)` — one bounded worker tick.
//        (a) Advisory-lock the replication worker key.
//        (b) Self-heal enqueue scan (bounded) for VERIFIED backups that
//            somehow lack a replication row.
//        (c) Watchdog: reconcile stuck-UPLOADING rows into PENDING.
//        (d) Rehydrate RETRYABLE_FAILURE → PENDING for rows whose
//            `nextRetryAt` is due.
//        (e) Claim exactly one candidate row via
//            `SELECT ... FOR UPDATE SKIP LOCKED`.
//        (f) RELEASE the tx (and advisory lock) BEFORE any Drive I/O.
//        (g) Perform the upload via `replicateBackupToDrive`.
//        (h) Audit + return a sanitized outcome.
//
// Absolute invariants (Layer G approval message):
//   * Drive I/O never runs inside a Prisma transaction.
//   * `Backup.status` is never written by this module (nor anything it
//     calls under `lib/backup/replication/`).
//   * Duplicate concurrent worker processing of the same row is
//     prevented at two layers: (i) the advisory lock serializes the
//     claim step, and (ii) `SELECT ... FOR UPDATE SKIP LOCKED` inside
//     the tx makes the race explicit even if the lock were somehow
//     bypassed.
//   * The scheduler's disabled-by-default policy is preserved — the
//     worker refuses to run when `GOOGLE_DRIVE_BACKUP_ENABLED != "true"`
//     and when the resolved config is not `OK`. Neither path touches
//     any backup DB row.
//   * All errors are sanitized before they land anywhere durable —
//     audit rows, admin UI, or the tick route's JSON response.

import { randomUUID } from "crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { loadBackupStorageDir } from "@/lib/backup/config";

import {
  assertGoogleDriveEnabled,
  googleDriveConfigStatus,
  isGoogleDriveConfigReady,
  isGoogleDriveEnabled,
  loadGoogleDriveConfig
} from "./config";
import {
  getGoogleDriveAccessToken,
  getGoogleDriveClient
} from "./drive-client";
import { resolveGoogleDriveFolder } from "./folder";
import { defaultHttpClient, type HttpClient } from "./http";
import {
  defaultFileReader,
  replicateBackupToDrive,
  REPLICATION_DESTINATION,
  type DriveApi,
  type FileReader,
  type ReplicateResult
} from "./uploader";
import { GoogleDriveOperationError } from "./errors";
import { sanitizeGoogleError } from "./errors";
import { classifyGoogleError } from "./classifier";

// ─── Constants ─────────────────────────────────────────────────────────────

// pg_try_advisory_xact_lock key for the replication worker. Distinct
// from the backup scheduler's key so a scheduler tick and a
// replication tick can run concurrently without contending. Chosen
// >2^31 so the two-arg int32 overload cannot alias it — same
// discipline as `SCHEDULER_LOCK_KEY` in `lib/backup/scheduler.ts`.
export const REPLICATION_WORKER_LOCK_KEY = 0x4249_5332_3032_37_02n; // "BIS2027\x02"

// A row in `UPLOADING` older than this ceiling is treated as
// abandoned. The uploader's own reconciler will re-derive Drive's
// authoritative offset on the next attempt (or start a fresh
// session), so flipping the row to PENDING is safe and idempotent.
// Chosen to comfortably exceed the largest realistic per-attempt
// upload duration.
export const STUCK_UPLOAD_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h

// Self-heal enqueue and watchdog are bounded per tick so a single
// runaway backfill cannot monopolise the worker.
const SELF_HEAL_BATCH_LIMIT = 100;
const WATCHDOG_BATCH_LIMIT = 100;

// ─── Public types ──────────────────────────────────────────────────────────

export type ReplicationWorkerOutcome =
  | "OK"
  | "SKIPPED_LOCKED"
  | "SKIPPED_DISABLED"
  | "SKIPPED_CONFIG_ERROR"
  | "SKIPPED_NO_WORK"
  | "COMPLETED"
  | "RETRYABLE"
  | "FAILED"
  | "INTERNAL";

export interface ReplicationWorkerRunResult {
  outcome: ReplicationWorkerOutcome;
  operationId: string;
  /** Sanitized code. Never a raw exception message. */
  errorCode?: string;
  /** The picked replication row id (present when we claimed one). */
  replicationId?: string;
  /** The claimed backup id (present when we claimed one). */
  backupId?: string;
  selfHeal: { inserted: number };
  watchdog: { reconciled: number };
  rehydrated: { count: number };
  durationMs: number;
}

export interface ReplicationWorkerOptions {
  client?: PrismaClient;
  now?: Date;
  /** Actor recorded on audit rows. Null for external cron. */
  actorId?: string | null;
  /** Correlation id (also carried into `replicateBackupToDrive` audit). */
  operationId?: string;
  /**
   * Test injection seams. Production code passes none of these — the
   * defaults exercise the real dependency chain.
   */
  driveFactory?: () => DriveApi;
  accessTokenFactory?: () => Promise<string>;
  folderResolver?: (drive: DriveApi) => Promise<string>;
  httpFactory?: () => HttpClient;
  files?: FileReader;
  storageDir?: string;
  chunkBytesOverride?: number;
  httpTimeoutMsOverride?: number;
}

// ─── Public: scheduler post-verify enqueue ────────────────────────────────

/**
 * Idempotent PENDING enqueue for the given backup id + Google Drive
 * destination. Called by the backup scheduler immediately after a
 * successful `verifyBackup` returns VERIFIED (§L.1). NEVER performs
 * Drive I/O. NEVER throws — a failed enqueue is audit-only and the
 * worker's self-heal scan will pick it up on the next tick.
 *
 * Refuses to enqueue when `GOOGLE_DRIVE_BACKUP_ENABLED != "true"` —
 * populating the queue while replication is off would leave dead
 * PENDING rows that the operator would have to garbage-collect after
 * enabling. This makes the flag act as a true kill-switch.
 *
 * Return shape is a simple boolean so the scheduler does not need to
 * plumb an outcome enum for a best-effort side channel.
 */
export async function enqueueReplicationForBackup(input: {
  backupId: string;
  client?: PrismaClient;
  actorId?: string | null;
  operationId?: string;
}): Promise<{ inserted: boolean }> {
  const client = input.client ?? defaultPrisma;
  const actorId = input.actorId ?? null;
  const operationId = input.operationId ?? randomUUID();

  if (!isGoogleDriveEnabled()) {
    // Silent — the disabled flag is not a failure. No audit row is
    // written because the scheduler already emits its own success
    // audit; a chatty "we did nothing" line would just noise the log.
    return { inserted: false };
  }

  try {
    // Idempotent via the unique constraint `@@unique([backupId, destination])`.
    // We check-then-create rather than `upsert(update:{})` because Prisma's
    // upsert of an existing row leaves `createdAt === updatedAt` (no
    // update fields changed), which makes "was this a fresh row?"
    // indistinguishable from a real first insert. The check + create +
    // P2002 catch pattern is race-safe: two concurrent scheduler ticks
    // will race on the unique constraint and the loser gets
    // `inserted: false`.
    const existing = await client.backupReplication.findUnique({
      where: {
        backupId_destination: {
          backupId: input.backupId,
          destination: REPLICATION_DESTINATION
        }
      },
      select: { id: true }
    });
    if (existing !== null) {
      return { inserted: false };
    }
    try {
      const created = await client.backupReplication.create({
        data: {
          backupId: input.backupId,
          destination: REPLICATION_DESTINATION,
          status: "PENDING"
        },
        select: { id: true }
      });
      await audit({
        userId: actorId,
        action: "backup.replication.enqueue",
        entity: "BackupReplication",
        entityId: created.id,
        meta: {
          operationId,
          backupId: input.backupId,
          destination: REPLICATION_DESTINATION,
          reason: "post_verify"
        }
      });
      return { inserted: true };
    } catch (createErr) {
      // P2002 unique constraint violation → a concurrent enqueue won
      // the race. That is not a failure; report inserted:false.
      if (
        typeof createErr === "object" &&
        createErr !== null &&
        (createErr as { code?: unknown }).code === "P2002"
      ) {
        return { inserted: false };
      }
      throw createErr;
    }
  } catch (err) {
    // Best-effort — a failed enqueue is not a scheduler failure. The
    // next worker tick's self-heal SQL will catch this row.
    const { name, httpStatus } = sanitizeGoogleError(err);
    await audit({
      userId: actorId,
      action: "backup.replication.enqueue.failure",
      entity: "Backup",
      entityId: input.backupId,
      meta: {
        operationId,
        errorClass: name,
        httpStatus
      }
    }).catch(() => undefined);
    return { inserted: false };
  }
}

// ─── Public: worker tick ──────────────────────────────────────────────────

/**
 * Execute one replication worker tick. NEVER throws — every branch
 * returns a `ReplicationWorkerRunResult`. Audits every terminal outcome.
 *
 * The tick is one-backup-per-invocation. External cron cadence
 * controls throughput. See §L.4.
 */
export async function runReplicationWorkerTick(
  opts: ReplicationWorkerOptions = {}
): Promise<ReplicationWorkerRunResult> {
  const start = Date.now();
  const client = opts.client ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const actorId = opts.actorId ?? null;
  const operationId = opts.operationId ?? randomUUID();

  const baseResult: ReplicationWorkerRunResult = {
    outcome: "OK",
    operationId,
    selfHeal: { inserted: 0 },
    watchdog: { reconciled: 0 },
    rehydrated: { count: 0 },
    durationMs: 0
  };

  // ── Fail-closed gates BEFORE any lock is acquired ──────────────────
  if (!isGoogleDriveEnabled()) {
    return {
      ...baseResult,
      outcome: "SKIPPED_DISABLED",
      durationMs: Date.now() - start
    };
  }

  // Config readiness (§Q.3). The gate is passive — no live network I/O.
  let configReady = false;
  try {
    const status = await googleDriveConfigStatus();
    configReady = isGoogleDriveConfigReady(status);
    if (!configReady) {
      await audit({
        userId: actorId,
        action: "backup.replication.worker.skipped",
        entity: "BackupReplicationConfig",
        entityId: "google_drive",
        meta: {
          operationId,
          reason: "SKIPPED_CONFIG_ERROR",
          flag: status.flag,
          credentials: status.credentials,
          folder: status.folder
        }
      });
      return {
        ...baseResult,
        outcome: "SKIPPED_CONFIG_ERROR",
        errorCode: "CONFIGURATION_ERROR",
        durationMs: Date.now() - start
      };
    }
  } catch {
    await audit({
      userId: actorId,
      action: "backup.replication.worker.skipped",
      entity: "BackupReplicationConfig",
      entityId: "google_drive",
      meta: {
        operationId,
        reason: "SKIPPED_CONFIG_ERROR",
        errorClass: "config_status_unavailable"
      }
    }).catch(() => undefined);
    return {
      ...baseResult,
      outcome: "SKIPPED_CONFIG_ERROR",
      errorCode: "CONFIGURATION_ERROR",
      durationMs: Date.now() - start
    };
  }

  // ── Advisory-lock tx: claim one row, do NOT invoke Drive here ──────
  type ClaimResult =
    | { kind: "not_locked" }
    | { kind: "no_work"; selfHealed: number; watchdogReconciled: number; rehydrated: number }
    | {
        kind: "claimed";
        replicationId: string;
        backupId: string;
        selfHealed: number;
        watchdogReconciled: number;
        rehydrated: number;
      };

  let claim: ClaimResult;
  try {
    claim = await client.$transaction(
      async (tx): Promise<ClaimResult> => {
        // 1. Advisory lock. Auto-released at tx end.
        const lockRows = await tx.$queryRaw<
          Array<{ pg_try_advisory_xact_lock: boolean }>
        >`SELECT pg_try_advisory_xact_lock(${REPLICATION_WORKER_LOCK_KEY}::bigint) as pg_try_advisory_xact_lock`;
        const locked = lockRows[0]?.pg_try_advisory_xact_lock === true;
        if (!locked) return { kind: "not_locked" };

        // 2. Self-heal enqueue (§L.2). Bounded. Idempotent via unique
        //    constraint; `skipDuplicates` maps to ON CONFLICT DO NOTHING.
        //    A crashed scheduler that failed to enqueue post-verify
        //    is silently caught here.
        //
        //    We avoid raw SQL for the INSERT so id generation stays on
        //    Prisma's cuid path (`@default(cuid())`) — using
        //    `gen_random_uuid()` in raw SQL would insert UUIDs into a
        //    column the rest of the app treats as cuid-shaped.
        const missing = await tx.backup.findMany({
          where: {
            status: "VERIFIED",
            replications: {
              none: { destination: REPLICATION_DESTINATION }
            }
          },
          select: { id: true },
          take: SELF_HEAL_BATCH_LIMIT,
          orderBy: { startedAt: "asc" }
        });
        let selfHealed = 0;
        if (missing.length > 0) {
          const created = await tx.backupReplication.createMany({
            data: missing.map((b) => ({
              backupId: b.id,
              destination: REPLICATION_DESTINATION,
              status: "PENDING" as const
            })),
            skipDuplicates: true
          });
          selfHealed = created.count;
        }

        // 3. Watchdog: stuck-UPLOADING rows → PENDING so the next
        //    claim picks them up. The uploader itself reconciles the
        //    Drive session via `queryUploadOffset`, so we do not need
        //    to make a Drive call from inside this tx.
        const stuckCutoff = new Date(
          now.getTime() - STUCK_UPLOAD_TIMEOUT_MS
        );
        const watchdogResult = await tx.$queryRaw<
          Array<{ reconciled: number }>
        >`
          WITH reconciled_rows AS (
            UPDATE "BackupReplication"
            SET status = 'PENDING',
                "nextRetryAt" = NOW(),
                "updatedAt" = NOW()
            WHERE id IN (
              SELECT id FROM "BackupReplication"
              WHERE status = 'UPLOADING'
                AND (
                  ("lastAttemptAt" IS NOT NULL AND "lastAttemptAt" < ${stuckCutoff})
                  OR ("lastAttemptAt" IS NULL AND "updatedAt" < ${stuckCutoff})
                )
              LIMIT ${WATCHDOG_BATCH_LIMIT}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id
          )
          SELECT COUNT(*)::int AS reconciled FROM reconciled_rows
        `;
        const watchdogReconciled = watchdogResult[0]?.reconciled ?? 0;

        // 4. Rehydrate due RETRYABLE_FAILURE rows.
        const rehydrateResult = await tx.$queryRaw<
          Array<{ rehydrated: number }>
        >`
          WITH rehydrated_rows AS (
            UPDATE "BackupReplication"
            SET status = 'PENDING',
                "updatedAt" = NOW()
            WHERE id IN (
              SELECT id FROM "BackupReplication"
              WHERE status = 'RETRYABLE_FAILURE'
                AND "nextRetryAt" IS NOT NULL
                AND "nextRetryAt" <= ${now}
              LIMIT ${WATCHDOG_BATCH_LIMIT}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id
          )
          SELECT COUNT(*)::int AS rehydrated FROM rehydrated_rows
        `;
        const rehydrated = rehydrateResult[0]?.rehydrated ?? 0;

        // 5. Claim exactly one PENDING row with SKIP LOCKED. Only rows
        //    whose backing Backup is currently VERIFIED are eligible —
        //    a Backup that has since transitioned to DELETED / MISSING
        //    is dropped from the queue by the uploader anyway
        //    (`SKIPPED_NOT_VERIFIED`), but skipping it here avoids
        //    burning a worker slot on a guaranteed no-op.
        const picked = await tx.$queryRaw<
          Array<{ id: string; backupId: string }>
        >`
          SELECT r.id, r."backupId"
          FROM "BackupReplication" r
          JOIN "Backup" b ON b.id = r."backupId"
          WHERE r.destination = 'GOOGLE_DRIVE'
            AND r.status = 'PENDING'
            AND b.status = 'VERIFIED'
          ORDER BY r."createdAt" ASC
          FOR UPDATE OF r SKIP LOCKED
          LIMIT 1
        `;
        const pickedRow = picked[0];
        if (!pickedRow) {
          return {
            kind: "no_work",
            selfHealed,
            watchdogReconciled,
            rehydrated
          };
        }

        return {
          kind: "claimed",
          replicationId: pickedRow.id,
          backupId: pickedRow.backupId,
          selfHealed,
          watchdogReconciled,
          rehydrated
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15_000,
        maxWait: 5_000
      }
    );
  } catch (err) {
    const { name } = sanitizeGoogleError(err);
    await audit({
      userId: actorId,
      action: "backup.replication.worker.failure",
      entity: "BackupReplication",
      meta: {
        operationId,
        outcome: "INTERNAL",
        stage: "claim_tx",
        errorClass: name
      }
    }).catch(() => undefined);
    return {
      ...baseResult,
      outcome: "INTERNAL",
      errorCode: "INTERNAL",
      durationMs: Date.now() - start
    };
  }

  if (claim.kind === "not_locked") {
    await audit({
      userId: actorId,
      action: "backup.replication.worker.skipped",
      entity: "BackupReplication",
      meta: { operationId, reason: "SKIPPED_LOCKED" }
    });
    return {
      ...baseResult,
      outcome: "SKIPPED_LOCKED",
      durationMs: Date.now() - start
    };
  }

  const enrichedBase: ReplicationWorkerRunResult = {
    ...baseResult,
    selfHeal: { inserted: claim.selfHealed },
    watchdog: { reconciled: claim.watchdogReconciled },
    rehydrated: { count: claim.rehydrated }
  };

  if (claim.kind === "no_work") {
    return {
      ...enrichedBase,
      outcome: "SKIPPED_NO_WORK",
      durationMs: Date.now() - start
    };
  }

  const { replicationId, backupId } = claim;

  // ── Perform the upload OUTSIDE any Prisma transaction. ─────────────
  await audit({
    userId: actorId,
    action: "backup.replication.worker.claim",
    entity: "BackupReplication",
    entityId: replicationId,
    meta: {
      operationId,
      backupId,
      selfHeal: claim.selfHealed,
      watchdog: claim.watchdogReconciled,
      rehydrated: claim.rehydrated
    }
  });

  let result: ReplicateResult;
  try {
    // Resolve deps. Every branch may throw a classified error we route
    // into the audit stream.
    assertGoogleDriveEnabled();
    const cfg = loadGoogleDriveConfig();
    const drive: DriveApi = opts.driveFactory
      ? opts.driveFactory()
      : (getGoogleDriveClient() as unknown as DriveApi);
    const folderId = opts.folderResolver
      ? await opts.folderResolver(drive)
      : await resolveDriveFolderForWorker(drive, cfg);
    const accessToken = opts.accessTokenFactory
      ? await opts.accessTokenFactory()
      : await getGoogleDriveAccessToken();
    const storageDir = opts.storageDir ?? loadBackupStorageDir();
    const files = opts.files ?? defaultFileReader();
    const http = opts.httpFactory ? opts.httpFactory() : defaultHttpClient();
    const chunkBytes = opts.chunkBytesOverride ?? cfg.uploadChunkBytes;
    const httpTimeoutMs = opts.httpTimeoutMsOverride ?? cfg.httpTimeoutMs;

    result = await replicateBackupToDrive(backupId, {
      prisma: client,
      drive,
      http,
      accessToken,
      folderId,
      storageDir,
      files,
      now: () => now,
      chunkBytes,
      httpTimeoutMs
    });
  } catch (err) {
    // Classified failure BEFORE the uploader could touch the row. The
    // row remains PENDING and the next tick will retry — matching the
    // uploader's own retryable-transient semantics but without
    // duplicating its state-machine writes.
    const classified = classifyGoogleErrorForDeps(err);
    await audit({
      userId: actorId,
      action: "backup.replication.worker.failure",
      entity: "BackupReplication",
      entityId: replicationId,
      meta: {
        operationId,
        backupId,
        stage: "deps",
        errorCode: classified.code,
        httpStatus: classified.httpStatus
      }
    }).catch(() => undefined);
    return {
      ...enrichedBase,
      outcome: classified.retryable ? "RETRYABLE" : "FAILED",
      replicationId,
      backupId,
      errorCode: classified.code,
      durationMs: Date.now() - start
    };
  }

  // Map the uploader's outcome → the worker's outcome + audit event.
  const outcome = mapReplicateOutcome(result);
  await audit({
    userId: actorId,
    action: auditActionFor(outcome),
    entity: "BackupReplication",
    entityId: replicationId,
    meta: {
      operationId,
      backupId,
      outcome,
      errorCode: "errorCode" in result ? result.errorCode : undefined,
      remoteBinFileId:
        result.outcome === "COMPLETED" || result.outcome === "SKIPPED_ALREADY_COMPLETED"
          ? result.remoteBinFileId
          : undefined,
      remoteManifestFileId:
        result.outcome === "COMPLETED" || result.outcome === "SKIPPED_ALREADY_COMPLETED"
          ? result.remoteManifestFileId
          : undefined
    }
  }).catch(() => undefined);

  return {
    ...enrichedBase,
    outcome,
    replicationId,
    backupId,
    errorCode:
      outcome === "COMPLETED" || outcome === "OK"
        ? undefined
        : "errorCode" in result
        ? result.errorCode
        : undefined,
    durationMs: Date.now() - start
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function resolveDriveFolderForWorker(
  drive: DriveApi,
  cfg: ReturnType<typeof loadGoogleDriveConfig>
): Promise<string> {
  const row = await defaultPrisma.backupReplicationConfig.findUnique({
    where: { id: "google_drive" },
    select: { folderId: true, folderMarker: true }
  });
  const resolved = await resolveGoogleDriveFolder({
    drive,
    folderIdFromEnv: cfg.folderIdFromEnv,
    dbFolderId: row?.folderId ?? null,
    folderMarker: row?.folderMarker ?? "bis2027-backup-folder-v1"
  });
  return resolved.folderId;
}

function mapReplicateOutcome(
  r: ReplicateResult
): ReplicationWorkerOutcome {
  switch (r.outcome) {
    case "COMPLETED":
    case "SKIPPED_ALREADY_COMPLETED":
      return "COMPLETED";
    case "RETRYABLE":
      return "RETRYABLE";
    case "FAILED":
      return "FAILED";
    case "SKIPPED_NOT_VERIFIED":
      return "SKIPPED_NO_WORK";
  }
}

function auditActionFor(outcome: ReplicationWorkerOutcome): string {
  switch (outcome) {
    case "COMPLETED":
      return "backup.replication.upload.success";
    case "RETRYABLE":
      return "backup.replication.upload.retry";
    case "FAILED":
      return "backup.replication.upload.failure";
    case "SKIPPED_NO_WORK":
      return "backup.replication.worker.skipped";
    default:
      return "backup.replication.worker.failure";
  }
}

function classifyGoogleErrorForDeps(err: unknown): {
  code: string;
  httpStatus: number | null;
  retryable: boolean;
} {
  if (err instanceof GoogleDriveOperationError) {
    return {
      code: err.code,
      httpStatus: err.httpStatus,
      retryable: err.retryable
    };
  }
  const c = classifyGoogleError(err);
  return { code: c.code, httpStatus: c.httpStatus, retryable: c.retryable };
}

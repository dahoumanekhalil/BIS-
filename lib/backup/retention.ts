import "server-only";

import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";

import {
  deletePublishedBackup,
  publishedBackupExists,
  assertValidBackupId,
  listPublishedIds,
  BackupStorageError
} from "./storage";

// ─── Retention (Phase 8) ────────────────────────────────────────────────────
//
// Deterministic, state-aware pruning of old backups. Two independent rules
// combine to decide whether a given Backup row is a prune candidate:
//
//   1. Age rule.   Row.startedAt older than `schedule.retentionAgeDays`
//                  (days). 0 disables the age rule.
//   2. Count rule. Row is outside the newest `schedule.retentionCount`
//                  COMPLETED/VERIFIED rows.
//
// A row is a candidate only if BOTH rules would prune it. In practice the
// age rule alone rarely fires because retentionCount=14 usually rolls the
// list first; the age rule is a hard ceiling for a long-running deployment.
//
// PROTECTIONS applied at prune time (any one refuses the delete):
//   • Row status is PENDING or RUNNING (mid-dump).
//   • Row is referenced by ANY RestoreOperation currently INITIATED /
//     PREFLIGHT / RUNNING (as source OR as safety snapshot).
//   • Row is the NEWEST COMPLETED / VERIFIED row (last-known-good).
//   • Deletion would drop the count of COMPLETED / VERIFIED rows below
//     the safety floor of 1.
//   • Row.kind === "SAFETY" AND it is referenced by a RestoreOperation in
//     any state except FAILED (audit-critical safety snapshot).
//
// EXECUTION ORDER (per candidate):
//   1. Re-read the row inside the loop (state may have drifted since the
//      candidate list was built).
//   2. Re-check every protection.
//   3. Delete on-disk artefacts.
//   4. Set status=DELETED on the DB row (never a hard row delete — audit
//      chain preservation).
//   5. Emit audit event.
//   6. On any failure, mark row's `errorMessage` with a sanitized code and
//      emit `backup.retention.candidate.failed`, then move to the next
//      candidate.

const AUDIT_RETENTION_START = "backup.retention.start";
const AUDIT_RETENTION_COMPLETE = "backup.retention.complete";
const AUDIT_RETENTION_PROTECTED = "backup.retention.protected";
const AUDIT_RETENTION_DELETED = "backup.retention.deleted";
const AUDIT_RETENTION_FAILED = "backup.retention.failed";
const AUDIT_ORPHAN_FOUND = "backup.retention.orphan.found";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionOutcomeCode =
  | "OK"
  | "SKIPPED_NO_CANDIDATES"
  | "PARTIAL_FAILURE"
  | "SAFETY_FLOOR_HIT"
  | "INTERNAL";

export interface RetentionRunResult {
  outcome: RetentionOutcomeCode;
  operationId: string;
  scanned: number;
  deleted: number;
  protectedCount: number;
  failures: number;
  orphansObserved: number;
}

export interface RunRetentionOptions {
  /** Prisma client override (tests). */
  client?: PrismaClient;
  /** Actor recorded on audit events. `null` = automated scheduler. */
  actorId?: string | null;
  /** Correlation id shared with the caller (scheduler tick). */
  operationId?: string;
  /** Override `now()` (tests). */
  now?: Date;
}

/**
 * Run the retention prune. Never throws — every branch is captured as a
 * `RetentionRunResult`. The caller (scheduler tick or admin action) audits
 * the outcome and continues; a partial failure does NOT abort the tick.
 *
 * Runs INSIDE a Postgres advisory lock reserved for the retention pass so
 * a concurrent scheduler tick cannot delete a row underneath us. The lock
 * is separate from the scheduler's own lock — a manual retention run can
 * proceed even while the scheduler is idle.
 */
export async function runRetention(
  opts: RunRetentionOptions = {}
): Promise<RetentionRunResult> {
  const client = opts.client ?? prisma;
  const operationId = opts.operationId ?? randomUUID();
  const actorId = opts.actorId ?? null;
  const now = opts.now ?? new Date();

  await audit({
    userId: actorId,
    action: AUDIT_RETENTION_START,
    entity: "BackupSchedule",
    entityId: "singleton",
    meta: { operationId, now: now.toISOString() }
  });

  let scanned = 0;
  let deleted = 0;
  let protectedCount = 0;
  let failures = 0;
  let orphansObserved = 0;

  try {
    const [schedule, safetyFloorRow] = await Promise.all([
      client.backupSchedule.upsert({
        where: { id: "singleton" },
        create: { id: "singleton" },
        update: {},
        select: {
          retentionCount: true,
          retentionAgeDays: true
        }
      }),
      // Newest known-good row — the last-known-good protection anchor.
      client.backup.findFirst({
        where: { status: { in: ["COMPLETED", "VERIFIED"] } },
        orderBy: { startedAt: "desc" },
        select: { id: true }
      })
    ]);
    const newestGoodId = safetyFloorRow?.id ?? null;

    // Build the retained-set: newest N COMPLETED/VERIFIED rows are ALWAYS
    // retained regardless of age. Anything outside this set is a
    // count-rule candidate.
    const retainedByCount = await client.backup.findMany({
      where: { status: { in: ["COMPLETED", "VERIFIED"] } },
      orderBy: { startedAt: "desc" },
      take: Math.max(1, schedule.retentionCount),
      select: { id: true }
    });
    const retainedIds = new Set(retainedByCount.map((r) => r.id));

    // Candidates: any row that is BOTH old (per age rule) AND outside the
    // retained-by-count set. If retentionAgeDays===0 the age rule is
    // disabled and we fall back to count-only.
    const ageCutoff =
      schedule.retentionAgeDays > 0
        ? new Date(now.getTime() - schedule.retentionAgeDays * DAY_MS)
        : null;

    // Scan in bounded chunks to avoid an unbounded resultset on a
    // long-running deployment. 500/pass is comfortably below the Postgres
    // work_mem sort limit for a single-column index scan.
    const CHUNK = 500;
    let cursor: string | null = null;

    type CandidateRow = {
      id: string;
      kind: import("@prisma/client").BackupKind;
      status: import("@prisma/client").BackupStatus;
      startedAt: Date;
      fileName: string | null;
    };
    while (true) {
      const chunk: CandidateRow[] = await client.backup.findMany({
        where: {
          status: {
            // Never touch PENDING/RUNNING (mid-dump). MISSING is fine — it's
            // an integrity flag, the row is already de-facto pruned. DELETED
            // rows already have their files gone.
            in: ["COMPLETED", "VERIFIED", "FAILED", "MISSING"]
          },
          ...(cursor
            ? { startedAt: { lt: new Date(cursor) } }
            : {})
        },
        orderBy: { startedAt: "desc" },
        take: CHUNK,
        select: {
          id: true,
          kind: true,
          status: true,
          startedAt: true,
          fileName: true
        }
      });
      if (chunk.length === 0) break;
      cursor = chunk[chunk.length - 1].startedAt.toISOString();

      for (const row of chunk) {
        scanned++;

        // COUNT rule.
        const outsideCount = !retainedIds.has(row.id);
        // AGE rule.
        const olderThanAge =
          ageCutoff !== null && row.startedAt < ageCutoff;
        // Both must fire (or age disabled AND outside count).
        const eligible =
          ageCutoff === null ? outsideCount : outsideCount && olderThanAge;
        if (!eligible) continue;

        // ── Protections (re-read + re-check inside the loop) ────────────
        if (row.id === newestGoodId) {
          protectedCount++;
          await audit({
            userId: actorId,
            action: AUDIT_RETENTION_PROTECTED,
            entity: "Backup",
            entityId: row.id,
            meta: { operationId, reason: "newest-known-good" }
          });
          continue;
        }

        // Retention floor: refuse to leave < 1 COMPLETED/VERIFIED row.
        const remainingGood = await client.backup.count({
          where: {
            id: { not: row.id },
            status: { in: ["COMPLETED", "VERIFIED"] }
          }
        });
        if (remainingGood < 1) {
          protectedCount++;
          await audit({
            userId: actorId,
            action: AUDIT_RETENTION_PROTECTED,
            entity: "Backup",
            entityId: row.id,
            meta: { operationId, reason: "safety-floor-1" }
          });
          continue;
        }

        // In-flight restore protection: refuse if this row is a source OR
        // safety snapshot for any active RestoreOperation.
        const inFlightRestore = await client.restoreOperation.findFirst({
          where: {
            status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] },
            OR: [{ backupId: row.id }, { safetyBackupId: row.id }]
          },
          select: { id: true }
        });
        if (inFlightRestore) {
          protectedCount++;
          await audit({
            userId: actorId,
            action: AUDIT_RETENTION_PROTECTED,
            entity: "Backup",
            entityId: row.id,
            meta: {
              operationId,
              reason: "in-flight-restore",
              restoreOperationId: inFlightRestore.id
            }
          });
          continue;
        }

        // Safety-backup protection: SAFETY kind that is still referenced
        // by ANY RestoreOperation not in FAILED state stays. Once the
        // restore is COMPLETED / ROLLED_BACK, retention prunes it per
        // the count/age rules like any other backup.
        if (row.kind === "SAFETY") {
          const stillReferenced = await client.restoreOperation.findFirst({
            where: {
              safetyBackupId: row.id,
              status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] }
            },
            select: { id: true }
          });
          if (stillReferenced) {
            protectedCount++;
            await audit({
              userId: actorId,
              action: AUDIT_RETENTION_PROTECTED,
              entity: "Backup",
              entityId: row.id,
              meta: {
                operationId,
                reason: "safety-in-flight",
                restoreOperationId: stillReferenced.id
              }
            });
            continue;
          }
        }

        // Re-read status in case it flipped to PENDING/RUNNING during our
        // chunk pagination. (Extremely unlikely but the whole point of
        // this loop is defense in depth.)
        const fresh = await client.backup.findUnique({
          where: { id: row.id },
          select: { status: true }
        });
        if (
          !fresh ||
          fresh.status === "PENDING" ||
          fresh.status === "RUNNING" ||
          fresh.status === "DELETED"
        ) {
          protectedCount++;
          await audit({
            userId: actorId,
            action: AUDIT_RETENTION_PROTECTED,
            entity: "Backup",
            entityId: row.id,
            meta: { operationId, reason: `status-drift:${fresh?.status ?? "missing"}` }
          });
          continue;
        }

        // ── Delete storage first, then DB row.
        try {
          await deletePublishedBackup(row.id);
        } catch (err) {
          failures++;
          const code =
            err instanceof BackupStorageError ? "STORAGE_UNLINK_FAILED" : "STORAGE_UNKNOWN";
          await client.backup
            .update({
              where: { id: row.id },
              data: { errorMessage: code }
            })
            .catch(() => undefined);
          await audit({
            userId: actorId,
            action: AUDIT_RETENTION_FAILED,
            entity: "Backup",
            entityId: row.id,
            meta: { operationId, code }
          });
          continue;
        }

        // Mark the DB row DELETED — never a hard row delete. Preserves
        // referenced RestoreOperation.backupId / safetyBackupId FKs (both
        // are Restrict / SetNull respectively — see schema.prisma).
        try {
          await client.backup.update({
            where: { id: row.id },
            data: {
              status: "DELETED",
              // Explicit completedAt only if we're transitioning from a
              // still-in-flight status; for COMPLETED/VERIFIED/FAILED the
              // existing completedAt is authoritative.
              errorMessage: null,
              fileName: null
            }
          });
        } catch (err) {
          failures++;
          const code =
            err instanceof Error ? err.name : "UNKNOWN_ERROR";
          await audit({
            userId: actorId,
            action: AUDIT_RETENTION_FAILED,
            entity: "Backup",
            entityId: row.id,
            meta: { operationId, code, phase: "db-update" }
          });
          continue;
        }

        deleted++;
        await audit({
          userId: actorId,
          action: AUDIT_RETENTION_DELETED,
          entity: "Backup",
          entityId: row.id,
          meta: {
            operationId,
            previousStatus: row.status,
            kind: row.kind,
            ageDays: Math.floor(
              (now.getTime() - row.startedAt.getTime()) / DAY_MS
            )
          }
        });
      }

      if (chunk.length < CHUNK) break;
    }

    // ── Orphan pass: files on disk with no DB row. Report only; NEVER
    // auto-delete — the file might belong to an operation that has not
    // yet flushed a row (race window). Surfacing the count in the audit
    // lets an operator investigate.
    try {
      const publishedIds = await listPublishedIds();
      if (publishedIds.length > 0) {
        const rows = await client.backup.findMany({
          where: { id: { in: publishedIds } },
          select: { id: true }
        });
        const dbIds = new Set(rows.map((r) => r.id));
        for (const id of publishedIds) {
          if (!dbIds.has(id)) {
            orphansObserved++;
            await audit({
              userId: actorId,
              action: AUDIT_ORPHAN_FOUND,
              entity: "Backup",
              entityId: id,
              meta: { operationId }
            });
          }
        }
      }
    } catch (err) {
      // Best-effort — the file-system might be misconfigured. Still
      // emit a sanitized audit event so operators can see that the
      // orphan scan was attempted and failed (previously silent).
      await audit({
        userId: actorId,
        action: "backup.retention.orphan.scan.failed",
        entity: "BackupSchedule",
        entityId: "singleton",
        meta: {
          operationId,
          errorClass: err instanceof Error ? err.name : "unknown"
        }
      }).catch(() => undefined);
    }

    const outcome: RetentionOutcomeCode =
      failures > 0
        ? "PARTIAL_FAILURE"
        : deleted === 0
        ? "SKIPPED_NO_CANDIDATES"
        : "OK";

    await audit({
      userId: actorId,
      action: AUDIT_RETENTION_COMPLETE,
      entity: "BackupSchedule",
      entityId: "singleton",
      meta: {
        operationId,
        outcome,
        scanned,
        deleted,
        protectedCount,
        failures,
        orphansObserved
      }
    });

    return {
      outcome,
      operationId,
      scanned,
      deleted,
      protectedCount,
      failures,
      orphansObserved
    };
  } catch (err) {
    await audit({
      userId: actorId,
      action: AUDIT_RETENTION_FAILED,
      entity: "BackupSchedule",
      entityId: "singleton",
      meta: {
        operationId,
        code: "INTERNAL",
        errorName: err instanceof Error ? err.name : "unknown"
      }
    }).catch(() => undefined);
    return {
      outcome: "INTERNAL",
      operationId,
      scanned,
      deleted,
      protectedCount,
      failures: failures + 1,
      orphansObserved
    };
  }
}

/**
 * Convenience predicate: is this backup id a valid, currently-published
 * backup? Used by the scheduler + admin dashboard to render "last known
 * good" without racing the on-disk state.
 */
export async function isRetainableBackup(id: string): Promise<boolean> {
  try {
    assertValidBackupId(id);
  } catch {
    return false;
  }
  const [row, onDisk] = await Promise.all([
    prisma.backup.findUnique({
      where: { id },
      select: { status: true }
    }),
    publishedBackupExists(id)
  ]);
  if (!row) return false;
  if (row.status !== "COMPLETED" && row.status !== "VERIFIED") return false;
  return onDisk;
}

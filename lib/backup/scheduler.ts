import "server-only";

import { randomUUID } from "crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";

import { runBackupDump, BackupDumpError } from "./dump";
import { verifyBackup } from "./verify";
import { runRetention } from "./retention";
import { sweepStaleStaging } from "./storage";
import {
  enqueueReplicationForBackup,
  runReplicationWorkerTick
} from "./replication/worker";

// ─── Scheduler tick (Phase 8) ───────────────────────────────────────────────
//
// Called by the external cron endpoint (`app/api/internal/backup/tick/`)
// and by the manual "run now" admin action. Every invocation:
//
//   1. Acquires a Postgres TRANSACTION-scoped advisory lock via
//      `pg_try_advisory_xact_lock(SCHEDULER_LOCK_KEY)` — held for the
//      duration of the preflight tx only (the dump itself runs OUTSIDE
//      the lock; see step 5). Any concurrent cron replay / manual
//      invocation that races the preflight returns immediately with
//      outcome `SKIPPED_LOCKED` and does NOT create a duplicate backup.
//      Once the preflight tx commits with `lastRunAt=now,
//      lastRunOutcome=RUNNING`, any subsequent tick sees
//      `SKIPPED_NOT_DUE` (or a stuck-RUNNING watchdog trip; see below).
//   2. Re-reads `BackupSchedule` inside the lock. If disabled → SKIPPED_DISABLED.
//   3. Refuses if any Backup is currently PENDING/RUNNING → SKIPPED_ACTIVE.
//   4. Computes "due" from persisted state:
//        due iff (lastRunAt === null) OR (now - lastRunAt >= frequency).
//      Cron retries within the frequency window see `not due` and skip.
//   5. If due, calls `runBackupDump({ kind: "SCHEDULED" })`, then
//      `verifyBackup(persist=true)` — a dump that fails verification is
//      recorded as FAILURE, not SUCCESS.
//   6. Runs `runRetention()` AFTER a successful backup — so the new
//      known-good row is in place before any prune candidate is
//      considered. If the backup step failed, retention is skipped this
//      tick (never prune when we just failed to produce a fresh backup).
//   7. Updates `BackupSchedule` with lastRunAt / lastRunOutcome /
//      lastRunError / lastRunBackupId, then releases the advisory lock.
//   8. Best-effort `sweepStaleStaging` — cleans up files older than 1h
//      left by crashed dumps.
//
// BOUNDED CATCH-UP: after an outage, this loop creates AT MOST ONE backup
// per tick invocation. External cron runs every N minutes (documented in
// the README); a 24h outage produces a single catch-up backup on the
// next successful tick, not 96 backups.
//
// TIME SEMANTICS: `frequencyHours` is compared in monotonic UTC
// milliseconds. Server clock changes affect this comparison the same way
// they affect the OS cron — documented as an operator responsibility.
// Never uses local server time; JS `Date` is UTC-anchored via
// `Date.now()`.

// pg_try_advisory_xact_lock() takes a bigint key. Reserved constant — do
// not change this value once released; a change would let a legacy
// connection hold the old key while a fresh one holds the new one,
// allowing two concurrent scheduler ticks. If ever reassigned, coordinate
// a full deployment restart.
//
// Value chosen to fit well outside signed int32 range (>2^31-1). That
// avoids ambiguity with the two-arg overload `pg_try_advisory_xact_lock(
// int, int)` — a future contributor cannot accidentally reuse this key
// via the int32 pair form without decomposing it explicitly. Rendered as
// hex to make the "clearly not accidentally a small int" property
// visually obvious.
const SCHEDULER_LOCK_KEY = 0x4249_5332_3032_37_01n; // "BIS2027\x01"
const SCHEDULE_ID = "singleton";

// A tick that has been RUNNING for longer than this ceiling is presumed
// abandoned (process died between the "RUNNING" marker tx and the final
// state update). The next tick reconciles it to `FAILED_INTERNAL` before
// its own preflight so a crashed dump never blocks scheduling forever.
// Chosen to comfortably exceed the dump timeout (30 min default, 2h max)
// plus a safety margin.
const STUCK_RUNNING_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3h
const STUCK_RUNNING_OUTCOME = "FAILED_INTERNAL_STUCK";

export type SchedulerOutcome =
  | "OK"
  | "SKIPPED_LOCKED"
  | "SKIPPED_DISABLED"
  | "SKIPPED_ACTIVE"
  | "SKIPPED_NOT_DUE"
  | "FAILED_DUMP"
  | "FAILED_VERIFY"
  | "INTERNAL";

export interface SchedulerRunResult {
  outcome: SchedulerOutcome;
  operationId: string;
  backupId?: string;
  retention?: {
    outcome: string;
    scanned: number;
    deleted: number;
    protectedCount: number;
    failures: number;
    orphansObserved: number;
  };
  /** Sanitized failure code (never a raw exception message). */
  errorCode?: string;
  /** Elapsed ms. */
  durationMs: number;
}

export interface RunSchedulerTickOptions {
  client?: PrismaClient;
  now?: Date;
  /** Actor recorded on audit rows. Null for external cron. */
  actorId?: string | null;
  /** Correlation id for the audit chain (also carried into retention). */
  operationId?: string;
  /**
   * Manual invocation from the admin UI. Skips the "not due" gate so
   * the operator can force an immediate run regardless of frequency.
   * ALL other protections (concurrency lock, active-backup refusal,
   * disabled schedule) remain intact.
   */
  manual?: boolean;
}

/**
 * Execute one scheduler tick. NEVER throws — every branch returns a
 * `SchedulerRunResult`. Audits every outcome and updates schedule state.
 */
export async function runSchedulerTick(
  opts: RunSchedulerTickOptions = {}
): Promise<SchedulerRunResult> {
  const start = Date.now();
  const client = opts.client ?? prisma;
  const operationId = opts.operationId ?? randomUUID();
  const now = opts.now ?? new Date();
  const actorId = opts.actorId ?? null;
  const manual = opts.manual === true;

  await audit({
    userId: actorId,
    action: manual ? "backup.scheduler.manual" : "backup.scheduler.tick",
    entity: "BackupSchedule",
    entityId: SCHEDULE_ID,
    meta: { operationId, now: now.toISOString() }
  });

  // ── Watchdog: reconcile a schedule stuck in RUNNING ───────────────────
  // If the previous tick's Node process died between recording
  // `lastRunOutcome=RUNNING` and its terminal update, the schedule row
  // is stuck at RUNNING. Without this reconciliation the next tick would
  // see `lastRunAt=stuck-time` and either treat it as "not due" (silent
  // wedge) or race a phantom dump. We flip stuck rows to
  // `FAILED_INTERNAL_STUCK` here — audited — BEFORE contending for the
  // advisory lock. Only touches rows that have been RUNNING for longer
  // than the dump ceiling; a healthy in-flight tick is untouched.
  try {
    const stuck = await client.backupSchedule.updateMany({
      where: {
        id: SCHEDULE_ID,
        lastRunOutcome: "RUNNING",
        lastRunAt: {
          lt: new Date(now.getTime() - STUCK_RUNNING_TIMEOUT_MS)
        }
      },
      data: {
        lastRunOutcome: STUCK_RUNNING_OUTCOME,
        lastRunError: "watchdog: no terminal update within timeout"
      }
    });
    if (stuck.count > 0) {
      await audit({
        userId: actorId,
        action: "backup.scheduler.watchdog.reconciled",
        entity: "BackupSchedule",
        entityId: SCHEDULE_ID,
        meta: { operationId, count: stuck.count }
      });
    }
  } catch {
    // Non-fatal — the watchdog is a best-effort convenience. A stuck
    // RUNNING will still be surfaced in the admin dashboard and can be
    // manually reset via the update-schedule action.
  }

  // ── 1. Concurrency lock (pg_try_advisory_xact_lock inside a tx) ────────
  return client.$transaction(
    async (tx): Promise<SchedulerRunResult> => {
      // pg_try_advisory_xact_lock returns true if the lock is obtained,
      // false if already held. Automatically released at tx end (commit
      // or rollback). This is the SAFE choice — a plain
      // pg_advisory_lock would block indefinitely, tying up a connection.
      const lockRows = await tx.$queryRaw<
        Array<{ pg_try_advisory_xact_lock: boolean }>
      >`SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK_KEY}::bigint) as pg_try_advisory_xact_lock`;
      const locked = lockRows[0]?.pg_try_advisory_xact_lock === true;
      if (!locked) {
        // Another tick is running. Do NOT touch schedule state — that
        // belongs to the tick that owns the lock.
        await audit({
          userId: actorId,
          action: "backup.scheduler.skipped",
          entity: "BackupSchedule",
          entityId: SCHEDULE_ID,
          meta: { operationId, reason: "SKIPPED_LOCKED" }
        });
        return {
          outcome: "SKIPPED_LOCKED",
          operationId,
          durationMs: Date.now() - start
        };
      }

      // ── 2. Re-read schedule inside the lock ────────────────────────────
      const schedule = await tx.backupSchedule.upsert({
        where: { id: SCHEDULE_ID },
        create: { id: SCHEDULE_ID },
        update: {},
        select: {
          enabled: true,
          frequencyHours: true,
          lastRunAt: true
        }
      });

      if (!schedule.enabled && !manual) {
        await tx.backupSchedule.update({
          where: { id: SCHEDULE_ID },
          data: {
            lastRunAt: now,
            lastRunOutcome: "SKIPPED_DISABLED",
            lastRunError: null,
            lastRunBackupId: null
          }
        });
        await audit({
          userId: actorId,
          action: "backup.scheduler.skipped",
          entity: "BackupSchedule",
          entityId: SCHEDULE_ID,
          meta: { operationId, reason: "SKIPPED_DISABLED" }
        });
        return {
          outcome: "SKIPPED_DISABLED",
          operationId,
          durationMs: Date.now() - start
        };
      }

      // ── 3. Active-backup guard ─────────────────────────────────────────
      const activeBackup = await tx.backup.findFirst({
        where: { status: { in: ["PENDING", "RUNNING"] } },
        select: { id: true }
      });
      if (activeBackup) {
        // Do NOT mark this as the "last run" — a concurrent operation
        // is authoritative for schedule bookkeeping.
        await audit({
          userId: actorId,
          action: "backup.scheduler.skipped",
          entity: "BackupSchedule",
          entityId: SCHEDULE_ID,
          meta: {
            operationId,
            reason: "SKIPPED_ACTIVE",
            blockingBackupId: activeBackup.id
          }
        });
        return {
          outcome: "SKIPPED_ACTIVE",
          operationId,
          durationMs: Date.now() - start
        };
      }

      // Also refuse if a restore is in flight — creating a scheduled
      // backup while a restore is executing would either race the
      // destructive apply or (worse) capture a half-restored DB state.
      const activeRestore = await tx.restoreOperation.findFirst({
        where: {
          status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] }
        },
        select: { id: true }
      });
      if (activeRestore) {
        await audit({
          userId: actorId,
          action: "backup.scheduler.skipped",
          entity: "BackupSchedule",
          entityId: SCHEDULE_ID,
          meta: {
            operationId,
            reason: "SKIPPED_ACTIVE",
            blockingRestoreId: activeRestore.id
          }
        });
        return {
          outcome: "SKIPPED_ACTIVE",
          operationId,
          durationMs: Date.now() - start
        };
      }

      // ── 4. Due detection ───────────────────────────────────────────────
      const frequencyMs =
        schedule.frequencyHours * 60 * 60 * 1000;
      const due =
        manual ||
        schedule.lastRunAt === null ||
        now.getTime() - schedule.lastRunAt.getTime() >= frequencyMs;
      if (!due) {
        await audit({
          userId: actorId,
          action: "backup.scheduler.skipped",
          entity: "BackupSchedule",
          entityId: SCHEDULE_ID,
          meta: {
            operationId,
            reason: "SKIPPED_NOT_DUE",
            lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
            frequencyMs
          }
        });
        return {
          outcome: "SKIPPED_NOT_DUE",
          operationId,
          durationMs: Date.now() - start
        };
      }

      // ── 5. Dump ────────────────────────────────────────────────────────
      // NOTE: runBackupDump uses the module-level prisma client, not `tx`.
      // A backup dump takes many seconds to minutes and MUST NOT run
      // inside our short advisory-lock transaction (would hold the lock
      // AND a DB connection for the entire dump). We release the lock
      // (return from the tx) AFTER updating schedule state, but the dump
      // itself runs OUTSIDE this tx via the outer client.
      // Design: we compute the dump command inside the lock (so no
      // concurrent tick can also decide to dump), then release the lock
      // BEFORE dumping. Since we set lastRunAt=now atomically before
      // release, any parallel tick will see "not due" and skip.
      //
      // We mark the schedule optimistically-in-progress by setting
      // lastRunAt=now with lastRunOutcome="RUNNING". The outer function
      // then transitions it to SUCCESS/FAILURE after the dump completes.
      await tx.backupSchedule.update({
        where: { id: SCHEDULE_ID },
        data: {
          lastRunAt: now,
          lastRunOutcome: "RUNNING",
          lastRunError: null,
          lastRunBackupId: null
        }
      });
      // Advisory lock releases when this tx commits (i.e., on `return`).
      return { outcome: "OK" as const, operationId, durationMs: 0 } as SchedulerRunResult;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10_000,
      maxWait: 5_000
    }
  ).then(async (preflight) => {
    // If the preflight tx already decided to skip, return without dumping.
    if (preflight.outcome !== "OK") {
      return preflight;
    }

    // ── 5b. Perform the dump OUTSIDE the advisory-lock tx ────────────────
    let backupId: string | undefined;
    let errorCode: string | undefined;
    let outcome: SchedulerOutcome = "OK";
    try {
      const dump = await runBackupDump({
        kind: "SCHEDULED",
        client
      });
      backupId = dump.backupId;
    } catch (err) {
      outcome = "FAILED_DUMP";
      errorCode =
        err instanceof BackupDumpError ? "DUMP_FAILED" : "INTERNAL";
    }

    // ── 5c. Verify the freshly-created backup ────────────────────────────
    if (outcome === "OK" && backupId) {
      try {
        const verify = await verifyBackup({
          backupId,
          persist: true,
          verifiedById: actorId ?? undefined
        });
        if (verify.outcome !== "VERIFIED") {
          outcome = "FAILED_VERIFY";
          errorCode = verify.code;
        }
      } catch {
        outcome = "FAILED_VERIFY";
        errorCode = "INTERNAL";
      }
    }

    // ── 5d. Google Drive off-site replication enqueue (Layer L.1) ────────
    // Runs AFTER verify succeeds, OUTSIDE the advisory-lock tx (that tx
    // already committed above). This is a single INSERT — no Drive I/O,
    // no OAuth call. `enqueueReplicationForBackup` is defensive: it
    // never throws, and it silently no-ops when replication is
    // disabled (so a pre-config deployment stays quiet).
    //
    // A failure of this INSERT does NOT fail the scheduler tick — the
    // local Backup is already VERIFIED and independently valid. The
    // replication worker's own self-heal SQL scans for VERIFIED
    // backups lacking a replication row on every tick, so a missed
    // enqueue is picked up automatically without operator action.
    if (outcome === "OK" && backupId) {
      await enqueueReplicationForBackup({
        backupId,
        client,
        actorId,
        operationId
      });

      // ── 5e. Best-effort inline replication worker tick (Layer L.3) ────
      // The plan lists three callers of `runReplicationWorkerTick`:
      //   1. the internal cron endpoint,
      //   2. the manual "Retry replication" admin action (Layer P),
      //   3. THIS post-verify inline invocation.
      //
      // Runs OUTSIDE the scheduler's advisory-lock tx (that tx already
      // committed in the .then() boundary above). Its own advisory
      // lock is distinct (0x…02n vs the scheduler's 0x…01n) so it can
      // never contend for the scheduler's lock.
      //
      // Best-effort discipline:
      //   * `runReplicationWorkerTick` itself never throws — every
      //     branch returns a sanitized result. We still wrap the call
      //     in try/catch as belt-and-braces so a bug that DID escape
      //     the worker's own contract cannot fail the scheduler tick.
      //   * A failure or SKIPPED_LOCKED outcome is silently ignored:
      //     the cron endpoint and next scheduler tick will retry.
      //   * Drive latency is bounded by the worker's own httpTimeoutMs
      //     (default 90s) — the operator's cron cadence controls
      //     overall scheduling.
      //   * Local backup + verify success is ALREADY audited above;
      //     inline replication is a DR-oriented convenience, not part
      //     of the local-backup success contract.
      try {
        await runReplicationWorkerTick({
          client,
          actorId,
          operationId
        });
      } catch (err) {
        // Never surface. Local backup already succeeded and is
        // independently valid.
        //
        // G10 LOW-1: still emit a best-effort audit row so a hypothetical
        // regression that violated `runReplicationWorkerTick`'s
        // never-throws contract becomes observable to operators. No
        // message body, no stack — same discipline as the outer scheduler
        // failure audit at the end of this file (line ~528).
        await audit({
          userId: actorId,
          action: "backup.scheduler.replication.inline_error",
          entity: "BackupSchedule",
          entityId: SCHEDULE_ID,
          meta: {
            operationId,
            errorClass: err instanceof Error ? err.name : "primitive"
          }
        }).catch(() => undefined);
      }
    }

    // ── 6. Retention (only after successful backup + verify) ─────────────
    let retention: SchedulerRunResult["retention"];
    if (outcome === "OK") {
      const r = await runRetention({
        client,
        actorId,
        operationId,
        now
      });
      retention = {
        outcome: r.outcome,
        scanned: r.scanned,
        deleted: r.deleted,
        protectedCount: r.protectedCount,
        failures: r.failures,
        orphansObserved: r.orphansObserved
      };
    }

    // ── 7. Update schedule state ─────────────────────────────────────────
    await client.backupSchedule.update({
      where: { id: SCHEDULE_ID },
      data: {
        lastRunOutcome: outcome,
        lastRunError: errorCode ?? null,
        lastRunBackupId: backupId ?? null
      }
    });

    // ── 8. Sweep stale staging files (best effort) ────────────────────────
    try {
      await sweepStaleStaging();
    } catch {
      // Non-fatal.
    }

    await audit({
      userId: actorId,
      action:
        outcome === "OK"
          ? "backup.scheduler.success"
          : "backup.scheduler.failure",
      entity: "BackupSchedule",
      entityId: SCHEDULE_ID,
      meta: {
        operationId,
        outcome,
        backupId,
        errorCode,
        retention
      }
    });

    return {
      outcome,
      operationId,
      backupId,
      retention,
      errorCode,
      durationMs: Date.now() - start
    };
  }).catch(async (err) => {
    // The advisory-lock tx itself failed. Audit + return a sanitized shape.
    await audit({
      userId: actorId,
      action: "backup.scheduler.failure",
      entity: "BackupSchedule",
      entityId: SCHEDULE_ID,
      meta: {
        operationId,
        outcome: "INTERNAL",
        errorClass: err instanceof Error ? err.name : "primitive"
      }
    }).catch(() => undefined);
    return {
      outcome: "INTERNAL" as const,
      operationId,
      errorCode: "INTERNAL",
      durationMs: Date.now() - start
    };
  });
}

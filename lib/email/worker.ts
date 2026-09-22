import "server-only";

import { EmailStatus, type EmailMessage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendOutboxRow } from "./service";

// ─── Cursor-based email worker ───────────────────────────────────────────
//
// Claims QUEUED rows one-by-one using PostgreSQL's
// `SELECT … FOR UPDATE SKIP LOCKED`, so two concurrent workers (e.g. an
// external cron tick landing at the same time as an inline fire-and-forget
// call) do not each try to send the same row. Rows in "not due yet" state
// (nextAttemptAt in the future) are ignored — the worker only picks rows
// whose backoff window has elapsed.
//
// The claim is intentionally an in-transaction SET of status→QUEUED (no
// change) purely to acquire the row lock and mark it "in flight" through
// `nextAttemptAt = now + inFlightGraceMs`, so if the process crashes mid-
// send the row becomes eligible again after the grace window instead of
// being locked forever.

const CLAIM_BATCH_SIZE = 25;
const IN_FLIGHT_GRACE_MS = 5 * 60 * 1000; // 5 min — safe for a crashed pod
const STALE_QUEUED_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (spec)

let staleCleanupDoneAt = 0;
const STALE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

// Prevents overlapping runs in a single process. A cron tick landing while
// another one is still working joins the in-flight promise instead of
// racing. When a caller invokes processQueue() while a tick is already
// running (e.g. queueTemplatedEmail() -> kickWorkerAsync() while a
// previous tick is still sending), we mark `followUpScheduled` so a fresh
// tick runs as soon as the current one finishes — otherwise a row
// inserted after the running tick claimed its batch would sit QUEUED
// until the next external cron.
let runningPromise: Promise<TickResult> | null = null;
let followUpScheduled = false;

export type TickResult = {
  processed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
  cleanedStale: number;
  claimed: number;
};

/**
 * Run one worker tick. Safe to call concurrently — overlapping calls join
 * the in-flight promise instead of racing, AND a follow-up tick is
 * automatically scheduled so any row inserted while the current tick was
 * running does not wait for the next external cron.
 *
 * Never throws.
 */
export async function processQueue(): Promise<TickResult> {
  if (runningPromise) {
    // A tick is already in progress. It may have already claimed its
    // batch, so a row inserted just now would not be picked up. Schedule
    // one follow-up tick after the current one finishes.
    followUpScheduled = true;
    return runningPromise;
  }
  return startTick();
}

function startTick(): Promise<TickResult> {
  const promise = runOnce().finally(() => {
    runningPromise = null;
    if (followUpScheduled) {
      followUpScheduled = false;
      // Fire-and-forget: chain another tick. Any awaiter of the current
      // tick has already received its result; the follow-up covers rows
      // that arrived mid-flight.
      startTick().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[email.worker] follow-up tick failed", err);
      });
    }
  });
  runningPromise = promise;
  return promise;
}

/**
 * Test-only: await the current tick AND any chained follow-up ticks, so
 * a test can assert on final row state without polling. Bounded by an
 * iteration cap so a runaway follow-up loop can't hang the suite.
 */
export async function drainQueueForTests(): Promise<TickResult> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("drainQueueForTests must not be called in production");
  }
  let last = await processQueue();
  let guard = 0;
  while ((runningPromise || followUpScheduled) && guard < 20) {
    guard += 1;
    if (runningPromise) {
      last = await runningPromise;
    }
  }
  return last;
}

async function runOnce(): Promise<TickResult> {
  const cleanedStale = await maybeCleanupStale();
  const rows = await claimBatch(CLAIM_BATCH_SIZE);
  const result: TickResult = {
    processed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    cleanedStale,
    claimed: rows.length
  };
  for (const row of rows) {
    try {
      const outcome = await sendOutboxRow(row);
      result.processed += 1;
      switch (outcome.kind) {
        case "sent":
        case "log-only":
          result.sent += 1;
          break;
        case "retryable":
          result.retried += 1;
          break;
        case "permanent":
        case "off":
        case "blocked-by-allowlist":
        case "not-configured":
          result.failed += 1;
          break;
        default:
          result.skipped += 1;
      }
    } catch (err) {
      // Defensive: sendOutboxRow already writes outcome fields. If it
      // does throw (e.g. DB blip), release the claim so a later tick can
      // retry, rather than leaving the row locked for the grace window.
      // eslint-disable-next-line no-console
      console.error("[email.worker] unexpected error while processing row", row.id, err);
      await prisma.emailMessage
        .updateMany({
          where: { id: row.id, status: EmailStatus.QUEUED },
          data: { nextAttemptAt: new Date(Date.now() + 60_000) }
        })
        .catch(() => undefined);
    }
  }
  return result;
}

/**
 * Claim up to `batchSize` rows atomically via SELECT … FOR UPDATE SKIP
 * LOCKED. Returns the claimed rows in creation order. Rows that other
 * workers are already processing (locked) are skipped.
 */
async function claimBatch(batchSize: number): Promise<EmailMessage[]> {
  const now = new Date();
  const inFlightUntil = new Date(now.getTime() + IN_FLIGHT_GRACE_MS);

  // Two-step claim inside a single transaction: pick eligible ids under
  // SKIP LOCKED, then bump nextAttemptAt so the row is off the pickable
  // set until we finish (or grace window elapses).
  return prisma.$transaction(async (tx) => {
    // Note: parameterised via Prisma's tagged template.
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM "EmailMessage"
      WHERE "status" = 'QUEUED'
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    if (claimed.length === 0) return [];
    const ids = claimed.map((r) => r.id);
    await tx.emailMessage.updateMany({
      where: { id: { in: ids } },
      data: { nextAttemptAt: inFlightUntil }
    });
    return tx.emailMessage.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: "asc" }
    });
  });
}

/**
 * Reset QUEUED rows older than 7 days to FAILED with the standardized
 * reason (approval spec §3). Runs at most once every 24 hours per process.
 * Idempotent — a re-run simply sees zero rows to update. Called at the
 * start of each tick so first-tick after deploy performs the cleanup, and
 * subsequent ticks stay cheap.
 */
async function maybeCleanupStale(): Promise<number> {
  const now = Date.now();
  if (now - staleCleanupDoneAt < STALE_CLEANUP_INTERVAL_MS) return 0;
  staleCleanupDoneAt = now;
  const cutoff = new Date(now - STALE_QUEUED_CUTOFF_MS);
  const res = await prisma.emailMessage.updateMany({
    where: {
      status: EmailStatus.QUEUED,
      createdAt: { lt: cutoff }
    },
    data: {
      status: EmailStatus.FAILED,
      errorMessage:
        "Stale queued email — automatically invalidated before email worker activation.",
      lastError:
        "Stale queued email — automatically invalidated before email worker activation.",
      nextAttemptAt: null
    }
  });
  if (res.count > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[email.worker] Marked ${res.count} stale QUEUED row(s) as FAILED (>7 days old).`);
  }
  return res.count;
}

/**
 * Fire-and-forget helper — invoked by queueTemplatedEmail() after an
 * insert so a small number of emails delivered during a low-traffic
 * period do not wait for the next cron tick. Deliberately catches any
 * error so the caller's request cannot fail because delivery failed.
 */
export function kickWorkerAsync(): void {
  // Do not await. The caller's response returns immediately.
  processQueue().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[email.worker] background tick failed", err);
  });
}

/**
 * Test-only reset for the stale-cleanup gate. Never exported to production
 * import paths; guarded by NODE_ENV so a stray import cannot re-arm it in
 * a live deployment.
 */
export function __resetStaleCleanupGateForTests(): void {
  if (process.env.NODE_ENV === "production") return;
  staleCleanupDoneAt = 0;
}

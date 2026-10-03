import { NextResponse } from "next/server";

import { isBackupTickAuthorized } from "@/lib/backup/tick-auth";
import { runReplicationWorkerTick } from "@/lib/backup/replication/worker";

// ─── Google Drive replication worker tick endpoint (Layer G) ──────────
//
// Invoked by an external scheduler on its own cadence, independent of
// the local backup scheduler tick. Protected by the SAME shared secret
// as the backup tick endpoint (`INTERNAL_BACKUP_TICK_SECRET`) — the
// two endpoints share a trust boundary because both are called by the
// same operator-owned cron. Compared in constant time by
// `isBackupTickAuthorized`. The secret is never logged, never surfaced
// in an error message, and never returned in a response body.
//
// Never fails destructively:
//   * A caller without the header gets a uniform 404 — the endpoint's
//     existence is not confirmed to unauthenticated traffic.
//   * A worker tick that hits an internal error returns a terse JSON
//     body with no filesystem paths, no SQL, no stack traces. Incident
//     detail lives in the audit log, correlated by `operationId`.
//   * The worker is disabled-by-default via
//     `GOOGLE_DRIVE_BACKUP_ENABLED`. Hitting this endpoint while
//     replication is off returns `SKIPPED_DISABLED`, so an operator
//     who forgot to disable the cron does not see a red 500 loop.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isBackupTickAuthorized(req)) {
    return new NextResponse("Not found", { status: 404 });
  }
  try {
    const result = await runReplicationWorkerTick({ actorId: null });
    // Only safe fields. Never expose the raw Drive folderId or Drive
    // file ids to the tick response — they belong to the audit log,
    // not to an operator-scoped health check.
    return NextResponse.json({
      ok:
        result.outcome === "OK" ||
        result.outcome === "COMPLETED" ||
        result.outcome === "RETRYABLE" ||
        result.outcome.startsWith("SKIPPED"),
      outcome: result.outcome,
      operationId: result.operationId,
      selfHealInserted: result.selfHeal.inserted,
      watchdogReconciled: result.watchdog.reconciled,
      rehydrated: result.rehydrated.count,
      durationMs: result.durationMs
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[backup.replicate.tick] unexpected error",
      err instanceof Error ? err.name : "unknown"
    );
    return NextResponse.json(
      { ok: false, outcome: "INTERNAL" },
      { status: 500 }
    );
  }
}

export async function HEAD(req: Request) {
  if (!isBackupTickAuthorized(req)) {
    return new NextResponse(null, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

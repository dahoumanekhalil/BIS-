import { NextResponse } from "next/server";

import { isBackupTickAuthorized } from "@/lib/backup/tick-auth";
import { runSchedulerTick } from "@/lib/backup/scheduler";

// ─── Backup scheduler tick endpoint (Phase 8) ───────────────────────────
//
// Invoked by an external scheduler (Windows Task Scheduler, systemd
// timer, Vercel Cron, etc.). Protected by a shared secret carried in the
// `x-internal-secret` header, compared in constant time. The secret is
// never logged, never surfaced in error messages, and never returned in
// a response body.
//
// This endpoint never fails destructively: even if the underlying tick
// experiences an internal error, the response is a terse JSON body with
// no filesystem paths / SQL / stack traces. The full incident detail
// lives in the audit log, correlated by `operationId`.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isBackupTickAuthorized(req)) {
    // Uniform 404 — never confirm the endpoint's existence to an
    // unauthenticated caller. Matches the email tick endpoint's pattern.
    return new NextResponse("Not found", { status: 404 });
  }
  try {
    // Actor is null for external cron. Manual runs go through a separate
    // admin server action (see app/admin/(protected)/backups/actions.ts).
    const result = await runSchedulerTick({ actorId: null });
    // Return ONLY safe fields. Never expose retention.orphansObserved's
    // backupIds, never expose an errorCode's raw origin, never expose
    // filesystem paths.
    return NextResponse.json({
      ok:
        result.outcome === "OK" ||
        result.outcome.startsWith("SKIPPED"),
      outcome: result.outcome,
      operationId: result.operationId,
      backupId: result.backupId ?? null,
      durationMs: result.durationMs
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[backup.tick] unexpected error",
      err instanceof Error ? err.name : "unknown"
    );
    return NextResponse.json(
      { ok: false, outcome: "INTERNAL" },
      { status: 500 }
    );
  }
}

// A HEAD is a cheap liveness ping some schedulers hit before POST. Still
// gated by the secret so unauthenticated callers cannot enumerate the
// endpoint.
export async function HEAD(req: Request) {
  if (!isBackupTickAuthorized(req)) {
    return new NextResponse(null, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

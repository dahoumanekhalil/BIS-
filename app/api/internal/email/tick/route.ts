import { NextResponse } from "next/server";
import { processQueue } from "@/lib/email/worker";
import { timingSafeStringEquals } from "@/lib/email/crypto";

// Force this route to run in the Node.js runtime — the worker uses
// PostgreSQL row-locking via prisma.$queryRaw and depends on the
// full Prisma client (which is not available in the edge runtime).
export const runtime = "nodejs";
// Do not cache — every hit must actually run the worker.
export const dynamic = "force-dynamic";

// ─── Internal email tick endpoint ────────────────────────────────────────
//
// Invoked by an external scheduler (Windows Task Scheduler, systemd timer,
// Vercel Cron, etc.) to process any pending outbox rows. Protected by a
// shared secret carried in the `x-internal-secret` header, compared in
// constant time. The secret is never logged and never surfaced in error
// messages.
//
// The endpoint intentionally returns terse JSON; the actual send outcome
// is visible in the EmailMessage table and the AuditLog.

const HEADER = "x-internal-secret";

function hasSecret(req: Request): boolean {
  const expected = process.env.INTERNAL_EMAIL_TICK_SECRET;
  if (!expected || expected.length < 24) {
    // Refuse to run if the secret is missing or trivially short. The check
    // deliberately does not use `expected === ""` alone so a misconfigured
    // deployment cannot accidentally accept every request.
    return false;
  }
  const provided = req.headers.get(HEADER);
  if (!provided) return false;
  return timingSafeStringEquals(provided, expected);
}

export async function POST(req: Request) {
  if (!hasSecret(req)) {
    // Uniform 404 to avoid confirming the endpoint's existence to
    // unauthenticated scanners.
    return new NextResponse("Not found", { status: 404 });
  }
  try {
    const result = await processQueue();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[email.tick] unexpected error", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, message: "Worker tick failed." },
      { status: 500 }
    );
  }
}

// A HEAD is a cheap liveness ping some schedulers hit before POST — return
// 204 to indicate "endpoint exists" without doing any work. Still gated by
// the secret so an unauthenticated caller cannot enumerate the endpoint.
export async function HEAD(req: Request) {
  if (!hasSecret(req)) {
    return new NextResponse(null, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

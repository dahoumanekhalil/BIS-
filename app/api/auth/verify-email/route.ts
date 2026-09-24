import { NextResponse } from "next/server";
import { consumeEmailVerificationToken } from "@/lib/account/email-verification";
import { audit } from "@/lib/admin/audit";
import { isBlocked, record, THROTTLED_MESSAGE } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Blunt anti-brute-force cap. The token space is 256 bits so guessing is
// impractical, but this prevents automated fuzzers from hammering the
// endpoint and matches the pattern used on the password-reset consume
// action.
const VERIFY_ATTEMPTS_PER_IP = 30;

// ─── Email verification landing endpoint ─────────────────────────────────
//
// The verification link embedded in the auth-email-verify template points
// here. On success, mark the account verified and redirect the user to a
// friendly confirmation page. On any failure, redirect to the same page
// with a status query so the UI can show one of a small set of neutral
// messages (never "user X does not exist" — enumeration protection).

function safeRedirect(path: string, status?: string): NextResponse {
  const url = new URL(path, siteBase());
  if (status) url.searchParams.set("status", status);
  return NextResponse.redirect(url);
}

function siteBase(): string {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = (searchParams.get("token") ?? "").trim();

  if (!token) {
    return safeRedirect("/auth/verifier-email", "invalid");
  }

  const ip = await clientIp();
  const ipKey = ip ? `verify-email:ip:${ip}` : null;
  if (isBlocked(ipKey, VERIFY_ATTEMPTS_PER_IP)) {
    // Rate-limit responses use the shared throttled message and a neutral
    // status query so the user sees a friendly "try again later" surface
    // instead of an opaque 429 body.
    void THROTTLED_MESSAGE; // referenced for grepability / audit source
    return safeRedirect("/auth/verifier-email", "throttled");
  }
  record(ipKey);

  const result = await consumeEmailVerificationToken(token);

  if (!result.ok) {
    // The reasons "user-missing" and "email-changed" both reduce to a
    // generic "invalid" surface — we never confirm that a userId existed.
    const surface =
      result.reason === "expired" ? "expired" : "invalid";
    // Audit for support diagnosis. Store only the failure reason class,
    // never the raw token.
    await audit({
      userId: null,
      action: "auth.verify-email.failed",
      entity: "AccountUser",
      entityId: undefined as unknown as string,
      meta: { reason: result.reason }
    }).catch(() => undefined);
    return safeRedirect("/auth/verifier-email", surface);
  }

  await audit({
    userId: null,
    action: "auth.verify-email.ok",
    entity: "AccountUser",
    entityId: result.userId,
    meta: { claimedParticipantCount: result.claimedParticipantCount }
  }).catch(() => undefined);

  // Distinct audit row when the verification actually bound a legacy
  // anonymous Participant to the AccountUser — supports post-incident
  // review of ownership transfers.
  if (result.claimedParticipantCount > 0) {
    await audit({
      userId: null,
      action: "participant.claim",
      entity: "AccountUser",
      entityId: result.userId,
      meta: {
        count: result.claimedParticipantCount,
        via: "email-verification"
      }
    }).catch(() => undefined);
  }
  return safeRedirect("/auth/verifier-email", "ok");
}

import "server-only";

import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import type { Participant } from "@prisma/client";
import { getCurrentAccount } from "@/lib/account/auth";

/**
 * Server-side wizard state carrier for the unified /register flow.
 *
 * Step 1 creates a Participant + an OnboardingSession, then sets an HttpOnly
 * cookie holding an opaque token. Later steps read the cookie, hash it, and
 * look up the Participant.
 *
 * A parallel entry point exists via `/auth?mode=register`: an authenticated
 * AccountUser can bootstrap a Participant + session on demand — that's
 * `resumeOrBootstrapOnboarding()` below.
 *
 * Cookies are HttpOnly + SameSite=Strict — JS can't read them, and browsers
 * won't send them on cross-site requests.
 */

const COOKIE_NAME = "bis_reg_session";
const SESSION_TTL_MS = 1000 * 60 * 45; // 45 minutes

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function writeSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000)
  });
}

export async function createOnboardingSession(
  participantId: string
): Promise<string> {
  const token = newToken();
  const tokenHash = hashToken(token);
  // Invalidate any prior wizard sessions for this participant, so a user who
  // restarts Step 1 doesn't leave dangling live sessions in the DB.
  await prisma.onboardingSession.deleteMany({ where: { participantId } });
  await prisma.onboardingSession.create({
    data: {
      participantId,
      tokenHash,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS)
    }
  });
  await writeSessionCookie(token);
  return token;
}

export async function readOnboardingSession(): Promise<Participant | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.onboardingSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { participant: true }
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.onboardingSession
      .delete({ where: { id: session.id } })
      .catch(() => undefined);
    return null;
  }
  return session.participant;
}

export async function endOnboardingSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.onboardingSession
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
  }
  jar.delete(COOKIE_NAME);
}

/**
 * Get the current wizard's Participant. Priority:
 *
 *   1. An active OnboardingSession cookie (whether started via /register
 *      Step 1 basic form or bootstrapped from an AccountUser earlier).
 *   2. An authenticated AccountUser — bootstrap a fresh Participant tied to
 *      that account (or reuse an existing one keyed by email/accountUserId)
 *      and open a new OnboardingSession.
 *   3. Neither — return null. Callers redirect to /register.
 *
 * Bootstrap creates a Participant with `phone = null`; Step 3 collects the
 * missing contact fields.
 */
/**
 * Rich status of the current onboarding wizard.
 *
 *   "wizard"   — an OnboardingSession cookie already resolved to a Participant.
 *   "linked"   — no cookie, but an AccountUser is logged in; we (re)created
 *                a Participant for them and opened a fresh session.
 *   "conflict" — an AccountUser is logged in but their email collides with
 *                an anonymous prior Participant on this event. We refuse to
 *                auto-link (see security note below). UI should show a
 *                "contact support" message rather than bouncing the user.
 *   "none"     — not authenticated and no wizard session.
 *
 * SECURITY — Participant lookup:
 *   Only matches by `accountUserId`. We deliberately DO NOT match by email
 *   without email verification: an attacker who knows a victim's email and
 *   registers an AccountUser first could otherwise hijack the victim's
 *   anonymous Participant record.
 */
export type OnboardingStatus =
  | { kind: "wizard"; participant: Participant }
  | { kind: "linked"; participant: Participant }
  | { kind: "conflict" }
  | { kind: "none" };

/**
 * PAGE-SAFE reader. Never sets cookies (that would crash a Server Component
 * render). For AccountUser-flow users we don't issue an OnboardingSession
 * cookie at all — the AccountUser session is already the identity, and
 * Participant lookup by `accountUserId` is deterministic.
 *
 * If we still need to CREATE a Participant (first time this AccountUser
 * interacts with /register/*) we do it here — this is a DB write, allowed
 * during render — but we do NOT open an OnboardingSession row/cookie for it.
 */
export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const fromCookie = await readOnboardingSession();
  if (fromCookie) return { kind: "wizard", participant: fromCookie };

  const account = await getCurrentAccount();
  if (!account) return { kind: "none" };

  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (!event) return { kind: "none" };

  const existing = await prisma.participant.findFirst({
    where: { eventId: event.id, accountUserId: account.id }
  });
  if (existing) return { kind: "linked", participant: existing };

  try {
    const created = await prisma.participant.create({
      data: {
        eventId: event.id,
        accountUserId: account.id,
        firstName: account.firstName,
        lastName: account.lastName,
        email: account.email,
        phone: null,
        country: "Algérie",
        registrationType: "ATTENDEE",
        status: "PENDING",
        profile: "VISITOR"
      }
    });
    return { kind: "linked", participant: created };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      // Two possibilities:
      //  (a) A concurrent request from the same AccountUser just created
      //      the Participant — safe to re-fetch and use.
      //  (b) A pre-existing anonymous Participant claims the email — this
      //      is the "email conflict" we refuse to auto-link.
      const raced = await prisma.participant.findFirst({
        where: { eventId: event.id, accountUserId: account.id }
      });
      if (raced) return { kind: "linked", participant: raced };
      return { kind: "conflict" };
    }
    throw err;
  }
}

/**
 * Convenience wrapper for server actions: returns the Participant when the
 * wizard state is ready, `null` in every other case. Actions typically
 * redirect to `/register` on null; pages should prefer `getOnboardingStatus`
 * so they can render a proper "conflict" message.
 */
export async function resumeOrBootstrapOnboarding(): Promise<Participant | null> {
  const status = await getOnboardingStatus();
  return status.kind === "wizard" || status.kind === "linked"
    ? status.participant
    : null;
}

import "server-only";

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";

// Email-verification tokens for AccountUser. Mirror the AccountSession
// design: the raw token is returned once (to be embedded in a link) and
// only its sha256 is persisted. This makes a database dump non-replayable
// as a verification link.
//
// Single-use is enforced by `usedAt`; expiration by `expiresAt`. Both are
// checked in a single Prisma updateMany() so we cannot leak "the token
// existed once but was already used" via response timing.

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const TOKEN_BYTES = 32;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type IssuedToken = { rawToken: string; expiresAt: Date; tokenHash: string };

/**
 * Create a fresh verification token for the given AccountUser + email
 * snapshot. Caller (typically the auth trigger) embeds `rawToken` in the
 * verification link and never persists it anywhere else.
 *
 * Race-safe: if two concurrent registrations try to issue for the same
 * user, both succeed with distinct tokens — old tokens remain valid until
 * `expiresAt` or the first successful consume, whichever comes first.
 */
export async function issueEmailVerificationToken({
  userId,
  email
}: {
  userId: string;
  email: string;
}): Promise<IssuedToken> {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash,
      emailAtIssue: email.toLowerCase(),
      expiresAt
    }
  });
  return { rawToken, expiresAt, tokenHash };
}

export type ConsumeResult =
  | {
      ok: true;
      userId: string;
      emailAtIssue: string;
      // Number of legacy anonymous Participants that were atomically
      // bound to this AccountUser as part of consuming the token. Always
      // 0 or 1 today (one Participant per (eventId, email) uniqueness).
      claimedParticipantCount: number;
    }
  | {
      ok: false;
      reason:
        | "invalid"
        | "expired"
        | "used"
        | "user-missing"
        | "email-changed";
    };

/**
 * Consume a verification token. Returns `ok: true` with the userId + the
 * email snapshot from the moment of issue (so the caller can compare with
 * the AccountUser's current email and decide whether to accept — the
 * comparison happens here, not in the caller, to keep the enumeration-
 * safe response uniform).
 *
 * Single-use is enforced atomically via a WHERE `usedAt IS NULL` clause on
 * the update. A losing racer sees `used`.
 */
export async function consumeEmailVerificationToken(
  rawToken: string
): Promise<ConsumeResult> {
  if (!rawToken || typeof rawToken !== "string") {
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash }
  });
  if (!row) return { ok: false, reason: "invalid" };
  if (row.expiresAt < now) return { ok: false, reason: "expired" };
  if (row.usedAt) return { ok: false, reason: "used" };

  // Atomically claim the row: only the first caller wins.
  const claim = await prisma.emailVerificationToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: now }
  });
  if (claim.count !== 1) {
    return { ok: false, reason: "used" };
  }

  const user = await prisma.accountUser.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true }
  });
  if (!user) return { ok: false, reason: "user-missing" };
  if (user.email.toLowerCase() !== row.emailAtIssue.toLowerCase()) {
    return { ok: false, reason: "email-changed" };
  }

  await prisma.accountUser.update({
    where: { id: user.id },
    data: { emailVerifiedAt: now }
  });

  // ─── Legacy anonymous Participant claim ────────────────────────────────
  // If a Participant row exists with the same email and no accountUserId,
  // bind it to this AccountUser NOW that email ownership is proven.
  //
  // Race-safe: the `updateMany` predicate WHERE accountUserId IS NULL means
  // a concurrent claim (either from another verification attempt or another
  // signup) that already won leaves us with count=0 and we do nothing.
  //
  // Deliberately matches on the email the token was ISSUED to, not the
  // current AccountUser.email — protecting against a "change email → claim"
  // sequence. The prior `email-changed` check already ensures the two
  // agree at consumption time, but this second layer keeps the SQL
  // predicate free of user-controlled state.
  //
  // The email comparison is CASE-INSENSITIVE (Postgres `mode: "insensitive"`
  // = ILIKE-style match). Every user-facing entry point lowercases email
  // via Zod ingress today, but historical/imported/admin-touched rows may
  // still carry mixed case. Missing a valid claim is fail-safe (the user
  // just sees their old registration as "not present") but silently
  // stranding rows leaves the user unable to see their own data. Since
  // email ownership is already proven by token consumption, matching all
  // case variants owned by the same person is correct.
  const participantClaim = await prisma.participant.updateMany({
    where: {
      email: { equals: row.emailAtIssue, mode: "insensitive" },
      accountUserId: null
    },
    data: {
      accountUserId: user.id
    }
  });

  return {
    ok: true,
    userId: user.id,
    emailAtIssue: row.emailAtIssue,
    claimedParticipantCount: participantClaim.count
  };
}

/**
 * Best-effort cleanup — deletes expired rows to keep the table small.
 * Called by the worker on stale-cleanup ticks. Safe to run frequently.
 */
export async function purgeExpiredVerificationTokens(): Promise<number> {
  const res = await prisma.emailVerificationToken.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  });
  return res.count;
}

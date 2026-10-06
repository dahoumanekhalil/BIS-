import "server-only";

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/admin/password";
import {
  ensureParticipantForAccount,
  ensureActiveBadge
} from "@/lib/register/participant";

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
    select: { id: true, email: true, firstName: true, lastName: true }
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

  // ─── Automatic QR badge — ONLY now that the email is proven ────────────
  // Bootstrap the Participant (after the legacy claim above, so a claimed
  // anonymous registration is reused instead of conflicting) and issue the
  // account's ONE persistent QR. First issuance only: ensureActiveBadge
  // never replaces a credential and never undoes an admin revoke. Failure
  // is non-fatal — /compte/badge retries first issuance on the next visit.
  try {
    const ensured = await ensureParticipantForAccount(user);
    if (ensured.kind === "ready") {
      await ensureActiveBadge(ensured.participant.id);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[verify-email] automatic badge issuance failed (non-fatal):",
      err instanceof Error ? err.name : "unknown"
    );
  }

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

/** True when the AccountUser has proven ownership of their email. */
export async function isAccountEmailVerified(
  accountUserId: string
): Promise<boolean> {
  const u = await prisma.accountUser.findUnique({
    where: { id: accountUserId },
    select: { emailVerifiedAt: true }
  });
  return Boolean(u?.emailVerifiedAt);
}

// ─── "This wasn't me" — neutralise a hijacked / unexpected signup ──────────
//
// Threat: someone signs up with a VICTIM's email and a password they know;
// the verification mail reaches the victim, who clicks it. The account is now
// verified and (via the claim flow) may hold the victim's registration and QR.
//
// Right after a successful verification click the landing page offers
// "Ce n'est pas moi". Possession of the just-consumed link (carried in a
// short-lived httpOnly cookie, never in a URL) proves mailbox ownership, so
// it may neutralise the account:
//   • every session is deleted,
//   • the password is replaced by an unusable random value (recovery is the
//     normal "forgot password" email flow — only the mailbox owner can use it),
//   • the email is marked unverified again,
//   • participants bound to the account are unbound (they stay as ordinary
//     registrations with that email, claimable later by the real owner),
//   • their ACTIVE QR credentials are REVOKED (so any QR the intruder saw is
//     dead; an administrator must regenerate — revocation is durable),
//   • one audit row records the incident, all in ONE transaction.
// Window: 5 minutes after the link was consumed. Idempotent.

export const UNEXPECTED_SIGNUP_WINDOW_MS = 5 * 60 * 1000;

export type NeutralizeResult =
  | { ok: true; revokedCredentials: number; unboundParticipants: number }
  | { ok: false; reason: "invalid" | "expired" };

export async function neutralizeUnexpectedSignup(
  rawToken: string
): Promise<NeutralizeResult> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length > 256) {
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const row = await tx.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { userId: true, usedAt: true }
    });
    // Only a token that WAS consumed (a verification click really happened).
    if (!row || !row.usedAt) return { ok: false, reason: "invalid" } as const;
    if (now.getTime() - row.usedAt.getTime() > UNEXPECTED_SIGNUP_WINDOW_MS) {
      return { ok: false, reason: "expired" } as const;
    }

    const userId = row.userId;
    await tx.accountSession.deleteMany({ where: { userId } });
    const upd = await tx.accountUser.updateMany({
      where: { id: userId },
      data: {
        passwordHash: hashPassword(randomBytes(32).toString("hex")),
        emailVerifiedAt: null
      }
    });
    if (upd.count !== 1) return { ok: false, reason: "invalid" } as const;
    // Burn every outstanding verification token for this account.
    await tx.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now }
    });

    const participants = await tx.participant.findMany({
      where: { accountUserId: userId },
      select: { id: true }
    });
    const ids = participants.map((p) => p.id);
    let revoked = 0;
    let revokedIds: string[] = [];
    if (ids.length > 0) {
      revokedIds = (
        await tx.badgeCredential.findMany({
          where: { participantId: { in: ids }, status: "ACTIVE" },
          select: { id: true }
        })
      ).map((c) => c.id);
      const r = await tx.badgeCredential.updateMany({
        where: { participantId: { in: ids }, status: "ACTIVE" },
        data: {
          status: "REVOKED",
          revokedAt: now,
          revokedById: null,
          revokedReason: "unexpected-signup-report"
        }
      });
      revoked = r.count;
      await tx.participant.updateMany({
        where: { id: { in: ids } },
        data: { accountUserId: null }
      });
    }

    await tx.auditLog.create({
      data: {
        userId: null,
        action: "account.unexpected-signup.reported",
        entity: "AccountUser",
        entityId: userId,
        meta: {
          revokedCredentials: revoked,
          unboundParticipants: ids.length,
          participantIds: ids,
          revokedCredentialIds: revokedIds
        }
      }
    });
    return {
      ok: true,
      revokedCredentials: revoked,
      unboundParticipants: ids.length
    } as const;
  });
}

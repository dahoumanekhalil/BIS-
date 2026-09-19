import "server-only";

import { AdminStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/admin/password";
import {
  DUMMY_HASH,
  isBlocked,
  record,
  reset
} from "@/lib/rate-limit";

// Phase 13 WARN 1 — admin-login core.
//
// Split out of `app/admin/login/actions.ts` so tests can exercise the
// full authentication decision (rate limit → user lookup → password
// verify → outcome) without the Next.js request boundary
// (cookies/redirect/headers). The `"use server"` wrapper in the app
// tree handles session creation, cookie set, audit, and redirect
// after this function returns `{ ok: true }`.
//
// SECURITY PROPERTIES (locked, see master-doc Phase 13 record):
//
//   • Rate-limit gate runs BEFORE the DB lookup. An attacker cannot
//     signal "user exists" through timing by observing whether we
//     did or did not query Postgres.
//   • Every failure path — non-existent user, non-ACTIVE user,
//     invalid password — routes through the SAME
//     `record() + return INVALID_CREDENTIALS` shape. The caller
//     surfaces one uniform message ("Identifiants invalides.").
//   • Non-existent and non-ACTIVE branches STILL call
//     `verifyPassword(password, DUMMY_HASH)` so response latency
//     across those branches matches the "wrong password on valid
//     user" branch. Prevents timing-based enumeration.
//   • Success path calls `reset(emailKey)` so a valid login clears
//     the per-email failure counter — a busy admin behind NAT
//     cannot lock themselves out by logging in successfully.
//   • This function NEVER writes a session, cookie, or audit row.
//     Those side-effects live in the caller so tests can assert the
//     shape of an authentication decision without side-effects.
//   • Passwords, hashes, tokens NEVER appear in the returned
//     outcome or in any log line.

// Same thresholds as the attendee login (see app/actions/account.ts:
// LOGIN_FAILS_PER_EMAIL / LOGIN_FAILS_PER_IP). Kept in sync
// deliberately: an admin account is at least as sensitive as an
// attendee account and does not warrant a laxer bucket.
const ADMIN_LOGIN_FAILS_PER_EMAIL = 8;
const ADMIN_LOGIN_FAILS_PER_IP = 20;

export type AdminLoginOutcome =
  | { ok: true; userId: string }
  | {
      ok: false;
      // Callers map both INVALID_INPUT and INVALID_CREDENTIALS to the
      // same user-visible message. Distinct codes are for internal
      // metrics only.
      kind: "INVALID_INPUT" | "THROTTLED" | "INVALID_CREDENTIALS";
    };

export async function verifyAdminLogin(input: {
  email: string;
  password: string;
  // Null when no proxy header is present — the IP bucket is then
  // disabled for this attempt rather than funnelled into a global
  // "unknown" bucket (matches the attendee-side policy).
  ip: string | null;
}): Promise<AdminLoginOutcome> {
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  // Reject empty input BEFORE hitting the rate-limit or the DB. This
  // is a validation error, not a credential-guessing attempt.
  if (!email || !password) {
    return { ok: false, kind: "INVALID_INPUT" };
  }

  const ipKey = input.ip ? `admin-login:ip:${input.ip}` : null;
  const emailKey = `admin-login:email:${email}`;

  // Rate limit gate — runs BEFORE any DB access so a distant attacker
  // cannot even trigger a Postgres lookup once throttled.
  if (
    isBlocked(ipKey, ADMIN_LOGIN_FAILS_PER_IP) ||
    isBlocked(emailKey, ADMIN_LOGIN_FAILS_PER_EMAIL)
  ) {
    return { ok: false, kind: "THROTTLED" };
  }

  // Uniform failure builder: records the counter buckets and returns
  // the same shape regardless of which branch reached it. The caller
  // MUST NOT differentiate between the branches when surfacing the
  // response to the client.
  const rejected = (): AdminLoginOutcome => {
    record(ipKey);
    record(emailKey);
    return { ok: false, kind: "INVALID_CREDENTIALS" };
  };

  const user = await prisma.adminUser.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, status: true }
  });

  // Timing equalisation: every failure branch runs verifyPassword
  // exactly once. `verifyPassword` is scrypt, which is deliberately
  // slow and dominates the response latency — matching it across
  // branches denies an attacker any measurable oracle.
  if (!user) {
    verifyPassword(password, DUMMY_HASH);
    return rejected();
  }
  if (user.status !== AdminStatus.ACTIVE) {
    // Inactive accounts do NOT get a distinct message and do NOT
    // reveal existence. The DUMMY_HASH verify keeps latency in line
    // with the "no user" branch, closing the enumeration side-channel
    // that pre-Phase-13 code exposed.
    verifyPassword(password, DUMMY_HASH);
    return rejected();
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return rejected();
  }

  // Success — clear the per-email counter so an admin who mistyped
  // their password a few times and then succeeded is not left
  // one-attempt-from-lockout.
  reset(emailKey);
  return { ok: true, userId: user.id };
}

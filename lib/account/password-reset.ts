import "server-only";

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";

// Password-reset tokens for AccountUser. Same hashed-single-use design as
// EmailVerificationToken, with two additional properties driven by the
// enumeration-protection requirement (spec §10):
//
//   • The caller that mints a token accepts a POSSIBLY-INVALID email and
//     receives a uniform result — actual token issue happens only when
//     the account exists. This module exposes the mint separately so the
//     server action can decide what to reveal.
//
//   • On successful consume, ALL outstanding tokens for the same user are
//     invalidated in the same transaction as the password change. This
//     avoids a race where a leaked older token can still be used after
//     the user changed their password via a newer one.

const TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour
const TOKEN_BYTES = 32;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// IP address gets truncated before it lands in the DB — full IPs are PII
// and we only need enough to correlate suspicious patterns.
function truncateIp(ip: string | null): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(":")) {
    // IPv6 — keep the /64 prefix.
    const parts = trimmed.split(":");
    return parts.slice(0, 4).join(":") + "::";
  }
  const parts = trimmed.split(".");
  if (parts.length !== 4) return trimmed.slice(0, 32);
  return parts.slice(0, 3).join(".") + ".0";
}

export type IssuedReset = {
  rawToken: string;
  expiresAt: Date;
  tokenHash: string;
};

/**
 * Issue a password-reset token for a specific user. Caller must have
 * already verified the account exists — the enumeration-safe wrapper is
 * in the server action, not here.
 */
export async function issuePasswordResetToken({
  userId,
  requestIp
}: {
  userId: string;
  requestIp?: string | null;
}): Promise<IssuedReset> {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      requestIp: truncateIp(requestIp ?? null)
    }
  });
  return { rawToken, expiresAt, tokenHash };
}

export type ResetValidateResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "user-missing" };

/**
 * Validate a raw token WITHOUT consuming it. Used by the reset form to
 * decide whether to render the "set new password" fields or the "expired
 * link" message. The reset action itself calls `consumeAndSet…` which
 * re-validates and enforces atomic single-use inside a transaction.
 */
export async function validatePasswordResetToken(
  rawToken: string
): Promise<ResetValidateResult> {
  if (!rawToken || typeof rawToken !== "string") {
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = hashToken(rawToken);
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true }
  });
  if (!row) return { ok: false, reason: "invalid" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt < new Date()) return { ok: false, reason: "expired" };
  const user = await prisma.accountUser.findUnique({
    where: { id: row.userId },
    select: { id: true }
  });
  if (!user) return { ok: false, reason: "user-missing" };
  return { ok: true, userId: row.userId };
}

export type ConsumeSetResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: "invalid" | "expired" | "used" | "user-missing";
    };

/**
 * Consume a token and set the new password hash atomically. Also destroys
 * all sessions and invalidates any other outstanding reset tokens for the
 * same user, so:
 *   • a leaked older reset link cannot be redeemed after this one runs, and
 *   • an active session cookie of the attacker cannot survive the reset.
 *
 * The caller must have already hashed the new password.
 */
export async function consumeAndSetPassword({
  rawToken,
  newPasswordHash
}: {
  rawToken: string;
  newPasswordHash: string;
}): Promise<ConsumeSetResult> {
  if (!rawToken || typeof rawToken !== "string") {
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true }
    });
    if (!row) return { ok: false, reason: "invalid" } as const;
    if (row.usedAt) return { ok: false, reason: "used" } as const;
    if (row.expiresAt < now) return { ok: false, reason: "expired" } as const;

    // Atomic claim of the row — a losing racer sees count=0.
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now }
    });
    if (claim.count !== 1) return { ok: false, reason: "used" } as const;

    const user = await tx.accountUser.findUnique({
      where: { id: row.userId },
      select: { id: true }
    });
    if (!user) return { ok: false, reason: "user-missing" } as const;

    await tx.accountUser.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash }
    });

    // Kill every session for this user — attacker with a valid cookie
    // cannot survive the reset.
    await tx.accountSession.deleteMany({ where: { userId: user.id } });

    // Invalidate every other outstanding reset token — a leaked older
    // link cannot be redeemed after this reset.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now }
    });

    return { ok: true, userId: user.id } as const;
  });
}

export async function purgeExpiredPasswordResets(): Promise<number> {
  const res = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  });
  return res.count;
}

import "server-only";

import { createHash } from "crypto";
import { queueTemplatedEmail, EVENT_VARS } from "@/lib/email/queue";
import {
  isEmailRateLimited,
  recordEmailAttempt,
  RATE_LIMITS
} from "@/lib/email/rate-limit";

// Thin wrappers around queueTemplatedEmail() specifically for the AccountUser
// authentication flows. Each helper is responsible for:
//   • building the deterministic idempotency key
//   • checking / recording the per-recipient rate limit
//   • constructing an absolute URL from NEXT_PUBLIC_SITE_URL for CTA buttons
//
// The helpers deliberately DO NOT touch the DB directly. Token issue happens
// in lib/account/{email-verification,password-reset}.ts and the raw token is
// passed in here — this file must never see the DB or the token hash.

function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

// Encode as URL-safe query param — matches base64url tokens without needing
// double-encoding.
function encodeToken(rawToken: string): string {
  return encodeURIComponent(rawToken);
}

/**
 * Hash of the raw token — used as the idempotency-key seed so we do not
 * embed the raw token in the DB via idempotencyKey. This keeps a DB dump
 * from carrying re-usable verification URLs.
 */
function keySeedFor(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex").slice(0, 24);
}

export type SendVerificationInput = {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  rawToken: string;
  expiresAt: Date;
};

export async function sendVerificationEmail(input: SendVerificationInput) {
  const bucket = { bucket: "verify" as const, key: input.email.toLowerCase() };
  if (isEmailRateLimited({ ...bucket, limit: RATE_LIMITS.verify })) {
    return { ok: false as const, reason: "rate-limited" as const };
  }

  const url =
    siteUrl() +
    "/api/auth/verify-email?token=" +
    encodeToken(input.rawToken);
  const hours = Math.max(
    1,
    Math.round((input.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60))
  );
  const result = await queueTemplatedEmail({
    templateKey: "auth-email-verify",
    to: input.email,
    toName: `${input.firstName} ${input.lastName}`,
    idempotencyKey: `verify:${input.userId}:${keySeedFor(input.rawToken)}`,
    vars: {
      firstName: input.firstName,
      lastName: input.lastName,
      fullName: `${input.firstName} ${input.lastName}`,
      email: input.email,
      verificationUrl: url,
      expiresInHours: String(hours),
      ...EVENT_VARS
    }
  });
  if (result.ok) recordEmailAttempt(bucket);
  return result;
}

export type SendPasswordResetInput = {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  rawToken: string;
  expiresAt: Date;
};

export async function sendPasswordResetEmail(input: SendPasswordResetInput) {
  const bucket = {
    bucket: "password-reset" as const,
    key: input.email.toLowerCase()
  };
  if (isEmailRateLimited({ ...bucket, limit: RATE_LIMITS.passwordReset })) {
    return { ok: false as const, reason: "rate-limited" as const };
  }

  const url =
    siteUrl() + "/auth/mot-de-passe-reset?token=" + encodeToken(input.rawToken);
  const hours = Math.max(
    1,
    Math.round((input.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60))
  );
  const result = await queueTemplatedEmail({
    templateKey: "auth-password-reset",
    to: input.email,
    toName: `${input.firstName} ${input.lastName}`,
    idempotencyKey: `reset:${input.userId}:${keySeedFor(input.rawToken)}`,
    vars: {
      firstName: input.firstName,
      lastName: input.lastName,
      fullName: `${input.firstName} ${input.lastName}`,
      email: input.email,
      resetUrl: url,
      expiresInHours: String(hours),
      ...EVENT_VARS
    }
  });
  if (result.ok) recordEmailAttempt(bucket);
  return result;
}

export type SendPasswordChangedInput = {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  changedAt: Date;
};

export async function sendPasswordChangedNotice(input: SendPasswordChangedInput) {
  // Deterministic key includes the changedAt second-precision so multiple
  // password changes in the same second dedupe (unlikely), but a change
  // an hour later fires again.
  const bucketKey = Math.floor(input.changedAt.getTime() / 1000);
  return queueTemplatedEmail({
    templateKey: "auth-password-changed",
    to: input.email,
    toName: `${input.firstName} ${input.lastName}`,
    idempotencyKey: `pwd-changed:${input.userId}:${bucketKey}`,
    vars: {
      firstName: input.firstName,
      lastName: input.lastName,
      fullName: `${input.firstName} ${input.lastName}`,
      email: input.email,
      issuedAt: input.changedAt.toISOString(),
      ...EVENT_VARS
    }
  });
}

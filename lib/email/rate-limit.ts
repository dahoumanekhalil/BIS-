import "server-only";

// In-process sliding-window rate limiter for email triggers. Kept separate
// from `lib/rate-limit.ts` because that module is tuned for login/register
// (15-minute windows) — email throttling needs per-hour windows and different
// keys, and mixing the two into the same map would let a login flood evict
// email-verification throttles (spec §25 "abuse prevention").
//
// LIMITATIONS: best-effort per-process. In a multi-instance deployment each
// instance keeps its own map, so the effective threshold is
// `limit * instanceCount`. Documented in the README.

const WINDOW_MS = 1000 * 60 * 60; // 1 hour
const MAX_BUCKETS = 20_000;
const KEEP_ABOVE = 2;

const buckets = new Map<string, { count: number; resetAt: number }>();

function prune(now: number) {
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  const target = MAX_BUCKETS * 0.8;
  if (buckets.size <= target) return;
  for (const [k, v] of buckets) {
    if (buckets.size <= target) return;
    if (v.count <= KEEP_ABOVE) buckets.delete(k);
  }
  for (const k of buckets.keys()) {
    if (buckets.size <= target) return;
    buckets.delete(k);
  }
}

export type EmailRateLimit = {
  bucket: "verify" | "password-reset" | "test-send" | "contact";
  key: string; // e.g. `${email}` or `${adminId}` or `${ip}`
  limit: number;
};

// Central budget table — spec §25.
export const RATE_LIMITS = {
  // Per-recipient email verification requests. Low ceiling — repeated
  // verification emails leak account existence and are usually accidental.
  verify: 3,
  // Per-recipient password reset requests. Slightly higher because a user
  // may legitimately click "forgot" multiple times while trying different
  // saved passwords.
  passwordReset: 5,
  // Per-admin per-hour test-email cap. Prevents an admin from turning the
  // SMTP server into a spam relay by looping test-send.
  testSend: 20,
  // Per-IP contact-form submissions.
  contact: 5
} as const;

export function isEmailRateLimited(input: EmailRateLimit): boolean {
  const entry = buckets.get(input.bucket + ":" + input.key);
  return !!entry && entry.resetAt > Date.now() && entry.count >= input.limit;
}

export function recordEmailAttempt(input: Omit<EmailRateLimit, "limit">): void {
  const composed = input.bucket + ":" + input.key;
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) prune(now);
  const entry = buckets.get(composed);
  if (!entry || entry.resetAt < now) {
    buckets.delete(composed);
    buckets.set(composed, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/**
 * Testing helper — never used in production code. Guarded by NODE_ENV to
 * avoid an accidental import path resetting live counters.
 */
export function __resetEmailRateLimitsForTests(): void {
  if (process.env.NODE_ENV === "production") return;
  buckets.clear();
}

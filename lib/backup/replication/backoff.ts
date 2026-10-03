import "server-only";

// Exponential backoff + jitter (§I.2).
//
// Formula (locked to the plan):
//   base    = 30 s
//   cap     = 30 min
//   delay   = min(cap, base * 2^(attempt - 1)) * (1 + rand(0, 0.5))
//   attempts capped at MAX_ATTEMPTS = 24 (~12h at cap)
//
// After MAX_ATTEMPTS, the caller MUST transition the row to FAILED
// (this module is stateless; the decision to give up lives at the
// call site).
//
// `nextRetryAt` is computed relative to a caller-provided `now`
// (never `Date.now()` inline) so tests can pin time.

export const BACKOFF_BASE_MS = 30 * 1000;
export const BACKOFF_CAP_MS = 30 * 60 * 1000;
export const BACKOFF_MAX_JITTER_FRACTION = 0.5;
export const BACKOFF_MAX_ATTEMPTS = 24;

/**
 * Deterministic exponential term without jitter — useful for tests
 * that want to assert the pre-jitter bound.
 */
export function backoffTermMs(attemptCount: number): number {
  if (attemptCount <= 0) return BACKOFF_BASE_MS;
  const scaled = BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1);
  if (!Number.isFinite(scaled) || scaled > BACKOFF_CAP_MS) return BACKOFF_CAP_MS;
  return scaled;
}

/**
 * Compute `nextRetryAt` for the given attempt count. `rand` is
 * injectable so tests can pin the jitter component.
 *
 * If a server returned `Retry-After` in seconds and it is inside
 * `[30s, 30min]`, honour it exactly (no jitter). Layer I truth table
 * requires §I.1 "Retry-After honored" for 403 rate-limit and 429.
 */
export function computeNextRetryAt(input: {
  attemptCount: number;
  now: Date;
  retryAfterSeconds?: number | null;
  rand?: () => number;
}): Date {
  if (
    typeof input.retryAfterSeconds === "number" &&
    Number.isFinite(input.retryAfterSeconds) &&
    input.retryAfterSeconds >= 0
  ) {
    const clamped = Math.min(
      BACKOFF_CAP_MS,
      Math.max(BACKOFF_BASE_MS, input.retryAfterSeconds * 1000)
    );
    return new Date(input.now.getTime() + clamped);
  }
  const rand = input.rand ?? Math.random;
  const term = backoffTermMs(input.attemptCount);
  const jitter = 1 + BACKOFF_MAX_JITTER_FRACTION * rand();
  return new Date(input.now.getTime() + Math.round(term * jitter));
}

/**
 * Terminal-attempt gate (§I.2). Returns true when the caller MUST
 * give up and transition the row to FAILED rather than schedule
 * another retry.
 */
export function isAttemptCapReached(attemptCount: number): boolean {
  return attemptCount >= BACKOFF_MAX_ATTEMPTS;
}

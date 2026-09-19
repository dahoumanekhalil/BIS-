import "server-only";

import { randomBytes } from "crypto";
import { hashPassword } from "@/lib/admin/password";

// Shared in-process rate-limit primitives used by both attendee login
// (app/actions/account.ts) and admin login
// (app/admin/login/actions.ts). Kept as a single module so both flows
// SHARE the same attempt map and DUMMY_HASH constant — this avoids
// drift between the two login surfaces and makes the algorithm
// auditable in one place.
//
// LIMITS: best-effort per-process. A multi-instance deploy multiplies
// the effective threshold by the instance count, so this is a speed
// bump, not a guarantee. IP resolution is trust-boundary aware — the
// proxy-set `x-real-ip` wins over the attacker-controllable
// `x-forwarded-for`.
//
// NAMESPACING: callers MUST use distinct key prefixes so admin buckets
// do not collide with attendee buckets. Convention:
//   register:ip:<ip>          register:email:<email>
//   register:attempt:<ip>
//   login:ip:<ip>             login:email:<email>
//   admin-login:ip:<ip>       admin-login:email:<email>

const WINDOW_MS = 1000 * 60 * 15;
const MAX_BUCKETS = 5000;
const RETAIN_ABOVE_COUNT = 3;

const attempts = new Map<string, { count: number; resetAt: number }>();

function prune(now: number) {
  for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
  // Trim well below the cap, otherwise every later insert re-triggers the scan.
  const target = MAX_BUCKETS * 0.8;
  if (attempts.size <= target) return;
  // Map iterates in insertion order, so both passes drop the oldest keys first.
  // Near-tripped buckets go last so flooding the map with fresh keys cannot
  // evict — and thereby reset — an active throttle.
  for (const [k, v] of attempts) {
    if (attempts.size <= target) return;
    if (v.count <= RETAIN_ABOVE_COUNT) attempts.delete(k);
  }
  for (const k of attempts.keys()) {
    if (attempts.size <= target) return;
    attempts.delete(k);
  }
}

export function isBlocked(key: string | null, limit: number): boolean {
  if (!key) return false;
  const entry = attempts.get(key);
  return !!entry && entry.resetAt > Date.now() && entry.count >= limit;
}

export function record(key: string | null) {
  if (!key) return;
  const now = Date.now();
  if (attempts.size > MAX_BUCKETS) prune(now);
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    // Delete first: re-setting an existing key keeps its original insertion
    // slot, which would make prune's oldest-first eviction miss fresh buckets.
    attempts.delete(key);
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function reset(key: string | null) {
  if (!key) return;
  attempts.delete(key);
}

// Compared against when no account matches, so a missing email costs the same
// time as a wrong password and cannot be detected by response latency. Shared
// between attendee + admin login so a single scrypt call at module init
// covers both — subsequent verifyPassword calls in either flow reuse this
// constant.
export const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

// Uniform throttled message. Same string for attendee + admin so a client
// cannot infer which flow is throttled (defence in depth against
// cross-flow enumeration).
export const THROTTLED_MESSAGE =
  "Trop de tentatives. Réessayez dans quelques minutes.";

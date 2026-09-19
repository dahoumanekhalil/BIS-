import "server-only";

import { headers } from "next/headers";

// Trust-boundary aware client-IP resolver. Split from lib/rate-limit.ts
// so the pure rate-limit primitives (isBlocked / record / DUMMY_HASH)
// stay importable from `node:test` without dragging next/headers into
// the test host — `next/headers` binds to React's server context and
// requires `--conditions=react-server` PLUS an experimental React
// entry that our Node version does not expose.
//
// Callers (server actions) resolve the IP once and pass it to the
// pure verify functions as a plain string. Tests pass `null` and
// exercise the email-key bucket, which is sufficient for
// timing-and-enumeration coverage.

// x-forwarded-for is attacker-controlled unless a proxy overwrites it,
// so the proxy-set x-real-ip wins. Null (no proxy headers) disables
// the IP bucket rather than funnelling every visitor into one shared
// "unknown" bucket.
export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

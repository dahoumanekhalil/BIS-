import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

// A BadgeCredential's raw token is the only secret that ever leaves the
// server: it is embedded into the QR shown to the participant. The DB stores
// only the sha256 of this token. If the DB is dumped, an attacker cannot
// reconstruct working QR codes.
//
// Convention matches the other opaque tokens in this project
// (lib/account/auth.ts, lib/onboarding.ts, lib/admin/auth.ts): 32 random
// bytes → base64url. That is 256 bits of entropy, un-brute-forceable.
const TOKEN_BYTES = 32;

// Minimum length of a plausible token — used only to short-circuit obviously
// bogus input in verify() before we bother hashing it. 32 random bytes
// base64url-encoded produces a 43-character string; 40 is a safe floor.
export const MIN_TOKEN_LENGTH = 40;

export function generateBadgeToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

// sha256 is deliberate — NOT bcrypt/argon2. The input is already a
// cryptographically random 256-bit value, so a slow KDF adds no security
// (there is nothing to brute-force) while destroying our ability to look up
// the credential by hash in O(log n) via the unique index on tokenHash.
export function hashBadgeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Constant-time equality on two hex hashes. The DB lookup by unique tokenHash
// already gave us a match, but re-checking here in constant time is cheap
// defence-in-depth against any layer that could report a false positive.
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ba, bb);
}

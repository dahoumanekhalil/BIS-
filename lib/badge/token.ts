import "server-only";

import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import { BadgeError } from "./errors";

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

// ─── Persistent QR token (HMAC-derived) ──────────────────────────────────
//
// token = base64url( HMAC-SHA256( BADGE_QR_TOKEN_SECRET,
//                                 "bis-badge-qr|v1|<credentialId>|<sequence>" ) )
//
// • The secret is dedicated to this purpose and lives ONLY in the
//   environment (never the database, a backup, the browser, or a log).
// • credentialId is a fresh random id per credential and sequence grows on
//   every regeneration, so every credential has a distinct token and a
//   regenerated QR can never equal an earlier one.
// • Without the secret the token cannot be computed from public data, even
//   knowing the participant id, credential id and sequence.
// • The sha256(token) lookup (unique tokenHash) is unchanged.
// • Output is 43 characters (32 bytes), above MIN_TOKEN_LENGTH.
const DERIVATION_DOMAIN = "bis-badge-qr|v1";
const SECRET_ENV = "BADGE_QR_TOKEN_SECRET";
const SECRET_MIN_BYTES = 32;

// Other secrets in this project that must NEVER be reused for QR tokens.
const FORBIDDEN_REUSE_ENV = [
  "BACKUP_ENCRYPTION_KEY",
  "INTERNAL_BACKUP_TICK_SECRET",
  "INTERNAL_EMAIL_TICK_SECRET",
  "EMAIL_SECRET_ENCRYPTION_KEY"
] as const;

function decodeSecret(raw: string): Buffer | null {
  const t = raw.trim();
  if (
    /^[0-9a-fA-F]+$/.test(t) &&
    t.length >= SECRET_MIN_BYTES * 2 &&
    t.length % 2 === 0
  ) {
    return Buffer.from(t, "hex");
  }
  if (/^[A-Za-z0-9_-]+$/.test(t)) {
    const b = Buffer.from(t, "base64url");
    if (b.length >= SECRET_MIN_BYTES) return b;
  }
  return null;
}

// Fails CLOSED with a BadgeError that never contains the secret value.
export function loadBadgeQrSecret(): Buffer {
  const raw = process.env[SECRET_ENV];
  if (!raw || raw.trim().length === 0) {
    throw new BadgeError("SECRET_NOT_CONFIGURED");
  }
  const key = decodeSecret(raw);
  if (!key) throw new BadgeError("SECRET_NOT_CONFIGURED");
  // Reject trivially low-diversity secrets (e.g. "aaaa…").
  if (new Set(key).size < 12) throw new BadgeError("SECRET_NOT_CONFIGURED");
  // Never reuse another secret: compare raw text AND decoded bytes (the same
  // key encoded as hex vs base64url must still be detected).
  for (const name of FORBIDDEN_REUSE_ENV) {
    const other = process.env[name];
    if (!other) continue;
    if (other.trim() === raw.trim()) {
      throw new BadgeError("SECRET_NOT_CONFIGURED");
    }
    const otherKey = decodeSecret(other);
    if (
      otherKey &&
      otherKey.length === key.length &&
      timingSafeEqual(otherKey, key)
    ) {
      throw new BadgeError("SECRET_NOT_CONFIGURED");
    }
  }
  return key;
}

export function deriveBadgeToken(
  credentialId: string,
  sequence: number
): string {
  if (!credentialId || !Number.isInteger(sequence) || sequence < 1) {
    throw new BadgeError("CREDENTIAL_NOT_FOUND");
  }
  const key = loadBadgeQrSecret();
  return createHmac("sha256", key)
    .update(`${DERIVATION_DOMAIN}|${credentialId}|${sequence}`, "utf8")
    .digest("base64url");
}

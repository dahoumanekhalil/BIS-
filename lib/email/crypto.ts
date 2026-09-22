import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "crypto";

// AES-256-GCM symmetric encryption used ONLY for the SMTP password stored in
// SiteContent. The key is supplied via the `EMAIL_SECRET_ENCRYPTION_KEY`
// environment variable. A missing or malformed key is treated as a
// configuration error — encryption fails closed and the SMTP config cannot
// be persisted.
//
// Envelope layout (base64url encoded):
//   "v1:<iv_b64>:<tag_b64>:<ciphertext_b64>"
//
// The `v1:` prefix reserves room for a future key-rotation scheme
// (e.g. `v2:<keyId>:…`) without breaking rows that still carry `v1:`.

const ALG = "aes-256-gcm";
const IV_BYTES = 12; // GCM recommended IV size
const KEY_BYTES = 32; // 256 bits
const TAG_BYTES = 16;

/**
 * Resolve the raw encryption key from the environment. Accepts either a
 * base64url-encoded 32-byte value (preferred) or a hex-encoded 32-byte
 * value. Any other input length triggers a configuration error to force
 * operators to generate a proper key rather than pasting a random string
 * that silently narrows the entropy.
 */
export function loadEncryptionKey(): Buffer {
  const raw = process.env.EMAIL_SECRET_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new EmailCryptoConfigError(
      "EMAIL_SECRET_ENCRYPTION_KEY is not set. Generate a 32-byte key with:  " +
        "node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))\""
    );
  }
  const trimmed = raw.trim();
  // Try base64url first, then hex. Both are the "expected" encodings.
  const asBase64 = safeBase64UrlDecode(trimmed);
  if (asBase64 && asBase64.length === KEY_BYTES) return asBase64;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    return Buffer.from(trimmed, "hex");
  }
  throw new EmailCryptoConfigError(
    "EMAIL_SECRET_ENCRYPTION_KEY must be a 32-byte value encoded as base64url or hex."
  );
}

function safeBase64UrlDecode(v: string): Buffer | null {
  try {
    const b = Buffer.from(v, "base64url");
    // Node accepts a lot of near-base64 strings; verify a round-trip so a
    // trimmed / re-encoded string isn't silently accepted.
    if (b.toString("base64url").replace(/=+$/, "") !== v.replace(/=+$/, "")) {
      return null;
    }
    return b;
  } catch {
    return null;
  }
}

export class EmailCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailCryptoConfigError";
  }
}

/**
 * Encrypt a UTF-8 plaintext (typically the SMTP password) and return the
 * versioned envelope string ready to be persisted in SiteContent.
 *
 * NEVER log the return value or the plaintext. Callers should treat the
 * encrypted string as an opaque secret handle.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptSecret expects a string plaintext.");
  }
  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error("Unexpected GCM tag length");
  }
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url")
  ].join(":");
}

/**
 * Decrypt an envelope produced by `encryptSecret`. Throws on any tampering,
 * wrong key, or malformed envelope — callers should treat any exception as
 * "the stored secret is unusable" and fail closed.
 */
export function decryptSecret(envelope: string): string {
  if (typeof envelope !== "string") {
    throw new TypeError("decryptSecret expects a string envelope.");
  }
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported secret envelope version.");
  }
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ct = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES) {
    throw new Error("Invalid IV length in secret envelope.");
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error("Invalid auth tag length in secret envelope.");
  }

  const key = loadEncryptionKey();
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * Detect whether a value looks like a `v1:` envelope. Used by the config
 * layer to distinguish "operator pasted a raw password" (encrypt it before
 * persisting) from "value already came from the DB" (leave it alone).
 */
export function looksEncrypted(value: unknown): value is string {
  return typeof value === "string" && /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Constant-time comparison of two short shared-secret strings — used by the
 * internal cron endpoint to compare the request header against
 * `INTERNAL_EMAIL_TICK_SECRET`. Prevents timing-side-channel discovery of
 * the secret's prefix.
 */
export function timingSafeStringEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Length itself is not a secret; short-circuit while still calling
    // timingSafeEqual against a pad so the caller cannot distinguish
    // "wrong length" from "wrong content" via timing.
    const pad = Buffer.alloc(Math.max(ab.length, bb.length, 1));
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Stable non-reversible fingerprint of an encrypted envelope. Used purely
 * for the admin UI to indicate "password is configured" and for audit-log
 * metadata (`smtpFingerprint`) so operators can tell whether the SMTP
 * password rotated between two config saves. NEVER returns the plaintext.
 */
export function secretFingerprint(envelope: string): string {
  return createHash("sha256").update(envelope).digest("hex").slice(0, 12);
}

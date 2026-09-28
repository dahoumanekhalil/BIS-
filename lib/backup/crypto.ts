import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type CipherGCM,
  type DecipherGCM
} from "crypto";
import { Transform } from "stream";

// ─── Streaming AES-256-GCM for full-database backups ────────────────────────
//
// Follows the same envelope discipline as `lib/email/crypto.ts` (v1: prefix
// reserved for future rotation), but is streaming-first because a backup
// file is far too large to hold in a single Buffer.
//
// KEY DERIVATION (domain separation)
//   The master key from `BACKUP_ENCRYPTION_KEY` is NEVER used directly for
//   AES or HMAC. HKDF-SHA256 derives two 32-byte subkeys with distinct
//   `info` labels:
//     encKey  = HKDF(masterKey, info="bis2027-backup-enc-v1")
//     hmacKey = HKDF(masterKey, info="bis2027-backup-hmac-v1")
//   Domain separation costs almost nothing and immunizes against a future
//   subtle bug that would reuse the same key material in a second primitive.
//
// FILE LAYOUT (produced by the dump engine, consumed by verify + restore)
//   [ 12 bytes IV ][ ciphertext bytes ][ 16 bytes GCM tag ]
//   The IV is prepended at write time and stripped at read time; the tag is
//   appended after `cipher.final()` and pulled from the last 16 bytes at
//   read time. Everything the decrypter needs (except the key) is in the
//   file itself — no sidecar.
//
// SECURITY invariants (must remain true forever):
//   * The master key never appears in logs, error messages, API responses,
//     UI strings, or the manifest. Any operator diagnostics reference the
//     env var NAME (`BACKUP_ENCRYPTION_KEY`), never its value.
//   * A missing/malformed key throws `BackupCryptoConfigError` at first
//     use — encryption fails closed. A backup can NEVER reach `COMPLETED`
//     status without the tag verifying at close time.
//   * The GCM tag is authoritative for ciphertext integrity. The separate
//     `contentSha256` in the manifest is a fast pre-decryption sanity
//     check, NOT a substitute for the tag.

const ALG = "aes-256-gcm";
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
const HKDF_HASH = "sha256";

const HKDF_INFO_ENC = "bis2027-backup-enc-v1";
const HKDF_INFO_HMAC = "bis2027-backup-hmac-v1";
// HKDF salt is deliberately empty. Per RFC 5869 §3.1, an empty salt is
// acceptable when the input key material is already high-entropy (a 32-byte
// random value from the operator's key generation is high-entropy by
// definition — we validate the length up-front). Using a non-secret salt
// here would add no security and would create an additional coordination
// artifact between backup writers and restore readers.

export class BackupCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupCryptoConfigError";
  }
}

/**
 * Resolve the raw 32-byte master key from the environment. Accepts either
 * base64url (preferred) or hex encoding. Any other length or encoding is a
 * configuration error — refusing silently narrower keys is safer than
 * accepting whatever the operator pasted.
 */
export function loadBackupEncryptionKey(): Buffer {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new BackupCryptoConfigError(
      "BACKUP_ENCRYPTION_KEY is not set. Generate a 32-byte key with:  " +
        "node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))\""
    );
  }
  const trimmed = raw.trim();
  const asBase64 = safeBase64UrlDecode(trimmed);
  if (asBase64 && asBase64.length === KEY_BYTES) return asBase64;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    return Buffer.from(trimmed, "hex");
  }
  throw new BackupCryptoConfigError(
    "BACKUP_ENCRYPTION_KEY must be a 32-byte value encoded as base64url or hex."
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

/**
 * Derive a domain-separated 32-byte subkey from the master key. `info` is
 * bound into the derivation so a subkey used for one primitive can never
 * accidentally satisfy another primitive's key check.
 */
function deriveSubkey(masterKey: Buffer, info: string): Buffer {
  const derived = hkdfSync(HKDF_HASH, masterKey, Buffer.alloc(0), info, KEY_BYTES);
  return Buffer.from(derived);
}

/**
 * Materialize both derived subkeys in one call. Callers should discard the
 * returned buffers as soon as the underlying cipher/HMAC has consumed them
 * — the buffers are zeroed by `wipeSubkeys` at end of a normal request path.
 */
export function loadBackupSubkeys(): { encKey: Buffer; hmacKey: Buffer } {
  const master = loadBackupEncryptionKey();
  try {
    return {
      encKey: deriveSubkey(master, HKDF_INFO_ENC),
      hmacKey: deriveSubkey(master, HKDF_INFO_HMAC)
    };
  } finally {
    master.fill(0);
  }
}

/**
 * Zero out a subkey buffer after use. Best-effort — Node cannot guarantee
 * the buffer has not already been copied by the V8 heap — but it removes
 * the obvious lingering copy from a long-lived request-scope variable.
 */
export function wipeSubkeys(subkeys: { encKey: Buffer; hmacKey: Buffer }): void {
  subkeys.encKey.fill(0);
  subkeys.hmacKey.fill(0);
}

// ─── Streaming encryption ───────────────────────────────────────────────────

export interface BackupEncryptStream {
  /** The random IV used for this stream. Must be prepended to the ciphertext file. */
  iv: Buffer;
  /** Transform stream: write plaintext, read ciphertext. */
  transform: Transform;
  /** After the source stream ends, call this to obtain the 16-byte GCM auth tag. */
  finalize: () => Buffer;
}

/**
 * Build a streaming encrypter. The caller writes plaintext into
 * `transform`; ciphertext comes out the other end. After the source ends
 * (and `transform` has emitted 'end'), the caller MUST invoke `finalize()`
 * to obtain the auth tag and append it to the output stream. Failing to
 * append the tag renders the backup unusable — verification will detect
 * this and refuse to promote the backup to COMPLETED.
 */
export function createBackupEncryptStream(encKey: Buffer): BackupEncryptStream {
  if (encKey.length !== KEY_BYTES) {
    throw new BackupCryptoConfigError(
      "encKey must be a 32-byte buffer (use loadBackupSubkeys)."
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher: CipherGCM = createCipheriv(ALG, encKey, iv);

  const transform = new Transform({
    transform(chunk, _enc, cb) {
      try {
        // cipher.update returns a Buffer of already-encrypted bytes; we
        // push it downstream immediately so upstream backpressure works.
        cb(null, cipher.update(chunk));
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(cb) {
      try {
        cb(null, cipher.final());
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  return {
    iv,
    transform,
    finalize: () => cipher.getAuthTag()
  };
}

// ─── Streaming decryption ───────────────────────────────────────────────────

export interface BackupDecryptStream {
  transform: Transform;
}

/**
 * Build a streaming decrypter for a backup file that was produced by
 * `createBackupEncryptStream`. The caller MUST have already read the IV
 * from the first 12 bytes of the file AND the auth tag from the last 16
 * bytes; only the ciphertext (bytes 12..N-16) should be piped through
 * `transform`.
 *
 * A tampered ciphertext or wrong key causes `cipher.final()` to throw —
 * the resulting stream error MUST propagate to the caller. Callers must
 * never catch-and-swallow, and never treat a partial output as valid.
 */
export function createBackupDecryptStream(
  encKey: Buffer,
  iv: Buffer,
  authTag: Buffer
): BackupDecryptStream {
  if (encKey.length !== KEY_BYTES) {
    throw new BackupCryptoConfigError(
      "encKey must be a 32-byte buffer (use loadBackupSubkeys)."
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new BackupCryptoConfigError(
      `iv must be ${IV_BYTES} bytes, got ${iv.length}.`
    );
  }
  if (authTag.length !== TAG_BYTES) {
    throw new BackupCryptoConfigError(
      `authTag must be ${TAG_BYTES} bytes, got ${authTag.length}.`
    );
  }
  const decipher: DecipherGCM = createDecipheriv(ALG, encKey, iv);
  decipher.setAuthTag(authTag);

  const transform = new Transform({
    transform(chunk, _enc, cb) {
      try {
        cb(null, decipher.update(chunk));
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(cb) {
      try {
        // decipher.final() throws on tag mismatch — DO NOT swallow.
        cb(null, decipher.final());
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  return { transform };
}

// ─── Manifest HMAC ──────────────────────────────────────────────────────────

/**
 * Compute the manifest HMAC. Uses the derived `hmacKey`, NOT the master
 * key or the encKey — see the domain-separation comment at the top of the
 * file. Returns the raw 32-byte HMAC; the manifest embeds it hex-encoded.
 */
export function computeManifestHmac(hmacKey: Buffer, body: Buffer | string): Buffer {
  if (hmacKey.length !== KEY_BYTES) {
    throw new BackupCryptoConfigError(
      "hmacKey must be a 32-byte buffer (use loadBackupSubkeys)."
    );
  }
  return createHmac("sha256", hmacKey).update(body).digest();
}

/**
 * Constant-time verify a manifest HMAC. Returns `false` on wrong length
 * without leaking timing (still runs a pad comparison).
 */
export function verifyManifestHmac(
  hmacKey: Buffer,
  body: Buffer | string,
  expectedHex: string
): boolean {
  const expected = safeHexDecode(expectedHex);
  if (!expected) {
    // Wrong encoding — still burn the same amount of time.
    const pad = Buffer.alloc(32);
    timingSafeEqual(pad, pad);
    return false;
  }
  const actual = computeManifestHmac(hmacKey, body);
  if (actual.length !== expected.length) {
    const pad = Buffer.alloc(Math.max(actual.length, expected.length));
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function safeHexDecode(hex: string): Buffer | null {
  if (typeof hex !== "string") return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}

// ─── Ciphertext digest ─────────────────────────────────────────────────────

/**
 * Rolling SHA-256 for the on-disk ciphertext. The dump engine pipes each
 * ciphertext chunk through this hash while writing to disk. The final
 * digest is persisted as `Backup.contentSha256` so a truncated or swapped
 * file is detected BEFORE decryption is attempted — cheaper than running
 * a full decrypt just to check for corruption.
 */
export function createContentDigest(): { push: (chunk: Buffer) => void; digest: () => string } {
  const h = createHash("sha256");
  return {
    push: (chunk) => {
      h.update(chunk);
    },
    digest: () => h.digest("hex")
  };
}

// ─── Timing-safe string compare (for confirmation phrases, etc.) ────────────

/**
 * Constant-time string comparison — used by the restore confirmation-phrase
 * check. The email crypto module has a parallel helper; we duplicate here
 * so backup code does not depend on the email module for a security-
 * critical primitive.
 */
export function timingSafeStringEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    const pad = Buffer.alloc(Math.max(ab.length, bb.length, 1));
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

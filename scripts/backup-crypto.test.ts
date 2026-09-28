// Tests for lib/backup/crypto. Run with:
//   npm run test:backup-crypto
//
// Pure Node — no DB required.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const originalKey = process.env.BACKUP_ENCRYPTION_KEY;

before(() => {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
});

after(() => {
  if (originalKey === undefined) {
    delete process.env.BACKUP_ENCRYPTION_KEY;
  } else {
    process.env.BACKUP_ENCRYPTION_KEY = originalKey;
  }
});

// Helper: run plaintext through the encrypt stream, gather ciphertext +
// IV + tag. Mirrors what the dump engine will do end-to-end.
async function encryptAll(
  plaintext: Buffer,
  encKey: Buffer
): Promise<{ iv: Buffer; ciphertext: Buffer; tag: Buffer }> {
  const { createBackupEncryptStream } = await import("../lib/backup/crypto");
  const { iv, transform, finalize } = createBackupEncryptStream(encKey);
  const chunks: Buffer[] = [];
  transform.on("data", (c: Buffer) => chunks.push(c));
  await pipeline(Readable.from([plaintext]), transform);
  const tag = finalize();
  return { iv, ciphertext: Buffer.concat(chunks), tag };
}

async function decryptAll(
  ciphertext: Buffer,
  encKey: Buffer,
  iv: Buffer,
  tag: Buffer
): Promise<Buffer> {
  const { createBackupDecryptStream } = await import("../lib/backup/crypto");
  const { transform } = createBackupDecryptStream(encKey, iv, tag);
  const chunks: Buffer[] = [];
  transform.on("data", (c: Buffer) => chunks.push(c));
  await pipeline(Readable.from([ciphertext]), transform);
  return Buffer.concat(chunks);
}

describe("backup crypto — key loading", async () => {
  const { loadBackupEncryptionKey, loadBackupSubkeys, BackupCryptoConfigError } =
    await import("../lib/backup/crypto");

  test("accepts a valid base64url key", () => {
    const key = randomBytes(32).toString("base64url");
    process.env.BACKUP_ENCRYPTION_KEY = key;
    const buf = loadBackupEncryptionKey();
    assert.equal(buf.length, 32);
  });

  test("accepts a valid hex key", () => {
    const key = randomBytes(32).toString("hex");
    process.env.BACKUP_ENCRYPTION_KEY = key;
    const buf = loadBackupEncryptionKey();
    assert.equal(buf.length, 32);
  });

  test("throws BackupCryptoConfigError on missing key", () => {
    const saved = process.env.BACKUP_ENCRYPTION_KEY;
    delete process.env.BACKUP_ENCRYPTION_KEY;
    try {
      assert.throws(() => loadBackupEncryptionKey(), BackupCryptoConfigError);
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = saved;
    }
  });

  test("throws on short key", () => {
    process.env.BACKUP_ENCRYPTION_KEY = "too-short";
    assert.throws(() => loadBackupEncryptionKey(), BackupCryptoConfigError);
    // Restore for subsequent tests.
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  });

  test("throws on wrong-length hex", () => {
    process.env.BACKUP_ENCRYPTION_KEY = "deadbeef"; // 4 bytes
    assert.throws(() => loadBackupEncryptionKey(), BackupCryptoConfigError);
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  });

  test("domain separation: encKey and hmacKey are distinct", () => {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const { encKey, hmacKey } = loadBackupSubkeys();
    assert.equal(encKey.length, 32);
    assert.equal(hmacKey.length, 32);
    assert.notDeepEqual(encKey, hmacKey, "domain-separated subkeys must differ");
  });

  test("subkey derivation is deterministic for the same master key", () => {
    const key = randomBytes(32).toString("base64url");
    process.env.BACKUP_ENCRYPTION_KEY = key;
    const a = loadBackupSubkeys();
    const b = loadBackupSubkeys();
    assert.deepEqual(a.encKey, b.encKey);
    assert.deepEqual(a.hmacKey, b.hmacKey);
  });

  test("different master keys yield different subkeys", () => {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const a = loadBackupSubkeys();
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const b = loadBackupSubkeys();
    assert.notDeepEqual(a.encKey, b.encKey);
    assert.notDeepEqual(a.hmacKey, b.hmacKey);
  });
});

describe("backup crypto — streaming round-trip", async () => {
  const { loadBackupSubkeys } = await import("../lib/backup/crypto");

  test("empty input round-trips", async () => {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const { encKey } = loadBackupSubkeys();
    const { iv, ciphertext, tag } = await encryptAll(Buffer.alloc(0), encKey);
    assert.equal(iv.length, 12);
    assert.equal(tag.length, 16);
    const out = await decryptAll(ciphertext, encKey, iv, tag);
    assert.equal(out.length, 0);
  });

  test("small payload round-trips", async () => {
    const { encKey } = loadBackupSubkeys();
    const plain = Buffer.from("hello backup world 🌍");
    const { iv, ciphertext, tag } = await encryptAll(plain, encKey);
    const out = await decryptAll(ciphertext, encKey, iv, tag);
    assert.equal(out.toString("utf8"), plain.toString("utf8"));
  });

  test("large payload (2 MB) round-trips across many chunks", async () => {
    const { encKey } = loadBackupSubkeys();
    const plain = randomBytes(2 * 1024 * 1024);
    const { iv, ciphertext, tag } = await encryptAll(plain, encKey);
    assert.equal(ciphertext.length, plain.length, "GCM ciphertext == plaintext length");
    const out = await decryptAll(ciphertext, encKey, iv, tag);
    assert.deepEqual(out, plain);
  });

  test("distinct IVs across two encryptions of the same payload", async () => {
    const { encKey } = loadBackupSubkeys();
    const plain = Buffer.from("same plaintext");
    const a = await encryptAll(plain, encKey);
    const b = await encryptAll(plain, encKey);
    assert.notDeepEqual(a.iv, b.iv, "each encrypt must use a fresh IV");
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
    assert.notDeepEqual(a.tag, b.tag);
  });
});

describe("backup crypto — tampering detection", async () => {
  const { loadBackupSubkeys, createBackupDecryptStream } =
    await import("../lib/backup/crypto");

  test("flipped ciphertext byte → decrypt throws", async () => {
    const { encKey } = loadBackupSubkeys();
    const plain = Buffer.from("classified event registration data");
    const { iv, ciphertext, tag } = await encryptAll(plain, encKey);
    ciphertext[3] ^= 0x01; // flip one bit
    await assert.rejects(decryptAll(ciphertext, encKey, iv, tag));
  });

  test("flipped auth tag byte → decrypt throws", async () => {
    const { encKey } = loadBackupSubkeys();
    const plain = Buffer.from("classified event registration data");
    const { iv, ciphertext, tag } = await encryptAll(plain, encKey);
    tag[0] ^= 0x01;
    await assert.rejects(decryptAll(ciphertext, encKey, iv, tag));
  });

  test("wrong IV → decrypt throws (or produces gibberish + tag mismatch)", async () => {
    const { encKey } = loadBackupSubkeys();
    const plain = Buffer.from("classified event registration data");
    const { ciphertext, tag } = await encryptAll(plain, encKey);
    const wrongIv = randomBytes(12);
    await assert.rejects(decryptAll(ciphertext, encKey, wrongIv, tag));
  });

  test("wrong key → decrypt throws", async () => {
    const { encKey: goodKey } = loadBackupSubkeys();
    const plain = Buffer.from("classified event registration data");
    const { iv, ciphertext, tag } = await encryptAll(plain, goodKey);

    // Rotate the master key, get a different derived encKey
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const { encKey: badKey } = loadBackupSubkeys();
    await assert.rejects(decryptAll(ciphertext, badKey, iv, tag));
  });

  test("mismatched key/iv/tag sizes throw config errors up-front", async () => {
    const { BackupCryptoConfigError } = await import("../lib/backup/crypto");
    const { encKey } = loadBackupSubkeys();
    assert.throws(
      () => createBackupDecryptStream(encKey, randomBytes(11), randomBytes(16)),
      BackupCryptoConfigError
    );
    assert.throws(
      () => createBackupDecryptStream(encKey, randomBytes(12), randomBytes(15)),
      BackupCryptoConfigError
    );
    assert.throws(
      () => createBackupDecryptStream(randomBytes(31), randomBytes(12), randomBytes(16)),
      BackupCryptoConfigError
    );
  });
});

describe("backup crypto — manifest HMAC", async () => {
  const { loadBackupSubkeys, computeManifestHmac, verifyManifestHmac } =
    await import("../lib/backup/crypto");

  test("HMAC round-trips", () => {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const { hmacKey } = loadBackupSubkeys();
    const body = Buffer.from(JSON.stringify({ backupId: "cuid", size: 123 }));
    const tag = computeManifestHmac(hmacKey, body);
    assert.equal(tag.length, 32);
    assert.equal(verifyManifestHmac(hmacKey, body, tag.toString("hex")), true);
  });

  test("flipped byte in body → HMAC verify returns false", () => {
    const { hmacKey } = loadBackupSubkeys();
    const body = Buffer.from(JSON.stringify({ backupId: "cuid", size: 123 }));
    const tag = computeManifestHmac(hmacKey, body).toString("hex");
    const tampered = Buffer.from(body);
    tampered[10] ^= 0x01;
    assert.equal(verifyManifestHmac(hmacKey, tampered, tag), false);
  });

  test("wrong hmacKey → verify returns false", () => {
    const { hmacKey } = loadBackupSubkeys();
    const body = Buffer.from("manifest json");
    const tag = computeManifestHmac(hmacKey, body).toString("hex");
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const { hmacKey: rotated } = loadBackupSubkeys();
    assert.equal(verifyManifestHmac(rotated, body, tag), false);
  });

  test("malformed expected hex → verify returns false (no throw)", () => {
    const { hmacKey } = loadBackupSubkeys();
    const body = Buffer.from("m");
    assert.equal(verifyManifestHmac(hmacKey, body, "not-hex-!!"), false);
    assert.equal(verifyManifestHmac(hmacKey, body, "a1b2c3"), false); // right chars, wrong length
  });

  test("hmacKey and encKey are NOT interchangeable", () => {
    const { encKey, hmacKey } = loadBackupSubkeys();
    const body = Buffer.from("m");
    const tag = computeManifestHmac(hmacKey, body).toString("hex");
    assert.equal(verifyManifestHmac(encKey, body, tag), false);
  });
});

describe("backup crypto — content digest", async () => {
  const { createContentDigest } = await import("../lib/backup/crypto");

  test("digest is deterministic across many chunks", () => {
    const bytes = randomBytes(1024 * 1024);
    const singleShot = (() => {
      const d = createContentDigest();
      d.push(bytes);
      return d.digest();
    })();
    const chunked = (() => {
      const d = createContentDigest();
      for (let i = 0; i < bytes.length; i += 128) {
        d.push(bytes.subarray(i, i + 128));
      }
      return d.digest();
    })();
    assert.equal(singleShot, chunked);
  });

  test("digest changes when a single byte flips", () => {
    const a = randomBytes(2048);
    const b = Buffer.from(a);
    b[100] ^= 0x01;
    const da = (() => {
      const d = createContentDigest();
      d.push(a);
      return d.digest();
    })();
    const db = (() => {
      const d = createContentDigest();
      d.push(b);
      return d.digest();
    })();
    assert.notEqual(da, db);
  });
});

describe("backup crypto — timingSafeStringEquals", async () => {
  const { timingSafeStringEquals } = await import("../lib/backup/crypto");

  test("equal strings", () => {
    assert.equal(timingSafeStringEquals("RESTORE abc", "RESTORE abc"), true);
  });
  test("different strings same length", () => {
    assert.equal(timingSafeStringEquals("RESTORE abc", "RESTORE xyz"), false);
  });
  test("different lengths", () => {
    assert.equal(timingSafeStringEquals("RESTORE", "RESTORE!"), false);
  });
  test("both empty", () => {
    assert.equal(timingSafeStringEquals("", ""), true);
  });
});

describe("backup crypto — wipe subkeys", async () => {
  const { loadBackupSubkeys, wipeSubkeys } = await import("../lib/backup/crypto");

  test("wipe zeros the subkey buffers", () => {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const subkeys = loadBackupSubkeys();
    assert.notEqual(subkeys.encKey.reduce((s, b) => s + b, 0), 0);
    wipeSubkeys(subkeys);
    assert.equal(subkeys.encKey.reduce((s, b) => s + b, 0), 0);
    assert.equal(subkeys.hmacKey.reduce((s, b) => s + b, 0), 0);
  });
});

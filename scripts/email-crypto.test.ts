// Tests for lib/email/crypto. Run with:
//   npm run test:email-crypto
//
// Pure Node — no DB required.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";

const originalKey = process.env.EMAIL_SECRET_ENCRYPTION_KEY;

before(() => {
  process.env.EMAIL_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
});

after(() => {
  if (originalKey === undefined) {
    delete process.env.EMAIL_SECRET_ENCRYPTION_KEY;
  } else {
    process.env.EMAIL_SECRET_ENCRYPTION_KEY = originalKey;
  }
});

describe("email crypto", async () => {
  const { encryptSecret, decryptSecret, looksEncrypted, timingSafeStringEquals, secretFingerprint } =
    await import("../lib/email/crypto");

  test("round trip preserves plaintext", () => {
    const raw = "hunter2-with-symbols-!@#$%^&*()";
    const env = encryptSecret(raw);
    assert.equal(decryptSecret(env), raw);
  });

  test("distinct IVs produce distinct envelopes", () => {
    const raw = "same-plaintext";
    const a = encryptSecret(raw);
    const b = encryptSecret(raw);
    assert.notEqual(a, b, "IV should randomize each envelope");
    assert.equal(decryptSecret(a), raw);
    assert.equal(decryptSecret(b), raw);
  });

  test("looksEncrypted detects the v1 envelope shape", () => {
    const env = encryptSecret("x");
    assert.equal(looksEncrypted(env), true);
    assert.equal(looksEncrypted(""), false);
    assert.equal(looksEncrypted("hunter2"), false);
    assert.equal(looksEncrypted(null), false);
    assert.equal(looksEncrypted({} as unknown), false);
  });

  test("tampering with the tag fails to decrypt", () => {
    const env = encryptSecret("secret");
    const parts = env.split(":");
    // Flip a byte in the tag component.
    const tag = Buffer.from(parts[2], "base64url");
    tag[0] ^= 0x01;
    parts[2] = tag.toString("base64url");
    const tampered = parts.join(":");
    assert.throws(() => decryptSecret(tampered));
  });

  test("tampering with the ciphertext fails to decrypt", () => {
    const env = encryptSecret("secret");
    const parts = env.split(":");
    const ct = Buffer.from(parts[3], "base64url");
    if (ct.length > 0) ct[0] ^= 0x01;
    parts[3] = ct.toString("base64url");
    const tampered = parts.join(":");
    assert.throws(() => decryptSecret(tampered));
  });

  test("wrong key fails to decrypt", async () => {
    const env = encryptSecret("secret");
    const saved = process.env.EMAIL_SECRET_ENCRYPTION_KEY;
    process.env.EMAIL_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    try {
      // Re-import? Not needed — loadEncryptionKey reads env each call.
      assert.throws(() => decryptSecret(env));
    } finally {
      process.env.EMAIL_SECRET_ENCRYPTION_KEY = saved;
    }
  });

  test("timingSafeStringEquals handles equal / unequal / different lengths", () => {
    assert.equal(timingSafeStringEquals("hello", "hello"), true);
    assert.equal(timingSafeStringEquals("hello", "world"), false);
    assert.equal(timingSafeStringEquals("hello", "hello!"), false);
    assert.equal(timingSafeStringEquals("", ""), true);
  });

  test("secretFingerprint is deterministic and short", () => {
    const env = encryptSecret("secret");
    const a = secretFingerprint(env);
    const b = secretFingerprint(env);
    assert.equal(a, b);
    assert.equal(a.length, 12);
    // Fingerprint of a distinct envelope should differ.
    const env2 = encryptSecret("secret");
    assert.notEqual(secretFingerprint(env2), a);
  });

  test("missing key throws a clear config error", async () => {
    const saved = process.env.EMAIL_SECRET_ENCRYPTION_KEY;
    delete process.env.EMAIL_SECRET_ENCRYPTION_KEY;
    try {
      const { encryptSecret: encFresh, EmailCryptoConfigError } = await import(
        "../lib/email/crypto"
      );
      assert.throws(() => encFresh("x"), EmailCryptoConfigError);
    } finally {
      process.env.EMAIL_SECRET_ENCRYPTION_KEY = saved;
    }
  });

  test("garbage key length is rejected", async () => {
    const saved = process.env.EMAIL_SECRET_ENCRYPTION_KEY;
    process.env.EMAIL_SECRET_ENCRYPTION_KEY = "too-short";
    try {
      const { encryptSecret: encFresh, EmailCryptoConfigError } = await import(
        "../lib/email/crypto"
      );
      assert.throws(() => encFresh("x"), EmailCryptoConfigError);
    } finally {
      process.env.EMAIL_SECRET_ENCRYPTION_KEY = saved;
    }
  });
});

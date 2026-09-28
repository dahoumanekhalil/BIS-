// Tests for lib/backup/manifest. Run with:
//   npm run test:backup-manifest
//
// Pure Node — no DB required.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "crypto";

const originalKey = process.env.BACKUP_ENCRYPTION_KEY;

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

function baselineInput(hmacBackupId?: string): {
  backupId: string;
  createdAt: Date;
  kind: "MANUAL" | "SCHEDULED" | "SAFETY";
  appVersion: string;
  formatVersion: string;
  encryptionVersion: string;
  contentSha256: string;
  schemaSha256: string;
  schemaPrisma: string;
  sizeBytes: number;
  rowCounts: Record<string, number>;
} {
  const schemaText = "generator client { provider = \"prisma-client-js\" }\nmodel A { id String @id }";
  return {
    backupId: hmacBackupId ?? makeCuid(),
    createdAt: new Date("2026-09-26T02:00:00.000Z"),
    kind: "SCHEDULED",
    appVersion: "0.1.0",
    formatVersion: "1",
    encryptionVersion: "v1",
    contentSha256: "a".repeat(64),
    schemaSha256: createHash("sha256").update(schemaText).digest("hex"),
    schemaPrisma: schemaText,
    sizeBytes: 1234567,
    rowCounts: { AdminUser: 4, Participant: 128, AuditLog: 999 }
  };
}

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

describe("backup manifest — build + verify", async () => {
  const { buildSignedManifest, parseAndVerifyManifest, ManifestParseError, ManifestHmacError } =
    await import("../lib/backup/manifest");
  const { loadBackupSubkeys } = await import("../lib/backup/crypto");

  test("round-trip: build, parse, verify", () => {
    const { hmacKey } = loadBackupSubkeys();
    const bytes = buildSignedManifest(hmacKey, baselineInput());
    const parsed = parseAndVerifyManifest(hmacKey, bytes);
    assert.equal(parsed.manifestVersion, 1);
    assert.equal(parsed.rowCounts.Participant, 128);
    assert.equal(parsed.appVersion, "0.1.0");
    assert.equal(parsed.components[0], "database");
  });

  test("output is deterministic given the same input + key", () => {
    const { hmacKey } = loadBackupSubkeys();
    const input = baselineInput();
    const a = buildSignedManifest(hmacKey, input);
    const b = buildSignedManifest(hmacKey, input);
    assert.deepEqual(a, b, "canonicalization must produce identical bytes");
  });

  test("tampering with a byte in the JSON fails HMAC verify", () => {
    const { hmacKey } = loadBackupSubkeys();
    const bytes = buildSignedManifest(hmacKey, baselineInput());
    const tampered = Buffer.from(bytes);
    // Flip a byte inside the schema field somewhere.
    const idx = tampered.indexOf(Buffer.from("model A"));
    assert.ok(idx > 0, "expected schema fragment to be present");
    tampered[idx] ^= 0x01;
    assert.throws(() => parseAndVerifyManifest(hmacKey, tampered), ManifestHmacError);
  });

  test("wrong hmacKey → verify throws", () => {
    const { hmacKey } = loadBackupSubkeys();
    const bytes = buildSignedManifest(hmacKey, baselineInput());
    // Rotate master key → derived hmacKey changes.
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const { hmacKey: rotated } = loadBackupSubkeys();
    assert.throws(() => parseAndVerifyManifest(rotated, bytes), ManifestHmacError);
  });

  test("malformed JSON → ManifestParseError (not HMAC error)", () => {
    const { hmacKey } = loadBackupSubkeys();
    assert.throws(() => parseAndVerifyManifest(hmacKey, "not { json"), ManifestParseError);
  });

  test("valid JSON but wrong shape → ManifestParseError", () => {
    const { hmacKey } = loadBackupSubkeys();
    assert.throws(
      () => parseAndVerifyManifest(hmacKey, JSON.stringify({ backupId: "x" })),
      ManifestParseError
    );
  });

  test("unknown manifestVersion → ManifestParseError", () => {
    const { hmacKey } = loadBackupSubkeys();
    const bytes = buildSignedManifest(hmacKey, baselineInput());
    // Twiddle version 1 → 2 in the raw bytes and re-sign with an arbitrary
    // (wrong) hmac. Both parse (version rejection) and hmac fail; parse fires first.
    const s = bytes.toString("utf8").replace('"manifestVersion":1', '"manifestVersion":2');
    assert.throws(() => parseAndVerifyManifest(hmacKey, s), ManifestParseError);
  });

  test("oversized schemaPrisma → build throws via zod", () => {
    // We enforce max at zod parse; build doesn't validate up front, but
    // the produced bytes will fail to parse. Callers should validate
    // input via the schema themselves for early feedback. This test just
    // confirms the guard fires somewhere.
    const { hmacKey } = loadBackupSubkeys();
    const input = baselineInput();
    input.schemaPrisma = "x".repeat(600 * 1024); // 600 KB > 512 KB cap
    const bytes = buildSignedManifest(hmacKey, input);
    assert.throws(() => parseAndVerifyManifest(hmacKey, bytes));
  });

  test("empty rowCounts is allowed (edge case: brand new DB)", () => {
    const { hmacKey } = loadBackupSubkeys();
    const input = baselineInput();
    input.rowCounts = {};
    const bytes = buildSignedManifest(hmacKey, input);
    const parsed = parseAndVerifyManifest(hmacKey, bytes);
    assert.deepEqual(parsed.rowCounts, {});
  });

  test("HMAC hex is exactly 64 lowercase hex chars", () => {
    const { hmacKey } = loadBackupSubkeys();
    const bytes = buildSignedManifest(hmacKey, baselineInput());
    const parsed = JSON.parse(bytes.toString("utf8")) as { manifestHmac: string };
    assert.match(parsed.manifestHmac, /^[a-f0-9]{64}$/);
  });

  test("canonical form: keys are sorted at every level", () => {
    const { hmacKey } = loadBackupSubkeys();
    const bytes = buildSignedManifest(hmacKey, baselineInput());
    const s = bytes.toString("utf8");
    // Top-level keys should appear in sorted order.
    // We spot-check a few known key pairs.
    const posApp = s.indexOf('"appVersion"');
    const posBackup = s.indexOf('"backupId"');
    const posContent = s.indexOf('"contentSha256"');
    const posManifestV = s.indexOf('"manifestVersion"');
    assert.ok(posApp < posBackup);
    assert.ok(posBackup < posContent);
    assert.ok(posContent < posManifestV);
  });
});

describe("backup manifest — parseManifestUnverified", async () => {
  const { buildSignedManifest, parseManifestUnverified } = await import("../lib/backup/manifest");
  const { loadBackupSubkeys } = await import("../lib/backup/crypto");

  test("returns the manifest even without the correct hmacKey", () => {
    const { hmacKey } = loadBackupSubkeys();
    const bytes = buildSignedManifest(hmacKey, baselineInput());
    const parsed = parseManifestUnverified(bytes);
    assert.equal(parsed.rowCounts.Participant, 128);
  });

  test("still rejects malformed JSON / wrong shape", async () => {
    const { parseManifestUnverified: pmu } = await import("../lib/backup/manifest");
    assert.throws(() => pmu("not json"));
    assert.throws(() => pmu(JSON.stringify({ nope: 1 })));
  });
});

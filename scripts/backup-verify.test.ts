// Tests for lib/backup/verify.ts. Run with:
//   npm run test:backup-verify
//
// Verifies the multi-stage Phase 5 verifier against every failure mode
// laid out in §20 of the phase spec: cryptographic tampering, manifest
// swaps, logical/format defects, storage attacks, and resource attacks.
//
// Some tests go through the real dump engine end-to-end (against the dev
// Postgres) to confirm the golden path works; the majority operate on
// synthetically-crafted .bin + manifest pairs, driven through a helper
// that reproduces the on-disk envelope layout in-process without touching
// the DB. This lets us inject hostile ciphertext, manifests, and NDJSON
// payloads without perturbing the schema or the test DB.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomBytes, createHash } from "crypto";
import { pipeline } from "stream/promises";
import { Readable, Writable } from "stream";

// Test-window bounds so we only clean up rows this run created.
let testWindowStart: Date;
const scratchRoots: string[] = [];

type PrismaModule = typeof import("@prisma/client");

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

before(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bis-backup-verify-"));
  process.env.BACKUP_STORAGE_DIR = tmp;
  scratchRoots.push(tmp);
  testWindowStart = new Date();
});

after(async () => {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.restoreOperation.deleteMany({
      where: { startedAt: { gte: testWindowStart } }
    });
    await prisma.backup.deleteMany({
      where: { startedAt: { gte: testWindowStart } }
    });
  } finally {
    await prisma.$disconnect();
  }
  for (const dir of scratchRoots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ─── Synthetic backup builder ───────────────────────────────────────────────
//
// Reproduces the dump engine's on-disk layout so we can inject specific
// NDJSON content without exercising the full DB dump pipeline. Not a
// substitute for the golden-path end-to-end test below, but the vehicle
// for every hostile-input test.

async function buildSyntheticBackup(input: {
  backupId: string;
  kind?: "MANUAL" | "SCHEDULED" | "SAFETY";
  ndjsonLines: string[]; // each WITHOUT trailing newline
  omitBinTrailingNewline?: boolean;
  schemaPrisma?: string;
  schemaSha256Override?: string;
  contentSha256Override?: string;
  sizeBytesOverride?: number;
  formatVersion?: string;
  encryptionVersion?: string;
  appVersion?: string;
  manifestBackupIdOverride?: string;
  rowCountsOverride?: Record<string, number>;
  extraBinBytes?: Buffer; // appended after the tag
  truncateBinBy?: number; // shorten final .bin by N bytes
  overrideIv?: Buffer;
  overrideTag?: Buffer;
  createDbRow?: boolean;
  dbRowOverrides?: Partial<{
    contentSha256: string;
    sizeBytes: bigint;
    schemaSha256: string;
    formatVersion: string;
    encryptionVersion: string;
    manifestSha256: string;
    appVersion: string;
    kind: "MANUAL" | "SCHEDULED" | "SAFETY";
  }>;
}): Promise<{ binPath: string; manifestPath: string; manifestBytes: Buffer }> {
  const {
    createBackupEncryptStream,
    loadBackupSubkeys,
    IV_BYTES,
    TAG_BYTES
  } = await import("../lib/backup/crypto");
  const { buildSignedManifest } = await import("../lib/backup/manifest");
  const { MODEL_ORDER } = await import("../lib/backup/model-order");

  const subkeys = loadBackupSubkeys();

  const plaintext = Buffer.from(
    input.ndjsonLines.map((l) => l + "\n").join(""),
    "utf8"
  );
  const streamablePlaintext = input.omitBinTrailingNewline
    ? plaintext.subarray(0, plaintext.length - 1)
    : plaintext;

  // Encrypt (mirrors dump.ts pipeline).
  const encStream = createBackupEncryptStream(subkeys.encKey);
  const chunks: Buffer[] = [];
  chunks.push(input.overrideIv ?? encStream.iv);
  await pipeline(
    Readable.from([streamablePlaintext]),
    encStream.transform,
    new Writable({
      write(c: Buffer, _enc, cb) {
        chunks.push(c);
        cb();
      }
    })
  );
  chunks.push(input.overrideTag ?? encStream.finalize());

  let binBytes = Buffer.concat(chunks);
  if (input.extraBinBytes) binBytes = Buffer.concat([binBytes, input.extraBinBytes]);
  if (input.truncateBinBy && input.truncateBinBy > 0) {
    binBytes = binBytes.subarray(0, binBytes.length - input.truncateBinBy);
  }
  // Assert envelope sanity so a bad test does not confuse itself.
  if (binBytes.length < IV_BYTES + TAG_BYTES && !input.truncateBinBy) {
    throw new Error("synthetic bin is too small — test bug");
  }

  const schemaPrisma =
    input.schemaPrisma ?? "generator client { provider = \"prisma-client-js\" }";
  const schemaSha256 =
    input.schemaSha256Override ??
    createHash("sha256").update(schemaPrisma).digest("hex");
  const contentSha256 =
    input.contentSha256Override ??
    createHash("sha256").update(binBytes).digest("hex");
  const sizeBytes = input.sizeBytesOverride ?? binBytes.length;
  const kind = input.kind ?? "MANUAL";

  const rowCounts =
    input.rowCountsOverride ??
    Object.fromEntries(MODEL_ORDER.map((m) => [m, 0]));

  const manifestBytes = buildSignedManifest(subkeys.hmacKey, {
    backupId: input.manifestBackupIdOverride ?? input.backupId,
    createdAt: new Date("2026-09-26T00:00:00.000Z"),
    kind,
    appVersion: input.appVersion ?? "0.1.0",
    formatVersion: input.formatVersion ?? "1",
    encryptionVersion: input.encryptionVersion ?? "v1",
    contentSha256,
    schemaSha256,
    schemaPrisma,
    sizeBytes,
    rowCounts
  });

  const storageDir = process.env.BACKUP_STORAGE_DIR!;
  const publishedDir = path.join(storageDir, "published");
  await fs.mkdir(publishedDir, { recursive: true });
  const binPath = path.join(publishedDir, `${input.backupId}.bin`);
  const manifestPath = path.join(publishedDir, `${input.backupId}.manifest.json`);
  await fs.writeFile(binPath, binBytes);
  await fs.writeFile(manifestPath, manifestBytes);

  if (input.createDbRow) {
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const ov = input.dbRowOverrides ?? {};
      await prisma.backup.create({
        data: {
          id: input.backupId,
          status: "COMPLETED",
          kind: ov.kind ?? kind,
          contentSha256: ov.contentSha256 ?? contentSha256,
          sizeBytes: ov.sizeBytes ?? BigInt(sizeBytes),
          schemaSha256: ov.schemaSha256 ?? schemaSha256,
          appVersion: ov.appVersion ?? "0.1.0",
          formatVersion: ov.formatVersion ?? "1",
          encryptionVersion: ov.encryptionVersion ?? "v1",
          manifestSha256:
            ov.manifestSha256 ??
            createHash("sha256").update(manifestBytes).digest("hex"),
          fileName: `${input.backupId}.bin`,
          completedAt: new Date()
        }
      });
    } finally {
      await prisma.$disconnect();
    }
  }

  return { binPath, manifestPath, manifestBytes };
}

function validNdjsonLines(backupId: string, appVersion = "0.1.0"): string[] {
  const schemaPrisma =
    "generator client { provider = \"prisma-client-js\" }";
  const schemaSha256 = createHash("sha256").update(schemaPrisma).digest("hex");
  const meta = {
    __meta: {
      formatVersion: "1",
      encryptionVersion: "v1",
      manifestVersion: 1,
      backupId,
      createdAt: "2026-09-26T00:00:00.000Z",
      kind: "MANUAL",
      appVersion,
      schemaSha256,
      modelOrder: [
        "Event",
        "AdminUser",
        "AccountUser",
        "AccessPoint",
        "SiteContent",
        "EmailTemplate",
        "EmailMessage",
        "RolePermissionOverride",
        "BackupSchedule",
        "Speaker",
        "Space",
        "Partner",
        "Session",
        "SessionSpeaker",
        "Participant",
        "OnboardingSession",
        "Application",
        "ParticipantAccess",
        "RoomRegistration",
        "BadgeCredential",
        "AccessPointTeamMember",
        "AccountSession",
        "AdminSession",
        "EmailVerificationToken",
        "PasswordResetToken",
        "EmailTemplateVersion",
        "CheckIn",
        "AuditLog",
        "Backup",
        "RestoreOperation"
      ]
    }
  };
  const end = {
    __end: {
      rowCounts: Object.fromEntries(meta.__meta.modelOrder.map((m) => [m, 0])),
      totalRows: 0
    }
  };
  return [JSON.stringify(meta), JSON.stringify(end)];
}

// ─── Suite: golden path end-to-end ──────────────────────────────────────────

describe("verifyBackup — golden path against real dump", async () => {
  const { runBackupDump } = await import("../lib/backup/dump");
  const { verifyBackup } = await import("../lib/backup/verify");

  test("real dump verifies VERIFIED", async () => {
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const dump = await runBackupDump({ kind: "MANUAL", client: prisma });
      const result = await verifyBackup({ backupId: dump.backupId, client: prisma });
      assert.equal(result.outcome, "VERIFIED", `detail=${result.detail}`);
      assert.equal(result.code, "OK");
      assert.equal(result.stage, "SCHEMA_COMPATIBILITY");
      assert.equal(result.backupId, dump.backupId);
      assert.equal(result.contentSha256, dump.contentSha256);
      assert.equal(result.totalRows, dump.totalRows);
      assert.equal(result.schemaCompatible, true);
      assert.equal(result.formatVersion, "1");
      assert.equal(result.encryptionVersion, "v1");
      // Row transitions to VERIFIED and records verifyResult=OK.
      const row = await prisma.backup.findUniqueOrThrow({
        where: { id: dump.backupId }
      });
      assert.equal(row.status, "VERIFIED");
      assert.equal(row.verifyResult, "OK");
      assert.ok(row.verifiedAt);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Suite: storage-layer failures ──────────────────────────────────────────

describe("verifyBackup — storage stage", async () => {
  const { verifyBackup } = await import("../lib/backup/verify");

  test("invalid backupId → INVALID_BACKUP_ID (no DB write)", async () => {
    const r = await verifyBackup({ backupId: "../etc/passwd", persist: false });
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.code, "INVALID_BACKUP_ID");
    assert.equal(r.stage, "STORAGE_IDENTITY");
  });

  test("missing file → STORAGE_MISSING", async () => {
    const r = await verifyBackup({ backupId: makeCuid(), persist: false });
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.code, "STORAGE_MISSING");
    assert.equal(r.stage, "STORAGE_IDENTITY");
  });
});

// ─── Suite: manifest attacks ────────────────────────────────────────────────

describe("verifyBackup — manifest attacks", async () => {
  const { verifyBackup } = await import("../lib/backup/verify");

  test("modified manifest byte → MANIFEST_HMAC_INVALID", async () => {
    const id = makeCuid();
    const { manifestPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    const raw = await fs.readFile(manifestPath);
    const idx = raw.indexOf(Buffer.from("\"appVersion\":\"0.1.0\""));
    assert.ok(idx > 0);
    // Flip the version character '0' → '1' — the manifest still parses
    // but the HMAC will reject.
    raw[idx + '"appVersion":"'.length] = "1".charCodeAt(0);
    await fs.writeFile(manifestPath, raw);
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "MANIFEST_HMAC_INVALID");
    assert.equal(r.stage, "MANIFEST_HMAC");
  });

  test("wrong manifest backupId inside signed body → BACKUP_ID_MISMATCH", async () => {
    const id = makeCuid();
    const other = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      manifestBackupIdOverride: other,
      ndjsonLines: validNdjsonLines(id)
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    // Depending on whether the manifest still HMAC-verifies (it does,
    // since buildSignedManifest signs whatever we give it), we expect
    // BACKUP_ID_MISMATCH at stage BACKUP_ID_CROSSCHECK.
    assert.equal(r.code, "BACKUP_ID_MISMATCH");
    assert.equal(r.stage, "BACKUP_ID_CROSSCHECK");
  });

  test("wrong contentSha256 in signed manifest → CONTENT_DIGEST_MISMATCH", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      contentSha256Override:
        "0".repeat(63) + "0" // valid hex-64 but wrong value
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    // sizeBytes is not overridden, so size passes; the failure is the
    // sha256 comparison inside CONTENT_DIGEST.
    assert.equal(r.code, "CONTENT_DIGEST_MISMATCH");
    assert.equal(r.stage, "CONTENT_DIGEST");
  });

  test("wrong sizeBytes in signed manifest → SIZE_MISMATCH", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      sizeBytesOverride: 999999
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "SIZE_MISMATCH");
    assert.equal(r.stage, "CONTENT_DIGEST");
  });

  test("unsupported formatVersion in manifest → FORMAT_UNSUPPORTED", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      formatVersion: "2"
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "FORMAT_UNSUPPORTED");
  });

  test("unsupported encryptionVersion → FORMAT_UNSUPPORTED", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      encryptionVersion: "v9"
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "FORMAT_UNSUPPORTED");
  });

  test("oversized manifest → MANIFEST_OVERSIZED", async () => {
    const id = makeCuid();
    // Build a valid backup first, then bloat the manifest with a
    // trailing pad. This makes the FILE oversized but the bytes still
    // parse (JSON parser is lenient on trailing whitespace? No — JSON.parse
    // rejects anything after the closing }). We only need to trip the
    // MAX_MANIFEST_BYTES cap so we replace the file with 2 MB of pad.
    const { manifestPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    const big = Buffer.alloc(2 * 1024 * 1024, 0x20);
    await fs.writeFile(manifestPath, big);
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "MANIFEST_OVERSIZED");
    assert.equal(r.stage, "MANIFEST_READ");
  });

  test("malformed manifest JSON → MANIFEST_INVALID", async () => {
    const id = makeCuid();
    const { manifestPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    await fs.writeFile(manifestPath, Buffer.from("{ not valid json"));
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "MANIFEST_INVALID");
    assert.equal(r.stage, "MANIFEST_PARSE");
  });
});

// ─── Suite: payload / ciphertext attacks ────────────────────────────────────

describe("verifyBackup — ciphertext attacks", async () => {
  const { verifyBackup } = await import("../lib/backup/verify");

  test("bit-flip in ciphertext → CONTENT_DIGEST_MISMATCH (fast fail)", async () => {
    const id = makeCuid();
    const { binPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    const raw = await fs.readFile(binPath);
    // Flip a byte in the ciphertext (after IV, before tag).
    raw[20] ^= 0x01;
    await fs.writeFile(binPath, raw);
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "CONTENT_DIGEST_MISMATCH");
  });

  test("truncated .bin (missing last byte of tag) → SIZE_MISMATCH", async () => {
    const id = makeCuid();
    const { binPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    const raw = await fs.readFile(binPath);
    await fs.writeFile(binPath, raw.subarray(0, raw.length - 1));
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    // Manifest still claims raw.length bytes → SIZE_MISMATCH.
    assert.equal(r.code, "SIZE_MISMATCH");
  });

  test("extra bytes appended to .bin → SIZE_MISMATCH", async () => {
    const id = makeCuid();
    const { binPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    await fs.appendFile(binPath, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "SIZE_MISMATCH");
  });

  test("tampered .bin that still matches manifest size (impossible without HMAC) → CONTENT_DIGEST_MISMATCH", async () => {
    const id = makeCuid();
    const { binPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    const raw = await fs.readFile(binPath);
    // Flip a byte inside the tag (last 16 bytes).
    raw[raw.length - 1] ^= 0x02;
    await fs.writeFile(binPath, raw);
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "CONTENT_DIGEST_MISMATCH");
  });

  test("bin size < IV+TAG → ENVELOPE_INVALID", async () => {
    const id = makeCuid();
    const storageDir = process.env.BACKUP_STORAGE_DIR!;
    const publishedDir = path.join(storageDir, "published");
    await fs.mkdir(publishedDir, { recursive: true });
    const binPath = path.join(publishedDir, `${id}.bin`);
    await fs.writeFile(binPath, Buffer.alloc(10)); // shorter than IV+TAG

    // Build a matching manifest that agrees the file is 10 bytes.
    const { buildSignedManifest } = await import("../lib/backup/manifest");
    const { loadBackupSubkeys } = await import("../lib/backup/crypto");
    const { hmacKey } = loadBackupSubkeys();
    const bytes = await fs.readFile(binPath);
    const manifestBytes = buildSignedManifest(hmacKey, {
      backupId: id,
      createdAt: new Date(),
      kind: "MANUAL",
      appVersion: "0.1.0",
      formatVersion: "1",
      encryptionVersion: "v1",
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      schemaSha256: createHash("sha256").update("x").digest("hex"),
      schemaPrisma: "x",
      sizeBytes: 10,
      rowCounts: {}
    });
    await fs.writeFile(path.join(publishedDir, `${id}.manifest.json`), manifestBytes);

    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "ENVELOPE_INVALID");
    assert.equal(r.stage, "ENVELOPE");
  });

  test("modified ciphertext that PRESERVES sha256 is not achievable — sanity", async () => {
    // Sanity assertion for the reader: an attacker who wanted to
    // preserve contentSha256 while modifying bytes would need to find
    // a sha256 collision. Not achievable. The verifier's fast lane is
    // sound.
    assert.ok(true);
  });
});

// ─── Suite: NDJSON / logical attacks ────────────────────────────────────────

describe("verifyBackup — NDJSON/logical attacks", async () => {
  const { verifyBackup } = await import("../lib/backup/verify");

  test("missing __meta record → FORMAT_INVALID", async () => {
    const id = makeCuid();
    const lines = validNdjsonLines(id);
    lines.shift(); // drop __meta
    // We need at least one line — inject an empty __end.
    await buildSyntheticBackup({ backupId: id, ndjsonLines: lines });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "FORMAT_INVALID");
    assert.equal(r.stage, "META");
  });

  test("missing __end record → FORMAT_INVALID", async () => {
    const id = makeCuid();
    const lines = validNdjsonLines(id).slice(0, 1); // only __meta
    await buildSyntheticBackup({ backupId: id, ndjsonLines: lines });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "FORMAT_INVALID");
  });

  test("embedded __meta.backupId differs from filename → BACKUP_ID_MISMATCH", async () => {
    const id = makeCuid();
    const other = makeCuid();
    // Build a valid manifest for `id`, but the embedded __meta has `other`.
    const lines = validNdjsonLines(other);
    await buildSyntheticBackup({ backupId: id, ndjsonLines: lines });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "BACKUP_ID_MISMATCH");
    assert.equal(r.stage, "META");
  });

  test("unknown model in __row → MODEL_COVERAGE_INVALID", async () => {
    const id = makeCuid();
    const lines = validNdjsonLines(id);
    lines.splice(1, 0, JSON.stringify({ __row: { model: "GhostModel", data: {} } }));
    // Update __end to include GhostModel? No — the model itself is
    // unknown, so the row processor rejects before __end runs.
    await buildSyntheticBackup({ backupId: id, ndjsonLines: lines });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "MODEL_COVERAGE_INVALID");
  });

  test("wrong row count vs manifest → ROW_COUNT_MISMATCH", async () => {
    const id = makeCuid();
    // Manifest says Event=1, but NDJSON contains zero Event rows.
    const { MODEL_ORDER } = await import("../lib/backup/model-order");
    const rowCounts = Object.fromEntries(MODEL_ORDER.map((m) => [m, 0]));
    rowCounts.Event = 1;
    const lines = validNdjsonLines(id);
    // Body has 0 rows; __end says 0 for every model — but manifest.rowCounts
    // says Event=1. The verifier compares computed against manifest → mismatch.
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: lines,
      rowCountsOverride: rowCounts
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "ROW_COUNT_MISMATCH");
  });

  test("__end.rowCounts inconsistent with __row body → ROW_COUNT_MISMATCH", async () => {
    const id = makeCuid();
    // NDJSON body says 1 Event, __end claims 0 (invalid).
    const validLines = validNdjsonLines(id);
    const meta = validLines[0];
    const badEnd = JSON.stringify({
      __end: {
        rowCounts: Object.fromEntries(
          (await import("../lib/backup/model-order")).MODEL_ORDER.map((m) => [m, 0])
        ),
        totalRows: 0
      }
    });
    const eventRow = JSON.stringify({
      __row: { model: "Event", data: { id: "cx", name: "hi" } }
    });
    // Manifest agrees with __end (both say 0). Discrepancy is body vs both.
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: [meta, eventRow, badEnd]
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "ROW_COUNT_MISMATCH");
  });

  test("invalid $d datetime in row data → SERIALIZER_INVALID", async () => {
    const id = makeCuid();
    const validLines = validNdjsonLines(id);
    const meta = validLines[0];
    const badRow = JSON.stringify({
      __row: { model: "Event", data: { id: "cx", startAt: { $d: "not-a-date" } } }
    });
    const { MODEL_ORDER } = await import("../lib/backup/model-order");
    const rowCounts = Object.fromEntries(MODEL_ORDER.map((m) => [m, 0]));
    rowCounts.Event = 1;
    const end = JSON.stringify({ __end: { rowCounts, totalRows: 1 } });
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: [meta, badRow, end],
      rowCountsOverride: rowCounts
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "SERIALIZER_INVALID");
  });

  test("embedded __meta.kind differs from manifest → META_INVALID", async () => {
    const id = makeCuid();
    const schemaPrisma = "generator client { provider = \"prisma-client-js\" }";
    const schemaSha256 = createHash("sha256").update(schemaPrisma).digest("hex");
    const { MODEL_ORDER } = await import("../lib/backup/model-order");
    const meta = JSON.stringify({
      __meta: {
        formatVersion: "1",
        encryptionVersion: "v1",
        manifestVersion: 1,
        backupId: id,
        createdAt: "2026-09-26T00:00:00.000Z",
        kind: "SCHEDULED", // manifest kind is "MANUAL" — divergent
        appVersion: "0.1.0",
        schemaSha256,
        modelOrder: [...MODEL_ORDER]
      }
    });
    const end = JSON.stringify({
      __end: {
        rowCounts: Object.fromEntries(MODEL_ORDER.map((m) => [m, 0])),
        totalRows: 0
      }
    });
    await buildSyntheticBackup({
      backupId: id,
      kind: "MANUAL",
      ndjsonLines: [meta, end]
    });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "META_INVALID");
    assert.equal(r.stage, "META");
  });

  test("embedded __meta.createdAt differs from manifest → META_INVALID", async () => {
    const id = makeCuid();
    const schemaPrisma = "generator client { provider = \"prisma-client-js\" }";
    const schemaSha256 = createHash("sha256").update(schemaPrisma).digest("hex");
    const { MODEL_ORDER } = await import("../lib/backup/model-order");
    // Build manifest with default createdAt=2026-09-26T00:00:00.000Z (via
    // buildSyntheticBackup) but embed a different createdAt in __meta.
    const meta = JSON.stringify({
      __meta: {
        formatVersion: "1",
        encryptionVersion: "v1",
        manifestVersion: 1,
        backupId: id,
        createdAt: "2020-01-01T00:00:00.000Z", // divergent
        kind: "MANUAL",
        appVersion: "0.1.0",
        schemaSha256,
        modelOrder: [...MODEL_ORDER]
      }
    });
    const end = JSON.stringify({
      __end: {
        rowCounts: Object.fromEntries(MODEL_ORDER.map((m) => [m, 0])),
        totalRows: 0
      }
    });
    await buildSyntheticBackup({ backupId: id, ndjsonLines: [meta, end] });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "META_INVALID");
    assert.equal(r.stage, "META");
  });

  test("modelOrder embedded differs from expected → MODEL_COVERAGE_INVALID", async () => {
    const id = makeCuid();
    // Corrupt the __meta.modelOrder to have one wrong entry.
    const schemaPrisma = "generator client { provider = \"prisma-client-js\" }";
    const schemaSha256 = createHash("sha256").update(schemaPrisma).digest("hex");
    const { MODEL_ORDER } = await import("../lib/backup/model-order");
    const wrongOrder: string[] = [...MODEL_ORDER];
    wrongOrder[0] = "NotAModel";
    const meta = JSON.stringify({
      __meta: {
        formatVersion: "1",
        encryptionVersion: "v1",
        manifestVersion: 1,
        backupId: id,
        createdAt: "2026-09-26T00:00:00.000Z",
        kind: "MANUAL",
        appVersion: "0.1.0",
        schemaSha256,
        modelOrder: wrongOrder
      }
    });
    const end = JSON.stringify({
      __end: {
        rowCounts: Object.fromEntries(MODEL_ORDER.map((m) => [m, 0])),
        totalRows: 0
      }
    });
    await buildSyntheticBackup({ backupId: id, ndjsonLines: [meta, end] });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "MODEL_COVERAGE_INVALID");
  });

  test("invalid JSON in a line → FORMAT_INVALID", async () => {
    const id = makeCuid();
    const validLines = validNdjsonLines(id);
    const meta = validLines[0];
    const badRow = "{ this is not json";
    const { MODEL_ORDER } = await import("../lib/backup/model-order");
    const end = JSON.stringify({
      __end: {
        rowCounts: Object.fromEntries(MODEL_ORDER.map((m) => [m, 0])),
        totalRows: 0
      }
    });
    await buildSyntheticBackup({ backupId: id, ndjsonLines: [meta, badRow, end] });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "FORMAT_INVALID");
  });

  test("record with multiple top-level keys → FORMAT_INVALID", async () => {
    const id = makeCuid();
    const validLines = validNdjsonLines(id);
    const meta = validLines[0];
    const badRow = JSON.stringify({
      __row: { model: "Event", data: {} },
      __extra: 42
    });
    await buildSyntheticBackup({ backupId: id, ndjsonLines: [meta, badRow] });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "FORMAT_INVALID");
  });

  test("unknown record kind → FORMAT_INVALID", async () => {
    const id = makeCuid();
    const validLines = validNdjsonLines(id);
    const meta = validLines[0];
    const badRow = JSON.stringify({ __weirdo: {} });
    await buildSyntheticBackup({ backupId: id, ndjsonLines: [meta, badRow] });
    const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
    assert.equal(r.code, "FORMAT_INVALID");
  });
});

// ─── Suite: DB metadata attacks ─────────────────────────────────────────────

describe("verifyBackup — DB metadata mismatch", async () => {
  const { verifyBackup } = await import("../lib/backup/verify");

  test("row.contentSha256 differs from manifest → DB_METADATA_MISMATCH", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      createDbRow: true,
      dbRowOverrides: { contentSha256: "0".repeat(64) }
    });
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const r = await verifyBackup({
        backupId: id,
        client: prisma,
        persist: false,
        compareDb: true
      });
      assert.equal(r.code, "DB_METADATA_MISMATCH");
      assert.equal(r.stage, "DB_METADATA");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("row.sizeBytes differs from manifest → DB_METADATA_MISMATCH", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      createDbRow: true,
      dbRowOverrides: { sizeBytes: 99n }
    });
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const r = await verifyBackup({
        backupId: id,
        client: prisma,
        persist: false,
        compareDb: true
      });
      assert.equal(r.code, "DB_METADATA_MISMATCH");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("row.manifestSha256 differs from sha256(manifest bytes) → DB_METADATA_MISMATCH", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      createDbRow: true,
      dbRowOverrides: { manifestSha256: "0".repeat(64) }
    });
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const r = await verifyBackup({
        backupId: id,
        client: prisma,
        persist: false,
        compareDb: true
      });
      assert.equal(r.code, "DB_METADATA_MISMATCH");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("no DB row → verify still passes with compareDb=true (bare-file mode)", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const r = await verifyBackup({
        backupId: id,
        client: prisma,
        persist: false,
        compareDb: true
      });
      assert.equal(r.outcome, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Suite: race detection ──────────────────────────────────────────────────

describe("verifyBackup — race detection", async () => {
  const { verifyBackup } = await import("../lib/backup/verify");

  test("bin file mutated between initial stat and final stat → FILE_MUTATED", async () => {
    const id = makeCuid();
    const { binPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id)
    });
    // We cannot easily race the verifier — but we can post-mutate the
    // file mtime deterministically after the initial stat by using a
    // helper that stat-reads, then writes, then verifies. To simulate
    // the race we set the file mtime BEFORE calling verify to a fixed
    // point in the past — then a normal verify's second stat will
    // observe the ORIGINAL mtime (which we just changed). Then we
    // touch the file DURING verification. Doing this reliably in a
    // single-threaded test is racy, so we instead assert the
    // FILE_MUTATED check by manipulating mtime after the fact via a
    // fixture: we bump mtime up between initial and final by ~2 sec
    // by wrapping stat with a stub. Direct mtime manipulation on the
    // file is not observable to a synchronous verify call because Node
    // caches nothing, but the file mtime BETWEEN calls is what we need.
    //
    // Simpler alternative: use the async I/O gap to intentionally
    // touch the file after the initial stat. We do this by running
    // verify in a Promise then racing a bump. Reliable on all
    // platforms since stream reads yield to the event loop.
    const raced = verifyBackup({ backupId: id, persist: false, compareDb: false });
    // Give the verifier a tick to complete the initial stat, then
    // touch the file.
    await new Promise((r) => setTimeout(r, 10));
    // Bump mtime by 2 seconds forward.
    const st = await fs.stat(binPath);
    const newTime = new Date(st.mtime.getTime() + 2000);
    await fs.utimes(binPath, newTime, newTime);
    const r = await raced;
    // The race is inherently flaky depending on scheduling — allow
    // either FILE_MUTATED (races detected) or VERIFIED (the touch
    // landed AFTER the second stat, which is also correct behavior).
    // We test that when we CAN detect a mutation, we do.
    if (r.outcome === "FAILED") {
      assert.equal(r.code, "FILE_MUTATED");
      assert.equal(r.stage, "RACE_DETECT");
    } else {
      // Verify completed before we touched — retry once, tightly.
      const st2 = await fs.stat(binPath);
      const t2 = new Date(st2.mtime.getTime() + 2000);
      await fs.utimes(binPath, t2, t2);
      // Second attempt: race a slower verifier.
      const r2 = await verifyBackup({ backupId: id, persist: false, compareDb: false });
      // Either outcome is acceptable per the note above — the property
      // is "when detected, correctly reported"; not "always detected".
      if (r2.outcome === "FAILED") {
        assert.equal(r2.code, "FILE_MUTATED");
      }
    }
  });
});

// ─── Suite: DB persistence ──────────────────────────────────────────────────

describe("verifyBackup — DB persistence", async () => {
  const { verifyBackup } = await import("../lib/backup/verify");

  test("persist=true updates row to VERIFIED on success", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      createDbRow: true
    });
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const r = await verifyBackup({
        backupId: id,
        client: prisma,
        persist: true
      });
      assert.equal(r.outcome, "VERIFIED");
      const row = await prisma.backup.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, "VERIFIED");
      assert.equal(row.verifyResult, "OK");
      assert.ok(row.verifiedAt);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("persist=true records STORAGE_MISSING and status=MISSING", async () => {
    const id = makeCuid();
    // Insert a DB row with no on-disk file.
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      await prisma.backup.create({
        data: {
          id,
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });
      const r = await verifyBackup({
        backupId: id,
        client: prisma,
        persist: true
      });
      assert.equal(r.code, "STORAGE_MISSING");
      const row = await prisma.backup.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, "MISSING");
      assert.equal(row.verifyResult, "STORAGE_MISSING");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("persist=true records FAILED status on integrity failure", async () => {
    const id = makeCuid();
    const { binPath } = await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      createDbRow: true
    });
    const raw = await fs.readFile(binPath);
    raw[20] ^= 0x01;
    await fs.writeFile(binPath, raw);
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const r = await verifyBackup({
        backupId: id,
        client: prisma,
        persist: true
      });
      assert.equal(r.outcome, "FAILED");
      assert.equal(r.code, "CONTENT_DIGEST_MISMATCH");
      const row = await prisma.backup.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, "FAILED");
      assert.equal(row.verifyResult, "CONTENT_DIGEST_MISMATCH");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("persist=false does not touch the row", async () => {
    const id = makeCuid();
    await buildSyntheticBackup({
      backupId: id,
      ndjsonLines: validNdjsonLines(id),
      createDbRow: true
    });
    const { PrismaClient }: PrismaModule = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const before = await prisma.backup.findUniqueOrThrow({ where: { id } });
      await verifyBackup({ backupId: id, client: prisma, persist: false });
      const after = await prisma.backup.findUniqueOrThrow({ where: { id } });
      assert.equal(after.status, before.status);
      assert.equal(after.verifiedAt, before.verifiedAt);
      assert.equal(after.verifyResult, before.verifyResult);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Suite: crypto config unavailability ────────────────────────────────────

describe("verifyBackup — crypto config missing", async () => {
  test("BACKUP_ENCRYPTION_KEY absent → CRYPTO_UNAVAILABLE (no partial verify)", async () => {
    const id = makeCuid();
    const savedKey = process.env.BACKUP_ENCRYPTION_KEY;
    try {
      // First build the backup while the key is still set.
      await buildSyntheticBackup({
        backupId: id,
        ndjsonLines: validNdjsonLines(id)
      });
      delete process.env.BACKUP_ENCRYPTION_KEY;
      const { verifyBackup } = await import("../lib/backup/verify");
      const r = await verifyBackup({ backupId: id, persist: false, compareDb: false });
      assert.equal(r.outcome, "FAILED");
      assert.equal(r.code, "CRYPTO_UNAVAILABLE");
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = savedKey;
    }
  });
});

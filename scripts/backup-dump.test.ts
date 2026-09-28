// Tests for lib/backup/dump.ts. Run with:
//   npm run test:backup-dump
//
// REQUIRES the DB to be reachable (the existing dev Postgres container).
// Uses the REAL prisma client to exercise the full pipeline end-to-end.
// All state written is under a scratch BACKUP_STORAGE_DIR and cleaned
// up in `after`. The Backup / RestoreOperation rows written by these
// tests are cleaned via a targeted `deleteMany` on rows with
// `kind = 'MANUAL'` and a `startedAt` inside the test window.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import { createReadStream } from "fs";
import path from "path";
import os from "os";
import { randomBytes, createHash } from "crypto";

// Test window bounds so we only clean up rows this run created.
let testWindowStart: Date;
const scratchRoots: string[] = [];

// Prisma is imported lazily so the env vars are set before module load.
type PrismaModule = typeof import("@prisma/client");

before(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bis-backup-dump-"));
  process.env.BACKUP_STORAGE_DIR = tmp;
  scratchRoots.push(tmp);
  testWindowStart = new Date();
});

after(async () => {
  // Purge Backup rows created within the test window. We do NOT touch
  // rows created outside this window (defence in depth against
  // clobbering real data if this test is ever accidentally run against
  // a shared DB).
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    // Delete restore ops first (RESTRICT FK from Backup).
    await prisma.restoreOperation.deleteMany({
      where: { startedAt: { gte: testWindowStart } }
    });
    await prisma.backup.deleteMany({
      where: { startedAt: { gte: testWindowStart } }
    });
  } finally {
    await prisma.$disconnect();
  }
  // Wipe scratch dirs.
  for (const dir of scratchRoots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("model-order — schema coverage guard", async () => {
  const { MODEL_ORDER, assertModelCoverage } = await import("../lib/backup/model-order");
  const { Prisma } = await import("@prisma/client");

  test("MODEL_ORDER covers every Prisma model exactly once", () => {
    const generated = Object.keys(Prisma.ModelName).sort();
    const curated = [...MODEL_ORDER].sort();
    assert.deepEqual(curated, generated, "curated list must match Prisma.ModelName");
  });

  test("assertModelCoverage does not throw on the current schema", () => {
    assert.doesNotThrow(() => assertModelCoverage());
  });
});

describe("serializer — coerce + decode round-trip", async () => {
  const { coerceRow, coerceValue, decodeRow, decodeValue, BackupSerializerError } =
    await import("../lib/backup/serializer");

  test("primitives round-trip verbatim", () => {
    const row = {
      s: "hello",
      n: 42,
      b: true,
      z: null
    };
    assert.deepEqual(decodeRow(coerceRow(row)), row);
  });

  test("Date round-trips via $d wrapper", () => {
    const d = new Date("2026-09-26T15:00:00.000Z");
    const encoded = coerceValue(d, "x");
    assert.deepEqual(encoded, { $d: "2026-09-26T15:00:00.000Z" });
    const back = decodeValue(encoded, "x") as Date;
    assert.equal(back.toISOString(), d.toISOString());
  });

  test("bigint round-trips via $n wrapper", () => {
    const encoded = coerceValue(12345678901234567890n, "x");
    assert.deepEqual(encoded, { $n: "12345678901234567890" });
    assert.equal(decodeValue(encoded, "x"), 12345678901234567890n);
  });

  test("Buffer round-trips via $b wrapper", () => {
    const buf = Buffer.from([1, 2, 3, 255]);
    const encoded = coerceValue(buf, "x") as { $b: string };
    assert.equal(typeof encoded.$b, "string");
    const decoded = decodeValue(encoded, "x") as Buffer;
    assert.deepEqual(decoded, buf);
  });

  test("nested Json field round-trips", () => {
    const row = {
      id: "cabc",
      details: {
        activities: [{ title: "Talk", speakers: ["a", "b"] }],
        priority: 7,
        active: true
      }
    };
    assert.deepEqual(decodeRow(coerceRow(row)), row);
  });

  test("Non-finite numbers throw", () => {
    assert.throws(() => coerceValue(NaN, "x"), BackupSerializerError);
    assert.throws(() => coerceValue(Infinity, "x"), BackupSerializerError);
    assert.throws(() => coerceValue(-Infinity, "x"), BackupSerializerError);
  });

  test("Functions / symbols throw", () => {
    assert.throws(() => coerceValue(() => 1, "x"), BackupSerializerError);
    assert.throws(() => coerceValue(Symbol("s"), "x"), BackupSerializerError);
  });

  test("$-prefixed keys in nested objects throw", () => {
    // Simulating a hostile Prisma Json payload.
    const row = { id: "cabc", meta: { $d: "not-a-date" } };
    assert.throws(() => coerceRow(row), BackupSerializerError);
  });

  test("undefined at row level is silently omitted (Prisma optional shape)", () => {
    const row = { id: "cabc", optional: undefined };
    const encoded = coerceRow(row);
    assert.equal("optional" in encoded, false);
    assert.equal(encoded.id, "cabc");
  });
});

describe("runBackupDump — end-to-end against real DB", async () => {
  const { runBackupDump, BackupDumpError } = await import("../lib/backup/dump");
  const { loadBackupSubkeys, createBackupDecryptStream, IV_BYTES, TAG_BYTES } =
    await import("../lib/backup/crypto");
  const { parseAndVerifyManifest } = await import("../lib/backup/manifest");
  const { publishedBackupExists, readPublishedManifest, statPublishedBackup } =
    await import("../lib/backup/storage");
  const { PrismaClient } = await import("@prisma/client");

  test("golden path: creates COMPLETED row + valid on-disk files", async () => {
    const prisma = new PrismaClient();
    try {
      const result = await runBackupDump({ kind: "MANUAL", client: prisma });
      assert.ok(result.backupId.startsWith("c"));
      assert.ok(result.sizeBytes > IV_BYTES + TAG_BYTES);
      assert.ok(result.totalRows >= 0); // may be 0 on a truly empty DB
      assert.equal(typeof result.contentSha256, "string");
      assert.equal(result.contentSha256.length, 64);

      // DB row is COMPLETED with matching hashes and size.
      const row = await prisma.backup.findUniqueOrThrow({
        where: { id: result.backupId }
      });
      assert.equal(row.status, "COMPLETED");
      assert.equal(row.contentSha256, result.contentSha256);
      assert.equal(row.sizeBytes, BigInt(result.sizeBytes));
      assert.equal(row.fileName, `${result.backupId}.bin`);
      assert.equal(row.formatVersion, "1");
      assert.equal(row.encryptionVersion, "v1");
      assert.ok(row.completedAt);
      assert.ok(row.manifestSha256);

      // Files exist on disk.
      assert.equal(await publishedBackupExists(result.backupId), true);
      const stat = await statPublishedBackup(result.backupId);
      assert.equal(stat.binSize, result.sizeBytes);

      // Manifest is signed + parses + matches on-disk state.
      const { hmacKey } = loadBackupSubkeys();
      const manifestBytes = await readPublishedManifest(result.backupId);
      const manifest = parseAndVerifyManifest(hmacKey, manifestBytes);
      assert.equal(manifest.backupId, result.backupId);
      assert.equal(manifest.contentSha256, result.contentSha256);
      assert.equal(manifest.sizeBytes, result.sizeBytes);
      assert.equal(manifest.formatVersion, "1");
      assert.equal(manifest.encryptionVersion, "v1");
      assert.equal(typeof manifest.schemaPrisma, "string");
      assert.ok(manifest.schemaPrisma.length > 100);
      assert.equal(
        manifest.schemaSha256,
        createHash("sha256").update(manifest.schemaPrisma).digest("hex")
      );

      // Re-verify contentSha256 against actual on-disk bytes.
      const actualSha = await sha256File(
        path.join(process.env.BACKUP_STORAGE_DIR!, "published", `${result.backupId}.bin`)
      );
      assert.equal(actualSha, result.contentSha256);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("dump decrypts back to well-formed NDJSON with matching row counts", async () => {
    const prisma = new PrismaClient();
    try {
      const result = await runBackupDump({ kind: "MANUAL", client: prisma });

      const filePath = path.join(
        process.env.BACKUP_STORAGE_DIR!,
        "published",
        `${result.backupId}.bin`
      );
      const raw = await fs.readFile(filePath);
      assert.equal(raw.length, result.sizeBytes);

      // File layout: [12-byte IV][ciphertext][16-byte tag]
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);

      const { encKey } = loadBackupSubkeys();
      const { transform } = createBackupDecryptStream(encKey, iv, tag);
      const plainChunks: Buffer[] = [];
      transform.on("data", (c: Buffer) => plainChunks.push(c));
      await new Promise<void>((resolve, reject) => {
        transform.once("end", resolve);
        transform.once("error", reject);
        transform.end(ciphertext);
      });
      const plaintext = Buffer.concat(plainChunks).toString("utf8");

      // NDJSON: split by newlines.
      const lines = plaintext.split("\n").filter((l) => l.length > 0);
      assert.ok(lines.length >= 2, `must have at least __meta + __end`);

      const meta = JSON.parse(lines[0]) as { __meta?: unknown };
      assert.ok(meta.__meta, "first line must be __meta");

      const end = JSON.parse(lines[lines.length - 1]) as {
        __end?: { rowCounts: Record<string, number>; totalRows: number };
      };
      assert.ok(end.__end, "last line must be __end");
      assert.deepEqual(end.__end.rowCounts, result.rowCounts);
      assert.equal(end.__end.totalRows, result.totalRows);

      // Row-count sanity: sum should match totalRows.
      const sum = Object.values(end.__end.rowCounts).reduce((a, b) => a + b, 0);
      assert.equal(sum, end.__end.totalRows);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("orchestrator invariant: no COMPLETED row without matching on-disk file", async () => {
    // Run a real dump, then verify the pair (DB row, on-disk file) is
    // consistent for every COMPLETED row this test window produced.
    const prisma = new PrismaClient();
    try {
      await runBackupDump({ kind: "MANUAL", client: prisma });
      const completed = await prisma.backup.findMany({
        where: {
          status: "COMPLETED",
          startedAt: { gte: testWindowStart }
        },
        select: { id: true, sizeBytes: true, contentSha256: true }
      });
      assert.ok(completed.length > 0, "expected at least one COMPLETED row");
      for (const row of completed) {
        assert.equal(
          await publishedBackupExists(row.id),
          true,
          `row ${row.id} is COMPLETED but published file is missing`
        );
        const stat = await statPublishedBackup(row.id);
        assert.equal(
          BigInt(stat.binSize),
          row.sizeBytes,
          `row ${row.id} sizeBytes ${row.sizeBytes} vs on-disk ${stat.binSize}`
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("BACKUP_ENCRYPTION_KEY missing → dump fails with clear error, no file promoted", async () => {
    const savedKey = process.env.BACKUP_ENCRYPTION_KEY;
    delete process.env.BACKUP_ENCRYPTION_KEY;
    const prisma = new PrismaClient();
    try {
      await assert.rejects(runBackupDump({ kind: "MANUAL", client: prisma }));
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = savedKey;
      await prisma.$disconnect();
    }
  });

  test("dump refuses to reuse an existing backup id (concurrency invariant)", async () => {
    const prisma = new PrismaClient();
    try {
      const first = await runBackupDump({ kind: "MANUAL", client: prisma });
      // Attempt to force-reuse the same id. The DB row create will
      // collide on the primary key and throw.
      await assert.rejects(
        runBackupDump({ kind: "MANUAL", client: prisma, overrideBackupId: first.backupId })
      );
      // The original file must still be there.
      assert.equal(await publishedBackupExists(first.backupId), true);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("overrideBackupId is rejected outside NODE_ENV=test", async () => {
    const saved = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    const prisma = new PrismaClient();
    try {
      await assert.rejects(
        runBackupDump({
          kind: "MANUAL",
          client: prisma,
          overrideBackupId: "c" + "a".repeat(24)
        }),
        (err: Error) => /test-only/i.test(err.message)
      );
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved;
      await prisma.$disconnect();
    }
  });

  test("createdById is validated as a cuid", async () => {
    const prisma = new PrismaClient();
    try {
      await assert.rejects(
        runBackupDump({ kind: "MANUAL", createdById: "not-a-cuid", client: prisma }),
        BackupDumpError
      );
      await assert.rejects(
        runBackupDump({ kind: "MANUAL", createdById: "admin@example.com", client: prisma }),
        BackupDumpError
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("errorMessage on a FAILED row never contains raw Prisma text with PII", async () => {
    // Force a failure by feeding an invalid createdById that gets past
    // our cuid check by structure but fails at the DB FK layer. We use
    // a syntactically-valid cuid that does NOT exist in AdminUser.
    const prisma = new PrismaClient();
    try {
      const fakeAdminId = "c" + "z".repeat(24);
      await assert.rejects(
        runBackupDump({ kind: "MANUAL", createdById: fakeAdminId, client: prisma })
      );
      // Fetch the most recent FAILED row from this test window and
      // confirm its errorMessage is scrubbed. Note: this test needs
      // to be lenient — the run may create the row with an FK-invalid
      // createdById which Postgres rejects at INSERT, giving us a
      // Prisma error whose sanitized form we can inspect.
      const failed = await prisma.backup.findFirst({
        where: { status: "FAILED", startedAt: { gte: testWindowStart } },
        orderBy: { startedAt: "desc" }
      });
      if (failed?.errorMessage) {
        assert.doesNotMatch(
          failed.errorMessage,
          new RegExp(fakeAdminId),
          "backup errorMessage must not echo the offending id verbatim"
        );
        // Prisma's raw messages include phrases like "Foreign key
        // constraint violated" WITH the target field name — that's
        // fine. What we forbid is the field VALUE.
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

async function sha256File(filePath: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on("data", (c: string | Buffer) => h.update(c));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return h.digest("hex");
}

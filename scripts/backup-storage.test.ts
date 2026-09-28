// Tests for lib/backup/storage. Run with:
//   npm run test:backup-storage
//
// Pure Node — no DB required. Uses a scratch directory under os.tmpdir().

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import type { Writable } from "stream";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";

const originalStorageDir = process.env.BACKUP_STORAGE_DIR;
let scratchRoot = "";

function makeCuid(): string {
  // Not a real cuid — but matches the shape we validate (c + 24 lowercase alnum).
  return "c" + randomBytes(12).toString("hex");
}

/**
 * Test helper mirroring the orchestrator's write sequence. Writes payload,
 * waits for the writable's `finish` event, closes the stream, then invokes
 * `fsyncStaging(id)` to force the kernel to flush the file to disk.
 */
async function writeThenFsync(
  stream: Writable,
  payload: Buffer,
  fsync: () => Promise<void>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    stream.once("error", (err: Error) => done(err));
    stream.once("finish", () => done());
    stream.end(payload);
  });
  await fsync();
}

before(async () => {
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bis-backup-test-"));
  process.env.BACKUP_STORAGE_DIR = scratchRoot;
});

after(async () => {
  if (originalStorageDir === undefined) {
    delete process.env.BACKUP_STORAGE_DIR;
  } else {
    process.env.BACKUP_STORAGE_DIR = originalStorageDir;
  }
  await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  // Clean scratch dir between tests to keep tests isolated.
  await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(scratchRoot, { recursive: true });
});

describe("backup storage — config", async () => {
  const { loadBackupStorageDir, BackupConfigError } = await import("../lib/backup/config");

  test("returns the configured absolute path", () => {
    process.env.BACKUP_STORAGE_DIR = scratchRoot;
    assert.equal(loadBackupStorageDir(), path.resolve(scratchRoot));
  });

  test("throws on missing env var", () => {
    const saved = process.env.BACKUP_STORAGE_DIR;
    delete process.env.BACKUP_STORAGE_DIR;
    try {
      assert.throws(() => loadBackupStorageDir(), BackupConfigError);
    } finally {
      process.env.BACKUP_STORAGE_DIR = saved;
    }
  });

  test("throws on relative path", () => {
    const saved = process.env.BACKUP_STORAGE_DIR;
    process.env.BACKUP_STORAGE_DIR = "./relative-path";
    try {
      assert.throws(() => loadBackupStorageDir(), BackupConfigError);
    } finally {
      process.env.BACKUP_STORAGE_DIR = saved;
    }
  });
});

describe("backup storage — filename validation", async () => {
  const { assertValidBackupId, BackupStorageError } = await import("../lib/backup/storage");

  test("accepts a valid cuid shape", () => {
    const id = makeCuid();
    assert.equal(assertValidBackupId(id), id);
  });

  test("rejects wrong prefix", () => {
    assert.throws(() => assertValidBackupId("z" + randomBytes(12).toString("hex")), BackupStorageError);
  });

  test("rejects wrong length", () => {
    assert.throws(() => assertValidBackupId("cabc"), BackupStorageError);
  });

  test("rejects uppercase", () => {
    assert.throws(() => assertValidBackupId("c" + "A".repeat(24)), BackupStorageError);
  });

  test("rejects non-string", () => {
    assert.throws(() => assertValidBackupId(null), BackupStorageError);
    assert.throws(() => assertValidBackupId(123), BackupStorageError);
    assert.throws(() => assertValidBackupId(undefined), BackupStorageError);
  });

  test("rejects strings with separators / traversal characters", () => {
    assert.throws(() => assertValidBackupId("c" + "../" + "a".repeat(21)), BackupStorageError);
    assert.throws(() => assertValidBackupId("c" + "..\\".repeat(8)), BackupStorageError);
    assert.throws(() => assertValidBackupId("c" + "a".repeat(23) + "\0"), BackupStorageError);
  });
});

describe("backup storage — ensureBackupDirs", async () => {
  const { ensureBackupDirs } = await import("../lib/backup/storage");

  test("creates staging and published directories", async () => {
    const { root, staging, published } = await ensureBackupDirs();
    assert.equal(root, path.resolve(scratchRoot));
    assert.ok((await fs.stat(staging)).isDirectory());
    assert.ok((await fs.stat(published)).isDirectory());
  });

  test("is idempotent", async () => {
    await ensureBackupDirs();
    await ensureBackupDirs(); // no throw
    const entries = await fs.readdir(scratchRoot);
    assert.deepEqual(entries.sort(), ["published", "staging"]);
  });
});

describe("backup storage — write / promote / read cycle", async () => {
  const {
    openStagingWriteStream,
    writeStagingManifest,
    fsyncStaging,
    promoteFromStaging,
    openPublishedReadStream,
    readPublishedManifest,
    statPublishedBackup,
    publishedBackupExists,
    deletePublishedBackup
  } = await import("../lib/backup/storage");

  test("full happy path", async () => {
    const id = makeCuid();
    const payload = randomBytes(1024);
    const manifest = Buffer.from(JSON.stringify({ hello: "world" }));

    // Write + fsync in the orchestrator sequence
    const { stream } = await openStagingWriteStream(id);
    await writeThenFsync(stream, payload, () => fsyncStaging(id));
    await writeStagingManifest(id, manifest);

    // Promote
    const { binPath, manifestPath } = await promoteFromStaging(id);
    assert.ok(binPath.includes("published"));
    assert.ok(manifestPath.includes("published"));

    // Read back
    assert.equal(await publishedBackupExists(id), true);
    const stat = await statPublishedBackup(id);
    assert.equal(stat.binSize, payload.length);
    assert.equal(stat.manifestSize, manifest.length);

    const manifestBack = await readPublishedManifest(id);
    assert.deepEqual(manifestBack, manifest);

    // Read stream
    const read = openPublishedReadStream(id);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      read.on("data", (c: string | Buffer) => {
        chunks.push(typeof c === "string" ? Buffer.from(c) : c);
      });
      read.on("end", () => resolve());
      read.on("error", reject);
    });
    assert.deepEqual(Buffer.concat(chunks), payload);

    // Delete
    await deletePublishedBackup(id);
    assert.equal(await publishedBackupExists(id), false);
  });

  test("refuses to overwrite an existing published backup", async () => {
    const id = makeCuid();
    // First write
    const first = await openStagingWriteStream(id);
    await writeThenFsync(first.stream, Buffer.from("x"), () => fsyncStaging(id));
    await writeStagingManifest(id, Buffer.from("{}"));
    await promoteFromStaging(id);

    // Second write to staging succeeds, but promote must reject
    const second = await openStagingWriteStream(id);
    await writeThenFsync(second.stream, Buffer.from("y"), () => fsyncStaging(id));
    await writeStagingManifest(id, Buffer.from("{}"));
    await assert.rejects(promoteFromStaging(id));
  });

  test("openStagingWriteStream fails if the staging file already exists", async () => {
    const id = makeCuid();
    const { stream } = await openStagingWriteStream(id);
    await writeThenFsync(stream, Buffer.from("x"), () => fsyncStaging(id));
    // Second call must fail because we opened with O_EXCL.
    await assert.rejects(openStagingWriteStream(id));
  });

  test("deleteStaging is idempotent (does not throw when file missing)", async () => {
    const { deleteStaging } = await import("../lib/backup/storage");
    await deleteStaging(makeCuid());
    await deleteStaging(makeCuid());
  });
});

describe("backup storage — path traversal defense", async () => {
  const {
    openPublishedReadStream,
    readPublishedManifest,
    deletePublishedBackup,
    BackupStorageError
  } = await import("../lib/backup/storage");

  const evilIds = [
    "../etc/passwd",
    "..\\Windows\\System32",
    "/etc/shadow",
    "C:\\Windows",
    ".hidden",
    "",
    "cabc/../evil",
    "c" + "a".repeat(24) + "/../../evil"
  ];

  for (const evil of evilIds) {
    test(`rejects backup id: ${JSON.stringify(evil)}`, async () => {
      assert.throws(() => openPublishedReadStream(evil), BackupStorageError);
      await assert.rejects(() => readPublishedManifest(evil), BackupStorageError);
      await assert.rejects(() => deletePublishedBackup(evil), BackupStorageError);
    });
  }
});

describe("backup storage — listPublishedIds", async () => {
  const { openStagingWriteStream, writeStagingManifest, fsyncStaging, promoteFromStaging, listPublishedIds } =
    await import("../lib/backup/storage");

  test("returns only well-formed backup IDs, sorted", async () => {
    const ids = [makeCuid(), makeCuid(), makeCuid()];
    for (const id of ids) {
      const { stream } = await openStagingWriteStream(id);
      await writeThenFsync(stream, Buffer.from("x"), () => fsyncStaging(id));
      await writeStagingManifest(id, Buffer.from("{}"));
      await promoteFromStaging(id);
    }
    // Sprinkle a bogus file that we should ignore.
    const publishedDir = path.join(scratchRoot, "published");
    await fs.writeFile(path.join(publishedDir, "not-a-backup.txt"), "junk");

    const found = await listPublishedIds();
    assert.deepEqual(found, [...ids].sort());
  });
});

describe("backup storage — sweepStaleStaging", async () => {
  const {
    openStagingWriteStream,
    writeStagingManifest,
    fsyncStaging,
    sweepStaleStaging,
    STAGING_MAX_AGE_MS
  } = await import("../lib/backup/storage");

  test("removes files older than STAGING_MAX_AGE_MS", async () => {
    const id = makeCuid();
    const { stream, full } = await openStagingWriteStream(id);
    await writeThenFsync(stream, Buffer.from("x"), () => fsyncStaging(id));
    await writeStagingManifest(id, Buffer.from("{}"));

    // Wind file mtimes back to look old.
    const oldTime = new Date(Date.now() - STAGING_MAX_AGE_MS - 60_000);
    await fs.utimes(full, oldTime, oldTime);
    const manifestFull = full.replace(/\.bin$/, ".manifest.json");
    await fs.utimes(manifestFull, oldTime, oldTime);

    const { removed } = await sweepStaleStaging();
    assert.equal(removed.length, 2, `removed=${JSON.stringify(removed)}`);
  });

  test("leaves fresh files alone", async () => {
    const id = makeCuid();
    const { stream } = await openStagingWriteStream(id);
    await writeThenFsync(stream, Buffer.from("x"), () => fsyncStaging(id));
    await writeStagingManifest(id, Buffer.from("{}"));

    const { removed } = await sweepStaleStaging();
    assert.equal(removed.length, 0);
  });

  test("ignores unfamiliar file names in staging", async () => {
    await import("../lib/backup/storage").then((m) => m.ensureBackupDirs());
    const stagingDir = path.join(scratchRoot, "staging");
    const stranger = path.join(stagingDir, "random-file.txt");
    await fs.writeFile(stranger, "not ours");
    const oldTime = new Date(Date.now() - STAGING_MAX_AGE_MS - 60_000);
    await fs.utimes(stranger, oldTime, oldTime);
    const { removed } = await sweepStaleStaging();
    assert.equal(removed.length, 0);
    // File still exists.
    await fs.access(stranger);
  });
});

describe("backup storage — durability + symlink boundary (Phase 4 fix)", async () => {
  const { openStagingWriteStream, fsyncStaging, STAGING_OPEN_FLAGS, O_NOFOLLOW_APPLIED } =
    await import("../lib/backup/storage");

  test("fsyncStaging round-trips against a freshly written file", async () => {
    const id = makeCuid();
    const { stream, full } = await openStagingWriteStream(id);
    await writeThenFsync(stream, Buffer.from("payload"), () => fsyncStaging(id));
    // If we reach here, fsyncStaging completed without throwing.
    const st = await fs.stat(full);
    assert.equal(st.size, "payload".length);
  });

  test("fsyncStaging refuses invalid backup ids (path safety)", async () => {
    const { BackupStorageError } = await import("../lib/backup/storage");
    await assert.rejects(() => fsyncStaging("../etc/passwd"), BackupStorageError);
    await assert.rejects(() => fsyncStaging(""), BackupStorageError);
  });

  test("STAGING_OPEN_FLAGS encodes O_WRONLY | O_CREAT | O_EXCL [+ O_NOFOLLOW on POSIX]", async () => {
    const { constants } = await import("fs");
    const required = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
    assert.equal(
      (STAGING_OPEN_FLAGS & required) >>> 0,
      required,
      "wx equivalent flags must be present"
    );
    if (O_NOFOLLOW_APPLIED) {
      assert.equal(
        (STAGING_OPEN_FLAGS & constants.O_NOFOLLOW) >>> 0,
        constants.O_NOFOLLOW,
        "O_NOFOLLOW must be set on POSIX"
      );
    } else {
      // Windows: O_NOFOLLOW does not exist. Documented limitation.
      assert.equal(
        typeof constants.O_NOFOLLOW,
        "undefined",
        "O_NOFOLLOW is expected to be undefined on this platform"
      );
    }
  });

  test("symlink at staging target is rejected (POSIX only)", { skip: !O_NOFOLLOW_APPLIED }, async () => {
    // POSIX-only: plant a symlink at the exact target path and confirm
    // that openStagingWriteStream refuses to follow it. This is the
    // concrete defence against MEDIUM-1 in the gate review.
    await import("../lib/backup/storage").then((m) => m.ensureBackupDirs());
    const id = makeCuid();
    const stagingDir = path.join(scratchRoot, "staging");
    const targetName = `${id}.bin`;
    const symlinkPath = path.join(stagingDir, targetName);
    const fakeTarget = path.join(os.tmpdir(), "bis-backup-symlink-target-" + id);
    // Ensure the symlink target does NOT exist — this is the dangerous case,
    // where O_EXCL alone would happily CREATE the target file.
    await fs.rm(fakeTarget, { force: true }).catch(() => undefined);
    await fs.symlink(fakeTarget, symlinkPath);
    try {
      await assert.rejects(
        openStagingWriteStream(id),
        (err: NodeJS.ErrnoException) => err.code === "ELOOP" || err.code === "EEXIST",
        "must reject with ELOOP (O_NOFOLLOW) or EEXIST (symlink counts as existing)"
      );
      // Confirm the attacker-chosen target was NOT created.
      await assert.rejects(fs.access(fakeTarget));
    } finally {
      await fs.unlink(symlinkPath).catch(() => undefined);
      await fs.unlink(fakeTarget).catch(() => undefined);
    }
  });
});

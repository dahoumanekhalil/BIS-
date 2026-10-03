// §M — Local backup independence regression suite.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §M.2:
//
//   > A dedicated test suite `scripts/backup-drive-local-independence.test.ts`
//   > induces every failure mode in the classifier and asserts:
//   >   * Backup.status === "VERIFIED" throughout.
//   >   * Backup.errorMessage unchanged throughout.
//   >   * No RestoreOperation is touched.
//
// Why a dedicated suite? The state-machine invariants for the uploader
// itself are covered by `backup-drive-uploader-invariants.test.ts`. The
// retention-side rules are covered by `backup-drive-retention-independence
// .test.ts`. But §M cuts across the entire replication tree — the
// uploader, the verify-remote services, the reconcile service, AND the
// download-first remote restore module. This suite is the cross-cut
// regression: every code path that can be reached by an operator or the
// worker leaves the local Backup row unchanged.
//
// Run with:
//   npm run test:backup-drive-local-independence

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";

// Modules under test — the entire replication tree.
import { reconcileReplicationRemote } from "../lib/backup/replication/reconcile";
import {
  verifyRemoteFullSha256,
  verifyRemoteMetadata
} from "../lib/backup/replication/verify-remote";
import { downloadAndVerifyDriveBackup } from "../lib/backup/replication/restore-remote";
import type { DriveFolderApi } from "../lib/backup/replication/folder";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse
} from "../lib/backup/replication/http";
import { REPLICATION_DESTINATION } from "../lib/backup/replication/uploader";

// ─── Prisma ────────────────────────────────────────────────────────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FOLDER_ID = "local-independence-folder-id";
const ACCESS_TOKEN = "local-independence-fake-access-token";
const NOW = new Date("2026-10-01T09:00:00Z");
const HTTP_TIMEOUT_MS = 5_000;

// Fingerprint the local-Backup fields we assert are UNCHANGED across
// every replication side-effect. Extract this to keep test bodies compact.
type BackupFingerprint = {
  status: string;
  errorMessage: string | null;
  contentSha256: string | null;
  manifestSha256: string | null;
  fileName: string | null;
  sizeBytes: string | null;
};

async function fingerprintBackup(
  prisma: PrismaClient,
  backupId: string
): Promise<BackupFingerprint | null> {
  const b = await prisma.backup.findUnique({
    where: { id: backupId },
    select: {
      status: true,
      errorMessage: true,
      contentSha256: true,
      manifestSha256: true,
      fileName: true,
      sizeBytes: true
    }
  });
  if (b === null) return null;
  return {
    status: b.status,
    errorMessage: b.errorMessage,
    contentSha256: b.contentSha256,
    manifestSha256: b.manifestSha256,
    fileName: b.fileName,
    sizeBytes: b.sizeBytes === null ? null : b.sizeBytes.toString()
  };
}

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

function sha256(s: string | Buffer): string {
  const h = createHash("sha256");
  h.update(typeof s === "string" ? Buffer.from(s, "utf-8") : s);
  return h.digest("hex");
}
function md5(buf: Buffer): string {
  const h = createHash("md5");
  h.update(buf);
  return h.digest("hex");
}

const seededBackupIds: string[] = [];
const testWindowStart = new Date();
let stagingRoot = "";
let scratchStorageDir = "";
let originalEncryptionKey: string | undefined;
let originalStorageDir: string | undefined;

async function seedVerifiedBackupWithReplication(
  prisma: PrismaClient,
  bin: Buffer,
  manifest: Buffer
): Promise<{ backupId: string; replicationId: string }> {
  const backupId = makeCuid();
  seededBackupIds.push(backupId);
  await prisma.backup.create({
    data: {
      id: backupId,
      status: "VERIFIED",
      kind: "MANUAL",
      schemaSha256: sha256("schema-fixed"),
      appVersion: "local-independence",
      formatVersion: "1",
      encryptionVersion: "v1",
      sizeBytes: BigInt(bin.byteLength),
      contentSha256: sha256(bin),
      manifestSha256: sha256(manifest),
      fileName: `${backupId}.bin`
    }
  });
  const rep = await prisma.backupReplication.create({
    data: {
      backupId,
      destination: REPLICATION_DESTINATION,
      status: "COMPLETED",
      remoteBinFileId: "remote-bin-id-" + backupId.slice(0, 8),
      remoteManifestFileId: "remote-mf-id-" + backupId.slice(0, 8),
      remoteFolderId: FOLDER_ID,
      remoteBinSize: BigInt(bin.byteLength),
      remoteManifestSize: BigInt(manifest.byteLength),
      remoteBinMd5: md5(bin),
      remoteManifestMd5: md5(manifest),
      lastVerifyLevel: "METADATA_ONLY",
      lastVerifiedAt: new Date("2026-09-30T12:00:00Z")
    }
  });
  return { backupId, replicationId: rep.id };
}

// Drive fake: for reconcile / verify — supports files.get(fileId).
type DriveFileFixture = {
  id: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
  size?: string;
  md5Checksum?: string;
  appProperties?: Record<string, string>;
  parents?: string[];
};

function driveOk(files: DriveFileFixture[]): DriveFolderApi {
  return {
    files: {
      async get({ fileId }) {
        const f = files.find((x) => x.id === fileId);
        if (!f) {
          const err = new Error("Not Found") as Error & {
            status: number;
            response: { status: number; data: object };
          };
          err.status = 404;
          err.response = { status: 404, data: {} };
          throw err;
        }
        return {
          data: {
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            trashed: f.trashed === true,
            size: f.size,
            md5Checksum: f.md5Checksum,
            appProperties: f.appProperties,
            parents: f.parents
          }
        };
      },
      async list() {
        return { data: { files: [] } };
      }
    }
  };
}

function driveThrows(status: number): DriveFolderApi {
  return {
    files: {
      async get() {
        const err = new Error("drive-throws") as Error & {
          status: number;
          response: { status: number; data: object };
        };
        err.status = status;
        err.response = { status, data: {} };
        throw err;
      },
      async list() {
        return { data: { files: [] } };
      }
    }
  };
}

function httpNever(): HttpClient {
  // Only some paths need an HttpClient — every path that DOES need it
  // in this suite provides one inline. A stray call here means a
  // module reached HTTP without a scripted transport → test bug.
  return async (_req: HttpRequest): Promise<HttpResponse> => {
    throw new Error("httpNever: no HTTP requests are expected here");
  };
}

function httpAlwaysErrors(status: number): HttpClient {
  return async (_req: HttpRequest): Promise<HttpResponse> => ({
    status,
    headers: {},
    body: Buffer.from("")
  });
}

// ─── Suite setup / teardown ────────────────────────────────────────────────

before(async () => {
  scratchStorageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "bis-local-independence-")
  );
  originalStorageDir = process.env.BACKUP_STORAGE_DIR;
  originalEncryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_STORAGE_DIR = scratchStorageDir;
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  }
  stagingRoot = path.join(scratchStorageDir, "staging");
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(scratchStorageDir, "published"), {
    recursive: true,
    mode: 0o700
  });
});

after(async () => {
  if (originalStorageDir === undefined) delete process.env.BACKUP_STORAGE_DIR;
  else process.env.BACKUP_STORAGE_DIR = originalStorageDir;
  if (originalEncryptionKey === undefined) {
    delete process.env.BACKUP_ENCRYPTION_KEY;
  } else {
    process.env.BACKUP_ENCRYPTION_KEY = originalEncryptionKey;
  }
  const prisma = await makePrisma();
  try {
    if (seededBackupIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: seededBackupIds } }
      });
      await prisma.backup.deleteMany({
        where: { id: { in: seededBackupIds } }
      });
    }
    await prisma.auditLog.deleteMany({
      where: {
        createdAt: { gte: testWindowStart },
        action: { startsWith: "backup.replication." }
      }
    });
  } finally {
    await prisma.$disconnect();
  }
  await fs
    .rm(scratchStorageDir, { recursive: true, force: true })
    .catch(() => undefined);
});

beforeEach(async () => {
  if (seededBackupIds.length > 0) {
    const p = await makePrisma();
    try {
      await p.backupReplication.deleteMany({
        where: { backupId: { in: seededBackupIds } }
      });
      await p.backup.deleteMany({ where: { id: { in: seededBackupIds } } });
    } finally {
      await p.$disconnect();
    }
    seededBackupIds.length = 0;
  }
});

// ─── The suite ─────────────────────────────────────────────────────────────

describe("§M — reconcile leaves local Backup untouched", () => {
  test("bin missing on Drive → REMOTE_MISSING on the row; Backup unchanged", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-A");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);
      const before = await fingerprintBackup(prisma, seeded.backupId);

      const rep = await prisma.backupReplication.findUnique({
        where: { id: seeded.replicationId }
      });
      // Only the manifest is present; the bin returns 404.
      const drive = driveOk([
        { id: rep!.remoteManifestFileId!, trashed: false }
      ]);

      const result = await reconcileReplicationRemote(seeded.replicationId, {
        prisma,
        drive,
        now: () => NOW
      });
      assert.equal(result.outcome, "REMOTE_MISSING");

      const after = await fingerprintBackup(prisma, seeded.backupId);
      assert.deepStrictEqual(after, before, "Backup row changed after reconcile");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("Drive 500 → row surfaces classified error; Backup unchanged", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-B");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);
      const before = await fingerprintBackup(prisma, seeded.backupId);

      const result = await reconcileReplicationRemote(seeded.replicationId, {
        prisma,
        drive: driveThrows(500),
        now: () => NOW
      });
      assert.equal(result.outcome, "DRIVE_ERROR");

      const after = await fingerprintBackup(prisma, seeded.backupId);
      assert.deepStrictEqual(after, before, "Backup row changed after Drive 500");
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("§M — verifyRemoteMetadata leaves local Backup untouched", () => {
  test("Drive metadata mismatch → row errorCode set; Backup unchanged", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-C");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);
      const before = await fingerprintBackup(prisma, seeded.backupId);
      const rep = await prisma.backupReplication.findUnique({
        where: { id: seeded.replicationId }
      });

      // Return metadata with a mismatched parents array.
      const drive = driveOk([
        {
          id: rep!.remoteBinFileId!,
          name: rep!.remoteBinFileId! + ".bin",
          mimeType: "application/octet-stream",
          size: rep!.remoteBinSize!.toString(),
          md5Checksum: rep!.remoteBinMd5!,
          parents: ["some-other-folder"],
          appProperties: {}
        },
        {
          id: rep!.remoteManifestFileId!,
          name: rep!.remoteManifestFileId! + ".mf",
          mimeType: "application/json",
          parents: [FOLDER_ID],
          appProperties: {}
        }
      ]);

      const result = await verifyRemoteMetadata(seeded.replicationId, {
        prisma,
        drive,
        http: httpNever(),
        accessToken: ACCESS_TOKEN,
        folderId: FOLDER_ID,
        stagingRoot,
        now: () => NOW,
        httpTimeoutMs: HTTP_TIMEOUT_MS
      });
      assert.equal(result.outcome, "MISMATCH");

      const rowAfter = await prisma.backupReplication.findUnique({
        where: { id: seeded.replicationId }
      });
      // Row status STAYS COMPLETED (§K.10).
      assert.equal(rowAfter!.status, "COMPLETED");
      assert.equal(rowAfter!.errorCode, "REMOTE_VERIFICATION_FAILED");

      const after = await fingerprintBackup(prisma, seeded.backupId);
      assert.deepStrictEqual(
        after,
        before,
        "Backup row changed after verifyRemoteMetadata mismatch"
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("Drive throws mid-verify → row errorCode set; Backup unchanged", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-D");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);
      const before = await fingerprintBackup(prisma, seeded.backupId);

      const result = await verifyRemoteMetadata(seeded.replicationId, {
        prisma,
        drive: driveThrows(429),
        http: httpNever(),
        accessToken: ACCESS_TOKEN,
        folderId: FOLDER_ID,
        stagingRoot,
        now: () => NOW,
        httpTimeoutMs: HTTP_TIMEOUT_MS
      });
      assert.equal(result.outcome, "MISMATCH");

      const rowAfter = await prisma.backupReplication.findUnique({
        where: { id: seeded.replicationId }
      });
      assert.equal(rowAfter!.status, "COMPLETED");

      const after = await fingerprintBackup(prisma, seeded.backupId);
      assert.deepStrictEqual(after, before, "Backup row changed after Drive throw");
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("§M — verifyRemoteFullSha256 leaves local Backup untouched", () => {
  test("HTTP download fails → row errorCode set; Backup unchanged", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-E");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);
      const before = await fingerprintBackup(prisma, seeded.backupId);

      const result = await verifyRemoteFullSha256(seeded.replicationId, {
        prisma,
        drive: driveOk([]),
        http: httpAlwaysErrors(503),
        accessToken: ACCESS_TOKEN,
        folderId: FOLDER_ID,
        stagingRoot,
        now: () => NOW,
        httpTimeoutMs: HTTP_TIMEOUT_MS
      });
      assert.equal(result.outcome, "MISMATCH");

      const rowAfter = await prisma.backupReplication.findUnique({
        where: { id: seeded.replicationId }
      });
      // Deep verify never flips row to FAILED (§K.10).
      assert.equal(rowAfter!.status, "COMPLETED");

      const after = await fingerprintBackup(prisma, seeded.backupId);
      assert.deepStrictEqual(
        after,
        before,
        "Backup row changed after full-SHA256 download failure"
      );
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("§M — downloadAndVerifyDriveBackup refuses to touch an existing local Backup", () => {
  test("existing local Backup row → REFUSED_LOCAL_ALREADY_PRESENT; Backup untouched", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-F");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);
      const before = await fingerprintBackup(prisma, seeded.backupId);

      const result = await downloadAndVerifyDriveBackup(seeded.backupId, {
        prisma,
        http: httpAlwaysErrors(500),
        accessToken: ACCESS_TOKEN,
        now: () => NOW,
        httpTimeoutMs: HTTP_TIMEOUT_MS,
        storageDirOverride: scratchStorageDir
      });
      assert.equal(result.outcome, "REFUSED_LOCAL_ALREADY_PRESENT");

      const after = await fingerprintBackup(prisma, seeded.backupId);
      assert.deepStrictEqual(
        after,
        before,
        "downloadAndVerifyDriveBackup mutated an existing local Backup row"
      );
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("§M — RestoreOperation table is never touched by replication code", () => {
  test("verify + reconcile + refused-restore leave RestoreOperation counts unchanged", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-G");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);

      const restoreCountBefore = await prisma.restoreOperation.count();

      // Reconcile: bin missing.
      const rep = await prisma.backupReplication.findUnique({
        where: { id: seeded.replicationId }
      });
      await reconcileReplicationRemote(seeded.replicationId, {
        prisma,
        drive: driveOk([{ id: rep!.remoteManifestFileId!, trashed: false }]),
        now: () => NOW
      });

      // Verify metadata: Drive 500.
      await verifyRemoteMetadata(seeded.replicationId, {
        prisma,
        drive: driveThrows(500),
        http: httpNever(),
        accessToken: ACCESS_TOKEN,
        folderId: FOLDER_ID,
        stagingRoot,
        now: () => NOW,
        httpTimeoutMs: HTTP_TIMEOUT_MS
      });

      // Restore-remote: refused (local Backup already present).
      await downloadAndVerifyDriveBackup(seeded.backupId, {
        prisma,
        http: httpAlwaysErrors(500),
        accessToken: ACCESS_TOKEN,
        now: () => NOW,
        httpTimeoutMs: HTTP_TIMEOUT_MS,
        storageDirOverride: scratchStorageDir
      });

      const restoreCountAfter = await prisma.restoreOperation.count();
      assert.equal(
        restoreCountAfter,
        restoreCountBefore,
        "replication code wrote a RestoreOperation row (§M forbids this)"
      );
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("§M — schema-level FK guard: hard delete of a replicated Backup is refused", () => {
  test("Prisma refuses `backup.delete` when a BackupReplication row references it", async () => {
    const prisma = await makePrisma();
    try {
      const bin = Buffer.from("bin-payload-H");
      const manifest = Buffer.from("{}", "utf-8");
      const seeded = await seedVerifiedBackupWithReplication(prisma, bin, manifest);

      let threw = false;
      try {
        await prisma.backup.delete({ where: { id: seeded.backupId } });
      } catch {
        threw = true;
      }
      assert.equal(
        threw,
        true,
        "onDelete: Restrict on BackupReplication.backupId must refuse a Backup hard-delete"
      );

      // Local Backup row must still exist (VERIFIED, untouched).
      const after = await fingerprintBackup(prisma, seeded.backupId);
      assert.notEqual(after, null);
      assert.equal(after!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

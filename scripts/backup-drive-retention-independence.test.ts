// Layer J tests — remote retention independence (Plan §O).
//
// Run with:
//   npm run test:backup-drive-retention-independence
//
// Assertions cover the Layer J approval checklist:
//   * runRetention() NEVER mutates a BackupReplication row (row's
//     updatedAt, status, errorCode all unchanged after retention).
//   * Backup.status transition to DELETED leaves BackupReplication
//     UNCHANGED (§O.1 rule).
//   * Backup.status transition to MISSING leaves BackupReplication
//     UNCHANGED (§O.3 rule: this is when the remote copy becomes
//     life-critical).
//   * The FK Restrict on `BackupReplication.backupId` REFUSES a hard
//     DELETE of a Backup row that has a replication row (guarantees
//     the row survives even a buggy admin action that tries to purge).
//   * reconcileReplicationRemote: both remote files present → OK.
//   * reconcile: remote bin 404 → REMOTE_MISSING, row.status stays
//     COMPLETED, Backup untouched.
//   * reconcile: remote manifest trashed → REMOTE_MISSING.
//   * reconcile: skipped when row is not COMPLETED.
//   * reconcile: skipped when replication id does not exist.
//   * reconcile: clears a stale REMOTE_MISSING when both files come
//     back.
//   * reconcile: Drive server error (500) surfaced as classified code
//     WITHOUT falsely marking REMOTE_MISSING.
//   * sanitization: no bearer / URL / session URI in errorMessage.
//   * lastVerifyLevel and attestedContentSha256 are NEVER touched by
//     reconcile (honesty gate — reconcile does not attest content).

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";

import {
  reconcileReplicationRemote,
  type ReconcileReplicationDeps
} from "../lib/backup/replication/reconcile";
import { REPLICATION_DESTINATION } from "../lib/backup/replication/uploader";
import type { DriveFolderApi } from "../lib/backup/replication/folder";

// ─── Prisma ────────────────────────────────────────────────────────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-30T12:00:00Z");
const createdBackupIds: string[] = [];
const testWindowStart = new Date();
let scratchStorageDir = "";
let originalStorageDir: string | undefined;
let originalEncryptionKey: string | undefined;

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

function sha256(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

async function seedBackupWithReplication(
  prisma: PrismaClient,
  overrides: {
    backupStatus?:
      | "VERIFIED"
      | "COMPLETED"
      | "PENDING"
      | "RUNNING"
      | "FAILED"
      | "DELETED"
      | "MISSING";
    repStatus?:
      | "PENDING"
      | "UPLOADING"
      | "VERIFYING"
      | "COMPLETED"
      | "RETRYABLE_FAILURE"
      | "FAILED";
    remoteBinFileId?: string;
    remoteManifestFileId?: string;
    errorCode?:
      | "NONE"
      | "REMOTE_MISSING"
      | "REMOTE_VERIFICATION_FAILED"
      | "REMOTE_CHECKSUM_MISMATCH";
    lastVerifyLevel?: "NONE" | "METADATA_ONLY" | "FULL_SHA256";
    attestedContentSha256?: string | null;
  } = {}
): Promise<{ backupId: string; replicationId: string }> {
  const backupId = makeCuid();
  createdBackupIds.push(backupId);
  await prisma.backup.create({
    data: {
      id: backupId,
      status: overrides.backupStatus ?? "VERIFIED",
      kind: "MANUAL",
      schemaSha256: sha256("schema"),
      appVersion: "layer-j-test",
      formatVersion: "1",
      encryptionVersion: "v1",
      sizeBytes: BigInt(1024),
      contentSha256: sha256("bin"),
      manifestSha256: sha256("manifest"),
      fileName: `${backupId}.bin`
    }
  });
  const rep = await prisma.backupReplication.create({
    data: {
      backupId,
      destination: REPLICATION_DESTINATION,
      status: overrides.repStatus ?? "COMPLETED",
      remoteBinFileId: overrides.remoteBinFileId ?? "remote-bin-id-1",
      remoteManifestFileId: overrides.remoteManifestFileId ?? "remote-mf-id-1",
      remoteFolderId: "remote-folder-id",
      lastVerifyLevel: overrides.lastVerifyLevel ?? "METADATA_ONLY",
      lastVerifiedAt: new Date("2026-09-29T12:00:00Z"),
      attestedContentSha256: overrides.attestedContentSha256 ?? null,
      errorCode: overrides.errorCode ?? "NONE"
    }
  });
  return { backupId, replicationId: rep.id };
}

type FakeDriveFile = {
  id: string;
  trashed?: boolean;
};

function makeFakeDrive(files: FakeDriveFile[]): DriveFolderApi {
  return {
    files: {
      async get(params) {
        const f = files.find((x) => x.id === params.fileId);
        if (!f) {
          const err = new Error("Not Found") as Error & {
            status: number;
            response: { status: number; data: object };
          };
          err.status = 404;
          err.response = { status: 404, data: {} };
          throw err;
        }
        return { data: { id: f.id, trashed: f.trashed === true } };
      },
      async list() {
        return { data: { files: [] } };
      }
    }
  };
}

function makeDriveThatThrows(status: number): DriveFolderApi {
  return {
    files: {
      async get() {
        const err = new Error("Drive error") as Error & {
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

function buildDeps(
  overrides: Partial<ReconcileReplicationDeps>,
  prisma: PrismaClient
): ReconcileReplicationDeps {
  return {
    prisma,
    drive: overrides.drive ?? makeFakeDrive([]),
    now: () => NOW,
    ...overrides
  };
}

// ─── Suite setup + teardown ───────────────────────────────────────────────

before(async () => {
  scratchStorageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "bis-retention-independence-")
  );
  originalStorageDir = process.env.BACKUP_STORAGE_DIR;
  originalEncryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_STORAGE_DIR = scratchStorageDir;
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  }
  await fs.mkdir(path.join(scratchStorageDir, "staging"), {
    recursive: true,
    mode: 0o700
  });
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
    if (createdBackupIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: createdBackupIds } }
      });
      await prisma.backup.deleteMany({
        where: { id: { in: createdBackupIds } }
      });
    }
    await prisma.backupReplication.deleteMany({
      where: { createdAt: { gte: testWindowStart } }
    });
  } finally {
    await prisma.$disconnect();
  }
  await fs
    .rm(scratchStorageDir, { recursive: true, force: true })
    .catch(() => undefined);
});

beforeEach(async () => {
  if (createdBackupIds.length > 0) {
    const p = await makePrisma();
    try {
      await p.backupReplication.deleteMany({
        where: { backupId: { in: createdBackupIds } }
      });
      await p.backup.deleteMany({ where: { id: { in: createdBackupIds } } });
    } finally {
      await p.$disconnect();
    }
    createdBackupIds.length = 0;
  }
});

// ─── Retention independence ───────────────────────────────────────────────

describe("runRetention — remote replication independence", () => {
  test("BackupReplication rows survive a retention run untouched", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, replicationId } = await seedBackupWithReplication(
        prisma
      );
      const before = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });

      const { runRetention } = await import("../lib/backup/retention");
      await runRetention({ client: prisma, now: new Date() });

      const after = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      // Every mutable field must be identical to the pre-retention state.
      assert.equal(after!.status, before!.status);
      assert.equal(after!.errorCode, before!.errorCode);
      assert.equal(after!.errorMessage, before!.errorMessage);
      assert.equal(after!.attestedContentSha256, before!.attestedContentSha256);
      assert.equal(after!.lastVerifyLevel, before!.lastVerifyLevel);
      assert.equal(
        after!.lastVerifiedAt?.getTime() ?? null,
        before!.lastVerifiedAt?.getTime() ?? null
      );
      assert.equal(after!.remoteBinFileId, before!.remoteBinFileId);
      assert.equal(after!.remoteManifestFileId, before!.remoteManifestFileId);
      // The Backup row itself may have had verifyResult / verifiedAt
      // set by other suites, but its id is unchanged.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.ok(bkp);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("Backup.status transition to DELETED leaves BackupReplication UNCHANGED (§O.1)", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, replicationId } = await seedBackupWithReplication(
        prisma
      );
      const before = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });

      await prisma.backup.update({
        where: { id: backupId },
        data: { status: "DELETED" }
      });

      const after = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(after!.status, before!.status);
      assert.equal(after!.errorCode, before!.errorCode);
      assert.equal(after!.remoteBinFileId, before!.remoteBinFileId);
      assert.equal(after!.remoteManifestFileId, before!.remoteManifestFileId);
      assert.equal(
        after!.updatedAt.getTime(),
        before!.updatedAt.getTime(),
        "BackupReplication.updatedAt must not bump when the Backup transitions to DELETED"
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("Backup.status transition to MISSING leaves BackupReplication UNCHANGED (§O.3)", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, replicationId } = await seedBackupWithReplication(
        prisma
      );
      const before = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      await prisma.backup.update({
        where: { id: backupId },
        data: { status: "MISSING" }
      });
      const after = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(after!.status, before!.status);
      assert.equal(after!.errorCode, before!.errorCode);
      assert.equal(
        after!.updatedAt.getTime(),
        before!.updatedAt.getTime()
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("FK Restrict refuses a hard DELETE of a Backup with a replication row", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId } = await seedBackupWithReplication(prisma);
      // Attempting a hard delete must throw because BackupReplication.backupId
      // has `onDelete: Restrict`.
      await assert.rejects(
        prisma.backup.delete({ where: { id: backupId } }),
        /Foreign key constraint|Restrict/i
      );
      // The Backup row is still there.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.ok(bkp);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── reconcileReplicationRemote — happy path ─────────────────────────────

describe("reconcileReplicationRemote — happy path", () => {
  test("both remote files present + non-trashed → OK, Backup untouched, verify fields untouched", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, replicationId } = await seedBackupWithReplication(
        prisma,
        {
          attestedContentSha256: sha256("prior-good-attest"),
          lastVerifyLevel: "FULL_SHA256"
        }
      );
      const drive = makeFakeDrive([
        { id: "remote-bin-id-1" },
        { id: "remote-mf-id-1" }
      ]);
      const result = await reconcileReplicationRemote(
        replicationId,
        buildDeps({ drive }, prisma)
      );
      assert.equal(result.outcome, "OK");
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.status, "COMPLETED");
      assert.equal(rep!.errorCode, "NONE");
      // Honesty gate: reconcile MUST NOT attest content — the deep-verify
      // service is the only source of `attestedContentSha256`.
      assert.equal(
        rep!.attestedContentSha256,
        sha256("prior-good-attest"),
        "reconcile must not overwrite attestedContentSha256"
      );
      assert.equal(rep!.lastVerifyLevel, "FULL_SHA256");
      // Backup is independent.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("clears a stale REMOTE_MISSING when both files come back", async () => {
    const prisma = await makePrisma();
    try {
      const { replicationId } = await seedBackupWithReplication(prisma, {
        errorCode: "REMOTE_MISSING"
      });
      // Set an errorMessage matching the stale state.
      await prisma.backupReplication.update({
        where: { id: replicationId },
        data: { errorMessage: "REMOTE_MISSING: prior detection" }
      });
      const drive = makeFakeDrive([
        { id: "remote-bin-id-1" },
        { id: "remote-mf-id-1" }
      ]);
      const result = await reconcileReplicationRemote(
        replicationId,
        buildDeps({ drive }, prisma)
      );
      assert.equal(result.outcome, "OK");
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.errorCode, "NONE");
      assert.equal(rep!.errorMessage, null);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── reconcileReplicationRemote — remote missing ─────────────────────────

describe("reconcileReplicationRemote — remote-missing detection", () => {
  test("bin 404 → REMOTE_MISSING; row stays COMPLETED; Backup untouched", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, replicationId } = await seedBackupWithReplication(
        prisma
      );
      // Only the manifest is present; the bin is gone.
      const drive = makeFakeDrive([{ id: "remote-mf-id-1" }]);
      const result = await reconcileReplicationRemote(
        replicationId,
        buildDeps({ drive }, prisma)
      );
      assert.equal(result.outcome, "REMOTE_MISSING");
      if (result.outcome !== "REMOTE_MISSING") return;
      assert.equal(result.binPresent, false);
      assert.equal(result.manifestPresent, true);
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.status, "COMPLETED");
      assert.equal(rep!.errorCode, "REMOTE_MISSING");
      // Backup independence.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("manifest trashed=true → REMOTE_MISSING", async () => {
    const prisma = await makePrisma();
    try {
      const { replicationId } = await seedBackupWithReplication(prisma);
      const drive = makeFakeDrive([
        { id: "remote-bin-id-1" },
        { id: "remote-mf-id-1", trashed: true }
      ]);
      const result = await reconcileReplicationRemote(
        replicationId,
        buildDeps({ drive }, prisma)
      );
      assert.equal(result.outcome, "REMOTE_MISSING");
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.errorCode, "REMOTE_MISSING");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("both files missing → REMOTE_MISSING with binPresent=false, manifestPresent=false", async () => {
    const prisma = await makePrisma();
    try {
      const { replicationId } = await seedBackupWithReplication(prisma);
      const drive = makeFakeDrive([]);
      const result = await reconcileReplicationRemote(
        replicationId,
        buildDeps({ drive }, prisma)
      );
      assert.equal(result.outcome, "REMOTE_MISSING");
      if (result.outcome !== "REMOTE_MISSING") return;
      assert.equal(result.binPresent, false);
      assert.equal(result.manifestPresent, false);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── reconcile — non-404 Drive error is NOT REMOTE_MISSING ───────────────

describe("reconcileReplicationRemote — Drive error handling", () => {
  test("500 server error → DRIVE_ERROR with classified SERVER_ERROR — NOT REMOTE_MISSING", async () => {
    const prisma = await makePrisma();
    try {
      const { replicationId } = await seedBackupWithReplication(prisma);
      const drive = makeDriveThatThrows(500);
      const result = await reconcileReplicationRemote(
        replicationId,
        buildDeps({ drive }, prisma)
      );
      assert.equal(result.outcome, "DRIVE_ERROR");
      if (result.outcome !== "DRIVE_ERROR") return;
      assert.equal(result.errorCode, "SERVER_ERROR");
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      // Row must NOT be marked REMOTE_MISSING — the file may still be
      // there; Drive is just unavailable.
      assert.notEqual(rep!.errorCode, "REMOTE_MISSING");
      assert.equal(rep!.errorCode, "SERVER_ERROR");
      // Status stays COMPLETED.
      assert.equal(rep!.status, "COMPLETED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── reconcile — skips ────────────────────────────────────────────────────

describe("reconcileReplicationRemote — skips", () => {
  test("SKIPPED_NOT_COMPLETED when row is not COMPLETED", async () => {
    const prisma = await makePrisma();
    try {
      const { replicationId } = await seedBackupWithReplication(prisma, {
        repStatus: "RETRYABLE_FAILURE"
      });
      const result = await reconcileReplicationRemote(
        replicationId,
        buildDeps({}, prisma)
      );
      assert.equal(result.outcome, "SKIPPED_NOT_COMPLETED");
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.status, "RETRYABLE_FAILURE");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("SKIPPED_NOT_REPLICATED when replication id does not exist", async () => {
    const prisma = await makePrisma();
    try {
      const result = await reconcileReplicationRemote(
        "cnonexistent_reconcile_id",
        buildDeps({}, prisma)
      );
      assert.equal(result.outcome, "SKIPPED_NOT_REPLICATED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Sanitization ────────────────────────────────────────────────────────

describe("reconcileReplicationRemote — sanitization", () => {
  test("errorMessage never contains bearer tokens, URLs, session URIs", async () => {
    const prisma = await makePrisma();
    try {
      const { replicationId } = await seedBackupWithReplication(prisma);
      // Fake Drive that throws with a leaky-looking response body — the
      // classifier must reduce this to a stable enum code.
      const LEAKY = "Bearer FAKE_TOKEN https://foo/upload_id=X?token=Y";
      const drive: DriveFolderApi = {
        files: {
          async get() {
            const err = new Error(LEAKY) as Error & {
              status: number;
              response: { status: number; data: object };
            };
            err.status = 503;
            err.response = { status: 503, data: { leaked: LEAKY } };
            throw err;
          },
          async list() {
            return { data: { files: [] } };
          }
        }
      };
      await reconcileReplicationRemote(
        replicationId,
        buildDeps({ drive }, prisma)
      );
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      const msg = rep!.errorMessage ?? "";
      assert.doesNotMatch(msg, /Bearer /);
      assert.doesNotMatch(msg, /upload_id=/);
      assert.doesNotMatch(msg, /FAKE_TOKEN/);
      assert.doesNotMatch(msg, /https:/);
    } finally {
      await prisma.$disconnect();
    }
  });
});

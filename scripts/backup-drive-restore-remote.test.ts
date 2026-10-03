// Layer I tests — remote restore integration (Plan §N).
//
// Run with:
//   npm run test:backup-drive-restore-remote
//
// Assertions cover the Layer I approval checklist:
//   * verifyBackup({source: staging}) round-trip against a real backup
//     copied into an isolated staging dir → VERIFIED with the same
//     shape as a published-source verify.
//   * verifyBackup({source: staging}) NEVER writes to any Backup row
//     (persist is forced to false regardless of caller flag).
//   * downloadAndVerifyDriveBackup happy path → LOCAL_BACKUP_MATERIALIZED
//     + files present under `published/` + a new Backup(status=COMPLETED)
//     row.
//   * downloadAndVerifyDriveBackup refuses when a local Backup row for
//     this id already exists (REFUSED_LOCAL_ALREADY_PRESENT).
//   * downloadAndVerifyDriveBackup refuses when no COMPLETED
//     BackupReplication row exists (REFUSED_NOT_REPLICATED).
//   * downloadAndVerifyDriveBackup teardown removes the per-op staging
//     subdir on both success and failure.
//   * downloadAndVerifyDriveBackup on tampered bin download → VERIFY_FAILED
//     and NO local Backup row created.
//   * Content-Length ceiling refusal on the bin download → DOWNLOAD_FAILED.
//   * Sanitized errors — no bearer / URL / session URI in outcome.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";

import {
  downloadAndVerifyDriveBackup,
  type RemoteRestoreDeps
} from "../lib/backup/replication/restore-remote";
import { REPLICATION_DESTINATION } from "../lib/backup/replication/uploader";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse
} from "../lib/backup/replication/http";

// ─── Prisma ────────────────────────────────────────────────────────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ACCESS_TOKEN = "layer-i-restore-fake-access-token";
const NOW = new Date("2026-09-29T15:00:00Z");

let scratchDir = "";
let originalStorageDir: string | undefined;
let originalEncryptionKey: string | undefined;

const createdBackupIds: string[] = [];
const testWindowStart = new Date();

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

async function ensureBackupSubdirs(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "staging"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, "published"), { recursive: true, mode: 0o700 });
}

/**
 * Produce a valid encrypted backup pair on disk via `runBackupDump`,
 * then return the bin + manifest bytes so tests can drive the
 * download-first flow against them.
 */
async function produceRealBackup(prisma: PrismaClient): Promise<{
  backupId: string;
  binBytes: Buffer;
  manifestBytes: Buffer;
}> {
  const { runBackupDump } = await import("../lib/backup/dump");
  const dump = await runBackupDump({ kind: "MANUAL", client: prisma });
  createdBackupIds.push(dump.backupId);
  const publishedDir = path.join(process.env.BACKUP_STORAGE_DIR!, "published");
  const binPath = path.join(publishedDir, `${dump.backupId}.bin`);
  const manifestPath = path.join(
    publishedDir,
    `${dump.backupId}.manifest.json`
  );
  const [binBytes, manifestBytes] = await Promise.all([
    fs.readFile(binPath),
    fs.readFile(manifestPath)
  ]);
  return { backupId: dump.backupId, binBytes, manifestBytes };
}

type HttpHandler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
function makeHttp(handlers: HttpHandler[]): {
  http: HttpClient;
  calls: HttpRequest[];
} {
  const calls: HttpRequest[] = [];
  const script = [...handlers];
  const http: HttpClient = async (req) => {
    calls.push(req);
    const h = script.shift();
    if (!h) throw new Error(`unexpected http call to ${req.url.slice(0, 50)}`);
    return await h(req);
  };
  return { http, calls };
}
function response(
  status: number,
  headers: Record<string, string> = {},
  body: string | Buffer = ""
): HttpResponse {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  return {
    status,
    headers: lowered,
    body: typeof body === "string" ? Buffer.from(body, "utf-8") : body
  };
}

function buildDeps(
  overrides: Partial<RemoteRestoreDeps>,
  prisma: PrismaClient
): RemoteRestoreDeps {
  return {
    prisma,
    http: makeHttp([]).http,
    accessToken: ACCESS_TOKEN,
    now: () => NOW,
    httpTimeoutMs: 30_000,
    storageDirOverride: scratchDir,
    ...overrides
  };
}

async function seedCompletedReplication(
  prisma: PrismaClient,
  backupId: string,
  overrides: {
    remoteBinFileId?: string;
    remoteManifestFileId?: string;
  } = {}
): Promise<string> {
  const rep = await prisma.backupReplication.create({
    data: {
      backupId,
      destination: REPLICATION_DESTINATION,
      status: "COMPLETED",
      remoteBinFileId: overrides.remoteBinFileId ?? "remote-bin-id-1",
      remoteManifestFileId: overrides.remoteManifestFileId ?? "remote-mf-id-1",
      remoteFolderId: "remote-folder-id"
    }
  });
  return rep.id;
}

// ─── Suite setup + teardown ───────────────────────────────────────────────

before(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "bis-restore-remote-"));
  originalStorageDir = process.env.BACKUP_STORAGE_DIR;
  originalEncryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_STORAGE_DIR = scratchDir;
  // Ensure a valid encryption key so `runBackupDump` succeeds.
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  }
  await ensureBackupSubdirs(scratchDir);
});

after(async () => {
  // Restore env FIRST so downstream cleanup uses the operator's dev DB, not
  // our scratch.
  if (originalStorageDir === undefined) {
    delete process.env.BACKUP_STORAGE_DIR;
  } else {
    process.env.BACKUP_STORAGE_DIR = originalStorageDir;
  }
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
  await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
});

// ─── verifyBackup({source: staging}) — extension smoke tests ─────────────

describe("verifyBackup — source=staging additive extension", () => {
  test("real backup copied into a staging dir verifies as VERIFIED", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, binBytes, manifestBytes } = await produceRealBackup(
        prisma
      );
      // Move the two files into a fresh staging subdir.
      const stagingDir = path.join(
        scratchDir,
        "staging",
        `verify-staged-${backupId}`
      );
      await fs.mkdir(stagingDir, { recursive: true });
      const binName = `${backupId}.bin`;
      const manifestName = `${backupId}.manifest.json`;
      await fs.writeFile(path.join(stagingDir, binName), binBytes);
      await fs.writeFile(path.join(stagingDir, manifestName), manifestBytes);

      const { verifyBackup } = await import("../lib/backup/verify");
      const result = await verifyBackup({
        backupId,
        client: prisma,
        persist: false, // explicit, though staging forces false anyway
        compareDb: false,
        source: { kind: "staging", dir: stagingDir, binName, manifestName }
      });
      assert.equal(result.outcome, "VERIFIED", `detail=${result.detail}`);
      assert.equal(result.code, "OK");
      assert.equal(result.stage, "SCHEMA_COMPATIBILITY");
      assert.equal(result.contentSha256?.length, 64);

      // The Backup row must NOT have been mutated by a staging verify —
      // check by re-reading verifiedAt.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.ok(bkp);
      // dump.ts inserts the row with completedAt set by the pipeline
      // but verifiedAt is initially null (dump does not verify itself).
      assert.equal(bkp!.verifiedAt, null);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("persist=true is IGNORED when source.kind is staging (no local writes)", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, binBytes, manifestBytes } = await produceRealBackup(
        prisma
      );
      const stagingDir = path.join(
        scratchDir,
        "staging",
        `persist-ignore-${backupId}`
      );
      await fs.mkdir(stagingDir, { recursive: true });
      const binName = `${backupId}.bin`;
      const manifestName = `${backupId}.manifest.json`;
      await fs.writeFile(path.join(stagingDir, binName), binBytes);
      await fs.writeFile(path.join(stagingDir, manifestName), manifestBytes);

      const { verifyBackup } = await import("../lib/backup/verify");
      const before = await prisma.backup.findUnique({ where: { id: backupId } });
      const result = await verifyBackup({
        backupId,
        client: prisma,
        persist: true, // caller asks for persist — module MUST ignore
        compareDb: false,
        source: { kind: "staging", dir: stagingDir, binName, manifestName }
      });
      assert.equal(result.outcome, "VERIFIED");
      const after = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(after!.verifiedAt, before!.verifiedAt);
      assert.equal(after!.verifyResult, before!.verifyResult);
      assert.equal(after!.status, before!.status);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("published-source verify (default) still runs unchanged", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId } = await produceRealBackup(prisma);
      const { verifyBackup } = await import("../lib/backup/verify");
      const result = await verifyBackup({
        backupId,
        client: prisma,
        persist: false,
        compareDb: false
        // no source → defaults to published
      });
      assert.equal(result.outcome, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── downloadAndVerifyDriveBackup ────────────────────────────────────────

describe("downloadAndVerifyDriveBackup — happy path", () => {
  test("downloads, verifies, promotes, and inserts a new Backup(status=COMPLETED)", async () => {
    const prisma = await makePrisma();
    try {
      // Produce a real backup pair, capture bytes, then WIPE the local
      // state so downloadAndVerifyDriveBackup sees a fresh id (as in a
      // DR scenario). BackupReplication has an FK to Backup so we
      // cannot seed a "row exists without backup" row directly — we
      // use the DR/Mode-2 caller-supplied file-ids path instead.
      const { backupId, binBytes, manifestBytes } = await produceRealBackup(
        prisma
      );
      const publishedDir = path.join(scratchDir, "published");
      await fs.unlink(path.join(publishedDir, `${backupId}.bin`));
      await fs.unlink(path.join(publishedDir, `${backupId}.manifest.json`));
      await prisma.backup.delete({ where: { id: backupId } });
      const idx = createdBackupIds.indexOf(backupId);
      if (idx >= 0) createdBackupIds.splice(idx, 1);
      createdBackupIds.push(backupId);

      const { http } = makeHttp([
        // First download: bin
        () =>
          response(
            200,
            { "content-length": String(binBytes.byteLength) },
            binBytes
          ),
        // Second download: manifest
        () =>
          response(
            200,
            { "content-length": String(manifestBytes.byteLength) },
            manifestBytes
          )
      ]);

      const result = await downloadAndVerifyDriveBackup(
        backupId,
        buildDeps(
          {
            http,
            overrideRemoteFileIds: {
              remoteBinFileId: "remote-bin-id-happy",
              remoteManifestFileId: "remote-mf-id-happy"
            }
          },
          prisma
        )
      );
      assert.equal(
        result.outcome,
        "LOCAL_BACKUP_MATERIALIZED",
        `unexpected outcome ${result.outcome}`
      );
      if (result.outcome !== "LOCAL_BACKUP_MATERIALIZED") return;

      // Published/ contains the promoted files.
      const publishedBin = path.join(publishedDir, `${backupId}.bin`);
      const publishedManifest = path.join(
        publishedDir,
        `${backupId}.manifest.json`
      );
      const [binStat, manifestStat] = await Promise.all([
        fs.stat(publishedBin),
        fs.stat(publishedManifest)
      ]);
      assert.equal(binStat.size, binBytes.byteLength);
      assert.equal(manifestStat.size, manifestBytes.byteLength);

      // Backup row inserted with status=COMPLETED.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.ok(bkp);
      assert.equal(bkp!.status, "COMPLETED");
      assert.equal(bkp!.contentSha256?.length, 64);
      assert.equal(bkp!.manifestSha256?.length, 64);

      // Per-op staging subdir was torn down.
      const stagingChildren = await fs.readdir(
        path.join(scratchDir, "staging")
      );
      const orphans = stagingChildren.filter((n) =>
        n.startsWith(`drive-restore-${result.operationId}`)
      );
      assert.deepEqual(orphans, []);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── downloadAndVerifyDriveBackup — refusals ─────────────────────────────

describe("downloadAndVerifyDriveBackup — refusals", () => {
  test("REFUSED_NOT_REPLICATED when no BackupReplication row exists", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = makeCuid();
      const result = await downloadAndVerifyDriveBackup(
        backupId,
        buildDeps({}, prisma)
      );
      assert.equal(result.outcome, "REFUSED_NOT_REPLICATED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("REFUSED_LOCAL_ALREADY_PRESENT when a Backup row for this id exists", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId } = await produceRealBackup(prisma);
      await seedCompletedReplication(prisma, backupId);
      const result = await downloadAndVerifyDriveBackup(
        backupId,
        buildDeps({}, prisma)
      );
      assert.equal(result.outcome, "REFUSED_LOCAL_ALREADY_PRESENT");
      // Backup row is untouched.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.ok(bkp);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── downloadAndVerifyDriveBackup — verify failure ───────────────────────

describe("downloadAndVerifyDriveBackup — verify failure", () => {
  test("tampered bin → VERIFY_FAILED and NO local Backup row is created", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, binBytes, manifestBytes } = await produceRealBackup(
        prisma
      );
      await fs.unlink(
        path.join(scratchDir, "published", `${backupId}.bin`)
      );
      await fs.unlink(
        path.join(scratchDir, "published", `${backupId}.manifest.json`)
      );
      await prisma.backup.delete({ where: { id: backupId } });
      const idx = createdBackupIds.indexOf(backupId);
      if (idx >= 0) createdBackupIds.splice(idx, 1);
      createdBackupIds.push(backupId);

      // Tamper: flip one middle byte of the bin. AES-GCM will refuse.
      const tampered = Buffer.from(binBytes);
      tampered[Math.floor(tampered.length / 2)] ^= 0x01;

      const { http } = makeHttp([
        () =>
          response(
            200,
            { "content-length": String(tampered.byteLength) },
            tampered
          ),
        () =>
          response(
            200,
            { "content-length": String(manifestBytes.byteLength) },
            manifestBytes
          )
      ]);
      const result = await downloadAndVerifyDriveBackup(
        backupId,
        buildDeps(
          {
            http,
            overrideRemoteFileIds: {
              remoteBinFileId: "remote-bin-id-tampered",
              remoteManifestFileId: "remote-mf-id-tampered"
            }
          },
          prisma
        )
      );
      assert.equal(result.outcome, "VERIFY_FAILED");
      // No local Backup row inserted.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp, null);
      // Staging cleaned.
      const stagingChildren = await fs.readdir(
        path.join(scratchDir, "staging")
      );
      const orphans = stagingChildren.filter((n) =>
        n.startsWith("drive-restore-")
      );
      assert.deepEqual(orphans, []);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── downloadAndVerifyDriveBackup — download failure ─────────────────────

describe("downloadAndVerifyDriveBackup — download failure", () => {
  test("Content-Length exceeds ceiling → DOWNLOAD_FAILED, no Backup row", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = makeCuid();
      createdBackupIds.push(backupId);

      const oversizedBody = Buffer.alloc(10);
      const { http } = makeHttp([
        () =>
          response(
            200,
            { "content-length": "999999999999" },
            oversizedBody
          )
      ]);
      const result = await downloadAndVerifyDriveBackup(
        backupId,
        buildDeps(
          {
            http,
            overrideRemoteFileIds: {
              remoteBinFileId: "remote-bin-id-oversize",
              remoteManifestFileId: "remote-mf-id-oversize"
            }
          },
          prisma
        )
      );
      assert.equal(result.outcome, "DOWNLOAD_FAILED");
      if (result.outcome !== "DOWNLOAD_FAILED") return;
      assert.equal(result.errorCode, "REMOTE_SIZE_MISMATCH");
      // No Backup row inserted.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp, null);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Sanitization ────────────────────────────────────────────────────────

describe("downloadAndVerifyDriveBackup — sanitization", () => {
  test("outcome message never contains bearer / URL / session URI", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = makeCuid();
      createdBackupIds.push(backupId);
      const leaky = JSON.stringify({
        url: "https://www.googleapis.com/upload/session/x?upload_id=SECRET_TOKEN",
        authorization: `Bearer ${ACCESS_TOKEN}`
      });
      const { http } = makeHttp([() => response(500, {}, leaky)]);
      const result = await downloadAndVerifyDriveBackup(
        backupId,
        buildDeps(
          {
            http,
            overrideRemoteFileIds: {
              remoteBinFileId: "remote-bin-id-sanitize",
              remoteManifestFileId: "remote-mf-id-sanitize"
            }
          },
          prisma
        )
      );
      assert.equal(result.outcome, "DOWNLOAD_FAILED");
      if (result.outcome !== "DOWNLOAD_FAILED") return;
      const msg = result.sanitizedMessage;
      assert.doesNotMatch(msg, /Bearer /);
      assert.doesNotMatch(msg, /upload_id=/);
      assert.doesNotMatch(msg, /SECRET_TOKEN/);
      assert.doesNotMatch(msg, new RegExp(ACCESS_TOKEN));
    } finally {
      await prisma.$disconnect();
    }
  });
});

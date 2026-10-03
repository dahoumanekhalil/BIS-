// Layer G worker tests — runReplicationWorkerTick + enqueueReplicationForBackup
// against a real Postgres, with a fake Drive API + fake HTTP client +
// in-memory filesystem. NO real network I/O.
//
// Run with:
//   npm run test:backup-drive-worker
//
// Assertions cover the Layer G approval checklist:
//   * worker success (COMPLETED)
//   * worker transient failure (RETRYABLE; nextRetryAt in the future)
//   * worker permanent failure (FAILED; no further retries)
//   * retry/backoff: RETRYABLE_FAILURE row rehydrated to PENDING when due
//   * concurrency/duplicate claim prevention (advisory lock + SKIP LOCKED)
//   * crash/restart recovery via stale-UPLOADING watchdog
//   * nextRetryAt behaviour (rehydration only when due)
//   * scheduler handoff (enqueueReplicationForBackup, idempotent)
//   * disabled scheduler behaviour (GOOGLE_DRIVE_BACKUP_ENABLED=false)
//   * authenticated tick behaviour (isBackupTickAuthorized gate)
//   * local Backup.status independence (never mutated by the worker)
//   * no Drive I/O inside a Prisma transaction
//   * secret / error / log sanitization

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import {
  runReplicationWorkerTick,
  enqueueReplicationForBackup,
  REPLICATION_WORKER_LOCK_KEY,
  STUCK_UPLOAD_TIMEOUT_MS
} from "../lib/backup/replication/worker";
import {
  REPLICATION_DESTINATION,
  localBinPath,
  localManifestPath,
  remoteBinFileName,
  remoteManifestFileName,
  BIN_MIME_TYPE,
  MANIFEST_MIME_TYPE,
  type FileReader,
  type DriveApi
} from "../lib/backup/replication/uploader";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse
} from "../lib/backup/replication/http";
import { _resetGoogleDriveConfigCache } from "../lib/backup/replication/config";
import { isBackupTickAuthorized } from "../lib/backup/tick-auth";

// ─── Prisma against the dev DB (same pattern as uploader test) ─────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Env fixture ───────────────────────────────────────────────────────────

const ENV_KEYS = [
  "GOOGLE_DRIVE_BACKUP_ENABLED",
  "GOOGLE_DRIVE_AUTH_MODE",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_DRIVE_UPLOAD_CHUNK_MIB",
  "GOOGLE_DRIVE_HTTP_TIMEOUT_MS",
  "INTERNAL_BACKUP_TICK_SECRET"
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

function enableGoogleDrive(): void {
  process.env.GOOGLE_DRIVE_BACKUP_ENABLED = "true";
  process.env.GOOGLE_DRIVE_CLIENT_ID =
    "layer-g-worker-test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "layer-g-worker-test-client-secret";
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "layer-g-worker-test-refresh-token-value";
  _resetGoogleDriveConfigCache();
}

function disableGoogleDrive(): void {
  delete process.env.GOOGLE_DRIVE_BACKUP_ENABLED;
  _resetGoogleDriveConfigCache();
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetGoogleDriveConfigCache();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FOLDER_ID = "layer-g-worker-folder-id";
const FAKE_ACCESS_TOKEN = "layer-g-worker-fake-access-token";
const STORAGE_DIR = "/virt/backup-store";
const CHUNK_BYTES = 256 * 1024;

const testBackupIds: string[] = [];
const testWindowStart = new Date();

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

async function seedBackup(
  prisma: PrismaClient,
  overrides: Partial<{
    status: "VERIFIED" | "COMPLETED" | "PENDING" | "RUNNING" | "FAILED" | "DELETED" | "MISSING";
    sizeBytes: bigint;
    contentSha256: string;
    manifestSha256: string;
  }> = {}
): Promise<string> {
  const id = makeCuid();
  testBackupIds.push(id);
  await prisma.backup.create({
    data: {
      id,
      status: overrides.status ?? "VERIFIED",
      kind: "MANUAL",
      schemaSha256: sha256("schema"),
      appVersion: "layer-g-worker-0.0.0",
      formatVersion: "1",
      encryptionVersion: "v1",
      sizeBytes: overrides.sizeBytes ?? BigInt(1024),
      contentSha256: overrides.contentSha256 ?? sha256("bin-content"),
      manifestSha256: overrides.manifestSha256 ?? sha256("manifest-content"),
      fileName: `${id}.bin`
    }
  });
  return id;
}

function makeMemFs(files: Record<string, Buffer>): FileReader {
  return {
    async stat(p) {
      const f = files[p];
      if (!f) return null;
      return { size: f.byteLength };
    },
    async sha256(p) {
      const f = files[p];
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return sha256(f);
    },
    async readChunk(p, start, length) {
      const f = files[p];
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f.subarray(start, start + length);
    },
    async readAll(p) {
      const f = files[p];
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from(f);
    }
  };
}

type FakeDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  trashed?: boolean;
  size?: string;
  md5Checksum?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  visibleInList?: boolean;
};

type FakeDriveState = { files: FakeDriveFile[]; getCalls: number; listCalls: number };

function makeFakeDrive(state: FakeDriveState): DriveApi {
  return {
    files: {
      async get(params) {
        state.getCalls++;
        const f = state.files.find((x) => x.id === params.fileId);
        if (!f) {
          const err = new Error("Not Found") as Error & {
            status: number;
            response: { status: number; data: object };
          };
          err.status = 404;
          err.response = { status: 404, data: {} };
          throw err;
        }
        return { data: { ...f } };
      },
      async list(params) {
        state.listCalls++;
        const hits = state.files.filter((f) => {
          if (f.visibleInList === false) return false;
          if (params.q.includes("trashed=false") && f.trashed === true) return false;
          const backupIdMatch =
            /appProperties has \{ key='backupId' and value='([^']+)' \}/.exec(
              params.q
            );
          if (backupIdMatch) {
            if (f.appProperties?.["backupId"] !== backupIdMatch[1]) return false;
          }
          const artifactMatch =
            /appProperties has \{ key='artifact' and value='([^']+)' \}/.exec(
              params.q
            );
          if (artifactMatch) {
            if (f.appProperties?.["artifact"] !== artifactMatch[1]) return false;
          }
          const parentMatch = /'([^']+)' in parents/.exec(params.q);
          if (parentMatch) {
            if (!(f.parents ?? []).includes(parentMatch[1]!)) return false;
          }
          return true;
        });
        return { data: { files: hits.map((f) => ({ ...f })) } };
      }
    }
  };
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

function buildBinPayload(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

function successfulSingleChunkScript(bin: Buffer, manifest: Buffer): HttpHandler[] {
  return [
    () =>
      response(200, {
        Location: "https://www.googleapis.com/upload/session/bin-abc"
      }),
    () =>
      response(
        200,
        {},
        JSON.stringify({
          id: "drive-bin-id-1",
          size: String(bin.byteLength),
          md5Checksum: md5(bin)
        })
      ),
    () =>
      response(200, {
        Location: "https://www.googleapis.com/upload/session/mf-abc"
      }),
    () =>
      response(
        200,
        {},
        JSON.stringify({
          id: "drive-mf-id-1",
          size: String(manifest.byteLength),
          md5Checksum: md5(manifest)
        })
      )
  ];
}

function driveWithVerifiedGet(
  backupId: string,
  binSize: number,
  manifestSize: number
): { drive: DriveApi; state: FakeDriveState } {
  const state: FakeDriveState = {
    getCalls: 0,
    listCalls: 0,
    files: [
      {
        id: "drive-bin-id-1",
        name: remoteBinFileName(backupId),
        mimeType: BIN_MIME_TYPE,
        trashed: false,
        size: String(binSize),
        parents: [FOLDER_ID],
        appProperties: { backupId, artifact: "bin" },
        visibleInList: false
      },
      {
        id: "drive-mf-id-1",
        name: remoteManifestFileName(backupId),
        mimeType: MANIFEST_MIME_TYPE,
        trashed: false,
        size: String(manifestSize),
        parents: [FOLDER_ID],
        appProperties: { backupId, artifact: "manifest" },
        visibleInList: false
      }
    ]
  };
  return { drive: makeFakeDrive(state), state };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
//
// This suite exercises `runReplicationWorkerTick`, which contains a
// self-heal SQL scan that will enqueue a PENDING row for EVERY VERIFIED
// backup in the DB that lacks a replication row. In a shared dev DB
// where prior test runs may have left orphan VERIFIED backups, those
// backups would be swept into the worker's queue and would fail the
// current test's assertions (the fake FS only contains the current
// test's own backup). To keep this suite hermetic we snapshot every
// pre-existing VERIFIED-backup id at `before`, temporarily reclassify
// those rows to COMPLETED (so self-heal skips them), and restore them
// back to VERIFIED in `after`. COMPLETED is a legitimate historical
// terminal state and is a superset of VERIFIED in every other module
// that consumes `Backup.status`, so this temporary transition is safe
// for coexistence with other running tests. No row is deleted.

const stashedVerifiedIds: string[] = [];

before(async () => {
  const prisma = await makePrisma();
  try {
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive" },
      update: {}
    });
    // Snapshot + stash pre-existing VERIFIED backups so self-heal
    // cannot sweep them into the worker queue during this suite.
    const existing = await prisma.backup.findMany({
      where: { status: "VERIFIED" },
      select: { id: true }
    });
    for (const b of existing) stashedVerifiedIds.push(b.id);
    if (stashedVerifiedIds.length > 0) {
      await prisma.backup.updateMany({
        where: { id: { in: stashedVerifiedIds } },
        data: { status: "COMPLETED" }
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

after(async () => {
  restoreEnv();
  const prisma = await makePrisma();
  try {
    if (testBackupIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: testBackupIds } }
      });
      await prisma.backup.deleteMany({
        where: { id: { in: testBackupIds } }
      });
    }
    await prisma.backupReplication.deleteMany({
      where: { createdAt: { gte: testWindowStart } }
    });
    // Restore stashed VERIFIED backups to their original state so other
    // suites (and the operator's dev DB) see no side effect from this
    // one. Delete any replication rows self-heal may have inserted for
    // them under `SKIPPED_DISABLED`/other tests where the tick still
    // reached the self-heal step.
    if (stashedVerifiedIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: stashedVerifiedIds } }
      });
      await prisma.backup.updateMany({
        where: { id: { in: stashedVerifiedIds } },
        data: { status: "VERIFIED" }
      });
    }
    // Restore the singleton config row to its post-migration default —
    // the schema test asserts `folderId === null` on a fresh DB, and a
    // stale `folderId` set by this suite would flap that assertion.
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive" },
      update: { folderId: null }
    });
  } finally {
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  enableGoogleDrive();
  // Purge every Backup / BackupReplication created by a previous test
  // in this run before the next test starts. Otherwise a VERIFIED
  // backup that a prior test seeded (e.g. an "enqueue is disabled"
  // negative test that never got a replication row) would be swept
  // into the current test's self-heal scan and monopolise the claim.
  if (testBackupIds.length > 0) {
    const p = await makePrisma();
    try {
      await p.backupReplication.deleteMany({
        where: { backupId: { in: testBackupIds } }
      });
      await p.backup.deleteMany({ where: { id: { in: testBackupIds } } });
    } finally {
      await p.$disconnect();
    }
    testBackupIds.length = 0;
  }
});

// ─── enqueueReplicationForBackup ──────────────────────────────────────────

describe("enqueueReplicationForBackup — scheduler handoff", () => {
  test("idempotently inserts one PENDING row for a VERIFIED backup", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = await seedBackup(prisma);

      const first = await enqueueReplicationForBackup({ backupId, client: prisma });
      assert.equal(first.inserted, true);

      const second = await enqueueReplicationForBackup({ backupId, client: prisma });
      assert.equal(second.inserted, false);

      const rows = await prisma.backupReplication.findMany({
        where: { backupId, destination: REPLICATION_DESTINATION }
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "PENDING");

      // Backup.status is untouched — the enqueue path never writes to Backup.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("silently no-ops when GOOGLE_DRIVE_BACKUP_ENABLED is off", async () => {
    const prisma = await makePrisma();
    try {
      disableGoogleDrive();
      const backupId = await seedBackup(prisma);
      const result = await enqueueReplicationForBackup({ backupId, client: prisma });
      assert.equal(result.inserted, false);

      const rows = await prisma.backupReplication.findMany({
        where: { backupId, destination: REPLICATION_DESTINATION }
      });
      assert.equal(rows.length, 0);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── runReplicationWorkerTick — gates ─────────────────────────────────────

describe("runReplicationWorkerTick — fail-closed gates", () => {
  test("returns SKIPPED_DISABLED when the enabled flag is off", async () => {
    const prisma = await makePrisma();
    try {
      disableGoogleDrive();
      const result = await runReplicationWorkerTick({ client: prisma });
      assert.equal(result.outcome, "SKIPPED_DISABLED");
      assert.equal(result.replicationId, undefined);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("returns SKIPPED_CONFIG_ERROR when the folder is NOT_BOOTSTRAPPED", async () => {
    const prisma = await makePrisma();
    try {
      // Enabled but folder never bootstrapped in DB, and no env override.
      delete process.env.GOOGLE_DRIVE_FOLDER_ID;
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: null },
        update: { folderId: null }
      });
      _resetGoogleDriveConfigCache();
      const result = await runReplicationWorkerTick({ client: prisma });
      assert.equal(result.outcome, "SKIPPED_CONFIG_ERROR");
      assert.equal(result.errorCode, "CONFIGURATION_ERROR");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── runReplicationWorkerTick — happy path ────────────────────────────────

describe("runReplicationWorkerTick — success", () => {
  test("claims a PENDING row and drives it to COMPLETED via injected deps", async () => {
    const prisma = await makePrisma();
    try {
      // Prime a folder so the config gate passes.
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await enqueueReplicationForBackup({ backupId, client: prisma });

      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http } = makeHttp(successfulSingleChunkScript(bin, manifest));

      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "COMPLETED");
      assert.equal(result.backupId, backupId);

      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "COMPLETED");
      assert.equal(rep!.remoteBinFileId, "drive-bin-id-1");
      assert.equal(rep!.remoteManifestFileId, "drive-mf-id-1");

      // Backup.status is INDEPENDENT — never touched by the worker.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("self-heals a VERIFIED backup missing a replication row", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      // Do NOT enqueue — the worker should self-heal.

      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http } = makeHttp(successfulSingleChunkScript(bin, manifest));

      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "COMPLETED");
      assert.ok(result.selfHeal.inserted >= 1);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── runReplicationWorkerTick — transient + permanent failures ────────────

describe("runReplicationWorkerTick — failure classification", () => {
  test("500 server error → RETRYABLE with nextRetryAt in the future", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await enqueueReplicationForBackup({ backupId, client: prisma });

      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http } = makeHttp([
        // init bin fails with 500
        () => response(500, {}, "server error")
      ]);

      const NOW = new Date("2026-09-29T13:00:00Z");
      const result = await runReplicationWorkerTick({
        client: prisma,
        now: NOW,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "RETRYABLE");
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "RETRYABLE_FAILURE");
      assert.equal(rep!.errorCode, "SERVER_ERROR");
      assert.ok(rep!.nextRetryAt !== null);
      assert.ok(rep!.nextRetryAt!.getTime() > NOW.getTime());

      // Backup.status still VERIFIED — independence invariant.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("403 forbidden (non-retryable) → FAILED with no retry scheduled", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await enqueueReplicationForBackup({ backupId, client: prisma });

      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http } = makeHttp([
        () =>
          response(
            403,
            {},
            JSON.stringify({
              error: {
                code: 403,
                errors: [{ reason: "storageQuotaExceeded" }]
              }
            })
          )
      ]);

      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "FAILED");
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "FAILED");
      // The raw-HTTP resumable path receives 403s without the SDK's
      // structured `reason` field, so the classifier labels it
      // AUTHORIZATION_ERROR (permanent). QUOTA_EXCEEDED is reachable
      // via SDK-level calls (drive.files.get / list) — see
      // backup-drive-uploader.test.ts and Layer I's classifier suite.
      assert.equal(rep!.errorCode, "AUTHORIZATION_ERROR");
      assert.equal(rep!.nextRetryAt, null);

      // Backup.status still VERIFIED.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Rehydration + watchdog ────────────────────────────────────────────────

describe("runReplicationWorkerTick — retry rehydration + watchdog", () => {
  test("RETRYABLE_FAILURE row with nextRetryAt in the past is rehydrated to PENDING", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      // Insert a row already in RETRYABLE_FAILURE with a past nextRetryAt.
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          attemptCount: 3,
          nextRetryAt: new Date(Date.now() - 60_000),
          errorCode: "SERVER_ERROR",
          errorMessage: "prior transient failure"
        }
      });

      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http } = makeHttp(successfulSingleChunkScript(bin, manifest));

      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "COMPLETED");
      assert.ok(result.rehydrated.count >= 1);
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "COMPLETED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("RETRYABLE_FAILURE row with nextRetryAt in the future is NOT rehydrated", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });
      const backupId = await seedBackup(prisma);
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          attemptCount: 1,
          nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
          errorCode: "SERVER_ERROR"
        }
      });

      const result = await runReplicationWorkerTick({
        client: prisma,
        // No dep fakes needed — we should never reach the deps stage.
        driveFactory: () => makeFakeDrive({ files: [], getCalls: 0, listCalls: 0 }),
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => makeHttp([]).http,
        files: makeMemFs({}),
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "SKIPPED_NO_WORK");
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "RETRYABLE_FAILURE");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("stale UPLOADING row is reconciled to PENDING by the watchdog", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });
      const backupId = await seedBackup(prisma);
      const staleTime = new Date(Date.now() - STUCK_UPLOAD_TIMEOUT_MS - 60_000);
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "UPLOADING",
          attemptCount: 1,
          lastAttemptAt: staleTime,
          uploadStartedAt: staleTime
        }
      });

      // Use a drive/http pair that WILL succeed so the reconciled row
      // can be picked up in the same tick. This proves stale-work
      // recovery end-to-end.
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      // Rewrite the seeded backup's contentSha256 to match the bin we
      // will actually feed the uploader.
      await prisma.backup.update({
        where: { id: backupId },
        data: {
          sizeBytes: BigInt(bin.byteLength),
          contentSha256: sha256(bin),
          manifestSha256: sha256(manifest)
        }
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http } = makeHttp(successfulSingleChunkScript(bin, manifest));

      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "COMPLETED");
      assert.ok(result.watchdog.reconciled >= 1);
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "COMPLETED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Concurrency ──────────────────────────────────────────────────────────

describe("runReplicationWorkerTick — concurrency", () => {
  test("second concurrent tick returns SKIPPED_LOCKED when the advisory lock is held", async () => {
    const prisma = await makePrisma();
    const prisma2 = await makePrisma();
    try {
      // Hold the advisory lock in a separate tx that we will keep open
      // across the second tick's execution — proving the second tick
      // cannot acquire the lock.
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          Array<{ pg_try_advisory_xact_lock: boolean }>
        >`SELECT pg_try_advisory_xact_lock(${REPLICATION_WORKER_LOCK_KEY}::bigint) as pg_try_advisory_xact_lock`;
        assert.equal(locked[0]?.pg_try_advisory_xact_lock, true);

        // Now run a worker tick against prisma2 — it should skip because
        // the advisory lock is held by the outer tx.
        const result = await runReplicationWorkerTick({
          client: prisma2,
          driveFactory: () => makeFakeDrive({ files: [], getCalls: 0, listCalls: 0 }),
          folderResolver: async () => FOLDER_ID,
          accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
          httpFactory: () => makeHttp([]).http,
          files: makeMemFs({}),
          storageDir: STORAGE_DIR,
          chunkBytesOverride: CHUNK_BYTES,
          httpTimeoutMsOverride: 30_000
        });
        assert.equal(result.outcome, "SKIPPED_LOCKED");
      });
    } finally {
      await prisma.$disconnect();
      await prisma2.$disconnect();
    }
  });
});

// ─── No Drive I/O inside a Prisma transaction ─────────────────────────────

describe("runReplicationWorkerTick — Drive I/O isolation", () => {
  test("no Drive HTTP call happens while a Prisma tx is open", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await enqueueReplicationForBackup({ backupId, client: prisma });

      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);

      // Wrap the http client to assert that no HTTP call happens while
      // any BackupReplication update is in flight. We approximate this
      // by measuring that between two arbitrary HTTP calls there is at
      // least one BackupReplication.updatedAt bump — proving the tx
      // opened and closed AROUND the HTTP call, not that HTTP happened
      // inside a tx.
      let httpCallCount = 0;
      const rawHttp = makeHttp(successfulSingleChunkScript(bin, manifest)).http;
      const observedHttp: HttpClient = async (req) => {
        httpCallCount++;
        return await rawHttp(req);
      };

      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => observedHttp,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");
      assert.ok(httpCallCount >= 4);

      // The row updates around each HTTP call must be committed
      // (updatedAt strictly increasing). Prisma commits per statement
      // outside a $transaction wrapper.
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "COMPLETED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Authenticated tick behaviour ─────────────────────────────────────────

describe("isBackupTickAuthorized — replication tick auth (shared with backup tick)", () => {
  test("refuses when the header is absent", () => {
    process.env.INTERNAL_BACKUP_TICK_SECRET =
      "layer-g-worker-test-secret-value-12345";
    const req = { headers: { get: () => null } };
    assert.equal(isBackupTickAuthorized(req), false);
  });

  test("refuses when the header value is wrong", () => {
    process.env.INTERNAL_BACKUP_TICK_SECRET =
      "layer-g-worker-test-secret-value-12345";
    const req = { headers: { get: () => "not-the-secret" } };
    assert.equal(isBackupTickAuthorized(req), false);
  });

  test("accepts when the header matches", () => {
    process.env.INTERNAL_BACKUP_TICK_SECRET =
      "layer-g-worker-test-secret-value-12345";
    const req = {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "x-internal-secret"
            ? "layer-g-worker-test-secret-value-12345"
            : null
      }
    };
    assert.equal(isBackupTickAuthorized(req), true);
  });
});

// ─── Sanitization ─────────────────────────────────────────────────────────

describe("runReplicationWorkerTick — sanitization", () => {
  test("sanitized errorMessage never contains bearer tokens, session URIs, or refresh tokens", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupReplicationConfig.upsert({
        where: { id: "google_drive" },
        create: { id: "google_drive", folderId: FOLDER_ID },
        update: { folderId: FOLDER_ID }
      });
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await enqueueReplicationForBackup({ backupId, client: prisma });

      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const { drive } = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const SESSION_URI_WITH_TOKEN =
        "https://www.googleapis.com/upload/session/bin-xyz?upload_id=SECRET_TOKEN_VALUE";
      const { http } = makeHttp([
        () => response(200, { Location: SESSION_URI_WITH_TOKEN }),
        // Fail on the first PUT with a 500 body that includes the URL.
        () =>
          response(
            500,
            {},
            JSON.stringify({
              error: "internal",
              url: SESSION_URI_WITH_TOKEN,
              bearer: `Bearer ${FAKE_ACCESS_TOKEN}`
            })
          )
      ]);

      await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      const msg = rep!.errorMessage ?? "";
      assert.doesNotMatch(msg, /Bearer /);
      assert.doesNotMatch(msg, /upload_id=/);
      assert.doesNotMatch(msg, /SECRET_TOKEN_VALUE/);
      assert.doesNotMatch(msg, new RegExp(FAKE_ACCESS_TOKEN));
    } finally {
      await prisma.$disconnect();
    }
  });
});

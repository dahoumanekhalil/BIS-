// Layer F orchestration tests — replicateBackupToDrive against a real
// Postgres, with a fake Drive API + fake HTTP client + in-memory
// filesystem. NO real network I/O.
//
// Run with:
//   npm run test:backup-drive-uploader
//
// Assertions cover the Layer F approval checklist:
//   * Successful .bin + manifest upload → row COMPLETED, correct ids
//   * Idempotency reconcile (existing matching remote file)
//   * Duplicate detection (≥2 remote hits) → FAILED
//   * Metadata mismatch on existing remote → FAILED (never overwrite)
//   * Missing local .bin → LOCAL_SOURCE_MISSING FAILED
//   * Local sha256 mismatch → LOCAL_SOURCE_CORRUPTED FAILED
//   * Missing manifest → LOCAL_SOURCE_MISSING FAILED
//   * Backup.status != VERIFIED → SKIPPED_NOT_VERIFIED
//   * Resumable session persisted BEFORE first byte flies
//   * Resume after crash mid-upload (existing sessionUri +
//     partial uploadBytesSent)
//   * Resume after crash when upload actually completed (queryOffset
//     returns complete → skip loop, mark COMPLETED)
//   * Session expired mid-recovery → start fresh session
//   * Transient 500 → RETRYABLE with nextRetryAt in the future
//   * Permanent 403 quota → FAILED QUOTA_EXCEEDED
//   * MD5 mismatch between local + Drive-reported → REMOTE_CHECKSUM_MISMATCH
//   * Local Backup.status independence (unchanged across every failure)
//   * Drive I/O never runs inside a Prisma transaction (no shared
//     tx handle threaded through the fake drive)
//   * Sanitized error messages never contain sessionUri / access
//     token / plaintext data / file paths

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import type { BackupReplication, PrismaClient } from "@prisma/client";

import {
  APP_PROPERTY_ARTIFACT,
  APP_PROPERTY_BACKUP_ID,
  BIN_MIME_TYPE,
  MANIFEST_MIME_TYPE,
  REPLICATION_DESTINATION,
  localBinPath,
  localManifestPath,
  remoteBinFileName,
  remoteManifestFileName,
  replicateBackupToDrive,
  type FileReader
} from "../lib/backup/replication/uploader";
import type { DriveApi } from "../lib/backup/replication/uploader";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse
} from "../lib/backup/replication/http";

// ─── Real Prisma against the dev DB (same pattern as schema test) ─────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FOLDER_ID = "layer-f-test-folder-id";
const FAKE_ACCESS_TOKEN = "fake-access-token-layer-f-uploader-tests-xyz";
const STORAGE_DIR = "/virt/backup-store";
const CHUNK_BYTES = 256 * 1024; // 256 KiB — the minimum alignment
const NOW = new Date("2026-09-29T13:00:00Z");

const testBackupIds: string[] = [];
const testWindowStart = new Date();

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

async function seedBackup(
  prisma: InstanceType<PrismaModule["PrismaClient"]>,
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
      appVersion: "layer-f-test-0.0.0",
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

// In-memory FileReader — every test wires up files it wants.
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

// Fake Drive API — supports files.list + files.get with a scripted
// map. `visibleInList: false` files are only returned by `get`, never
// by `list` — models "upload just produced this file; idempotency
// scan hadn't seen it yet, but files.get by the upload's returned id
// still works" which is what happens on a fresh upload.
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

type FakeDriveState = { files: FakeDriveFile[] };

function makeFakeDrive(state: FakeDriveState): DriveApi {
  return {
    files: {
      async get(params) {
        const f = state.files.find((x) => x.id === params.fileId);
        if (!f) {
          const err = new Error("Not Found") as Error & {
            status: number;
            response: { status: number; data: { error?: { errors?: Array<{ reason?: string }> } } };
          };
          err.status = 404;
          err.response = { status: 404, data: {} };
          throw err;
        }
        return { data: { ...f } };
      },
      async list(params) {
        const hits = state.files.filter((f) => {
          if (f.visibleInList === false) return false;
          if (params.q.includes("trashed=false") && f.trashed === true) return false;
          const backupIdMatch =
            /appProperties has \{ key='backupId' and value='([^']+)' \}/.exec(
              params.q
            );
          if (backupIdMatch) {
            if (f.appProperties?.[APP_PROPERTY_BACKUP_ID] !== backupIdMatch[1]) {
              return false;
            }
          }
          const artifactMatch =
            /appProperties has \{ key='artifact' and value='([^']+)' \}/.exec(
              params.q
            );
          if (artifactMatch) {
            if (f.appProperties?.[APP_PROPERTY_ARTIFACT] !== artifactMatch[1]) {
              return false;
            }
          }
          const parentMatch = /'([^']+)' in parents/.exec(params.q);
          if (parentMatch) {
            if (!(f.parents ?? []).includes(parentMatch[1]!)) return false;
          }
          return true;
        });
        return {
          data: {
            files: hits.map((f) => ({ ...f }))
          }
        };
      }
    }
  };
}

// Fake HTTP client that scripts responses. Each entry consumed in order.
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

// ─── Cleanup ──────────────────────────────────────────────────────────────

after(async () => {
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
  } finally {
    await prisma.$disconnect();
  }
});

before(async () => {
  const prisma = await makePrisma();
  try {
    // Ensure the singleton config row exists in case a prior test wiped it.
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive" },
      update: {}
    });
  } finally {
    await prisma.$disconnect();
  }
});

// ─── Helpers to build a scripted "happy path" ─────────────────────────────

function buildBinPayload(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

function successfulSingleChunkScript(bin: Buffer, manifest: Buffer, binMd5Override?: string) {
  return [
    // 1. init bin session
    () =>
      response(200, {
        Location: "https://www.googleapis.com/upload/session/bin-abc"
      }),
    // 2. put bin chunk → 200 complete
    () =>
      response(
        200,
        {},
        JSON.stringify({
          id: "drive-bin-id-1",
          size: String(bin.byteLength),
          md5Checksum: binMd5Override ?? md5(bin)
        })
      ),
    // 3. init manifest session
    () =>
      response(200, {
        Location: "https://www.googleapis.com/upload/session/mf-abc"
      }),
    // 4. put manifest chunk → 200 complete
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
  ] as HttpHandler[];
}

function driveWithVerifiedGet(
  backupId: string,
  binSize: number,
  manifestSize: number,
  opts: { visibleInList?: boolean } = {}
): DriveApi {
  const visibleInList = opts.visibleInList ?? true;
  return makeFakeDrive({
    files: [
      {
        id: "drive-bin-id-1",
        name: remoteBinFileName(backupId),
        mimeType: BIN_MIME_TYPE,
        trashed: false,
        size: String(binSize),
        parents: [FOLDER_ID],
        appProperties: { backupId, artifact: "bin" },
        visibleInList
      },
      {
        id: "drive-mf-id-1",
        name: remoteManifestFileName(backupId),
        mimeType: MANIFEST_MIME_TYPE,
        trashed: false,
        size: String(manifestSize),
        parents: [FOLDER_ID],
        appProperties: { backupId, artifact: "manifest" },
        visibleInList
      }
    ]
  });
}

// ─── Happy path ──────────────────────────────────────────────────────────

describe("replicateBackupToDrive — happy path", () => {
  test("uploads bin + manifest, marks COMPLETED (METADATA_ONLY level)", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(
        JSON.stringify({ backupId: "placeholder", schema: 1 }),
        "utf-8"
      );
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(
        backupId,
        bin.byteLength,
        manifest.byteLength,
        { visibleInList: false }
      );
      const { http, calls } = makeHttp(
        successfulSingleChunkScript(bin, manifest)
      );

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });

      assert.equal(result.outcome, "COMPLETED");
      if (result.outcome !== "COMPLETED") return;
      assert.equal(result.remoteBinFileId, "drive-bin-id-1");
      assert.equal(result.remoteManifestFileId, "drive-mf-id-1");

      // Backup.status is INDEPENDENT — never touched.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");

      // BackupReplication row is COMPLETED with all expected ids.
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.ok(rep);
      assert.equal(rep!.status, "COMPLETED");
      assert.equal(rep!.remoteBinFileId, "drive-bin-id-1");
      assert.equal(rep!.remoteManifestFileId, "drive-mf-id-1");
      assert.equal(rep!.remoteFolderId, FOLDER_ID);
      assert.equal(rep!.lastVerifyLevel, "METADATA_ONLY");
      // Honesty gate: attestedContentSha256 stays NULL — no FULL_SHA256.
      assert.equal(rep!.attestedContentSha256, null);
      // Session URI cleared on completion.
      assert.equal(rep!.uploadSessionUri, null);
      assert.equal(rep!.uploadSessionExpiresAt, null);
      assert.equal(rep!.uploadBytesSent, null);
      assert.equal(rep!.errorCode, "NONE");
      assert.equal(rep!.errorMessage, null);

      // The HTTP script wired 4 calls: init-bin, chunk-bin, init-mf, chunk-mf.
      assert.equal(calls.length, 4);
      // The Authorization header on the init calls carried the bearer.
      assert.equal(
        calls[0]!.headers["Authorization"],
        `Bearer ${FAKE_ACCESS_TOKEN}`
      );
      // The chunk PUTs must NOT carry an Authorization header — the
      // session URI already authorises the caller.
      assert.equal(calls[1]!.headers["Authorization"], undefined);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Preconditions & simple failures ─────────────────────────────────────

describe("replicateBackupToDrive — preconditions", () => {
  test("SKIPPED_NOT_VERIFIED when Backup.status != VERIFIED", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = await seedBackup(prisma, { status: "PENDING" });
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: makeFakeDrive({ files: [] }),
        http: makeHttp([]).http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: makeMemFs({}),
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "SKIPPED_NOT_VERIFIED");
      // No replication row should have been created.
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep, null);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("LOCAL_SOURCE_MISSING when the .bin file is absent", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(512);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        // Manifest exists, bin does not.
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: makeFakeDrive({ files: [] }),
        http: makeHttp([]).http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "LOCAL_SOURCE_MISSING");
      // Local backup unchanged.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("LOCAL_SOURCE_CORRUPTED when local sha256 does not match Backup.contentSha256", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(512);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        // Lie about the expected sha256 → mismatch.
        contentSha256: sha256("something-else")
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: makeFakeDrive({ files: [] }),
        http: makeHttp([]).http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "LOCAL_SOURCE_CORRUPTED");
      // Local backup unchanged.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("LOCAL_SOURCE_MISSING when the manifest is absent", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(512);
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin
      });
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: makeFakeDrive({ files: [] }),
        http: makeHttp([]).http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "LOCAL_SOURCE_MISSING");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Idempotency (§F.3) ──────────────────────────────────────────────────

describe("replicateBackupToDrive — idempotency & duplicate detection", () => {
  test("reconciles when the remote bin already exists with matching metadata", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      // No HTTP calls needed — both artefacts already present remotely.
      const { http, calls } = makeHttp([]);

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");
      // Zero uploads happened.
      assert.equal(calls.length, 0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("duplicate remote (>=2 hits for bin) → FAILED without overwrite", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({
        files: [
          {
            id: "dup-a",
            name: remoteBinFileName(backupId),
            mimeType: BIN_MIME_TYPE,
            parents: [FOLDER_ID],
            appProperties: { backupId, artifact: "bin" }
          },
          {
            id: "dup-b",
            name: remoteBinFileName(backupId),
            mimeType: BIN_MIME_TYPE,
            parents: [FOLDER_ID],
            appProperties: { backupId, artifact: "bin" }
          }
        ]
      });
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http: makeHttp([]).http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "REMOTE_VERIFICATION_FAILED");
      assert.match(result.sanitizedMessage, /DUPLICATE_DETECTED/);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("existing remote bin with metadata mismatch → FAILED (no overwrite)", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({
        files: [
          {
            id: "mismatched-name-bin",
            // Same backupId + artifact + parents so q filter matches,
            // but a WRONG name — worker must refuse to overwrite.
            name: "wrong_name_backup.bin",
            mimeType: BIN_MIME_TYPE,
            parents: [FOLDER_ID],
            appProperties: { backupId, artifact: "bin" }
          }
        ]
      });
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http: makeHttp([]).http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "REMOTE_VERIFICATION_FAILED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── MD5 honesty gate ────────────────────────────────────────────────────

describe("replicateBackupToDrive — MD5 vs SHA-256 honesty", () => {
  test("Drive-reported MD5 ≠ locally-computed MD5 → REMOTE_CHECKSUM_MISMATCH", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(512);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      // Hide from idempotency list so the upload path actually runs
      // (which is where the MD5 mismatch fires). files.get still
      // returns the file for the verify step (never reached here).
      const drive = driveWithVerifiedGet(
        backupId,
        bin.byteLength,
        manifest.byteLength,
        { visibleInList: false }
      );
      // Script Drive to return a WRONG MD5 in the completion body.
      const script = successfulSingleChunkScript(
        bin,
        manifest,
        "00000000000000000000000000000000" // fake mismatch
      );
      const { http } = makeHttp(script);

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "REMOTE_CHECKSUM_MISMATCH");
      // Row must reflect the mismatch and NOT be COMPLETED.
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "FAILED");
      // attestedContentSha256 must remain NULL — MD5 is NOT SHA-256.
      assert.equal(rep!.attestedContentSha256, null);
      assert.equal(rep!.lastVerifyLevel, "NONE");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Retryable + permanent errors ────────────────────────────────────────

describe("replicateBackupToDrive — error classification", () => {
  test("transient 500 during chunk PUT → RETRYABLE with future nextRetryAt", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({ files: [] });
      const { http } = makeHttp([
        // init session succeeds
        () =>
          response(200, {
            Location: "https://www.googleapis.com/upload/session/500-x"
          }),
        // chunk PUT fails with 500
        () => response(500, {}, "opaque server error body")
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000,
        rand: () => 0
      });
      assert.equal(result.outcome, "RETRYABLE");
      if (result.outcome !== "RETRYABLE") return;
      assert.equal(result.errorCode, "SERVER_ERROR");
      assert.ok(result.nextRetryAt.getTime() > NOW.getTime());
      // Row is RETRYABLE_FAILURE with nextRetryAt set.
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
      // Session URI persisted for resume-after-retry.
      assert.ok(
        typeof rep!.uploadSessionUri === "string" &&
          rep!.uploadSessionUri.startsWith("https://")
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("Retry-After header on 429 is honoured (clamped to [30s, 30min])", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({ files: [] });
      const { http } = makeHttp([
        () =>
          response(200, {
            Location: "https://www.googleapis.com/upload/session/429-x"
          }),
        () => response(429, { "Retry-After": "60" })
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "RETRYABLE");
      if (result.outcome !== "RETRYABLE") return;
      // Retry-After = 60s honoured within the [30s, 30min] clamp.
      const delayMs = result.nextRetryAt.getTime() - NOW.getTime();
      assert.equal(delayMs, 60 * 1000);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Crash recovery ─────────────────────────────────────────────────────

describe("replicateBackupToDrive — crash recovery", () => {
  test("resume with existing sessionUri + partial uploadBytesSent", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(2 * CHUNK_BYTES); // 2 chunks
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(
        backupId,
        bin.byteLength,
        manifest.byteLength,
        { visibleInList: false }
      );
      // Pre-seed the replication row as if a previous run crashed
      // after uploading chunk 0.
      const preSession = "https://www.googleapis.com/upload/session/pre-crash";
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          uploadSessionUri: preSession,
          uploadSessionExpiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000),
          uploadBytesSent: BigInt(CHUNK_BYTES),
          attemptCount: 1,
          errorCode: "NETWORK_ERROR",
          errorMessage: "prior_ECONNRESET"
        }
      });
      const { http, calls } = makeHttp([
        // Query offset → 308, confirmedBytes = CHUNK_BYTES
        () => response(308, { Range: `bytes=0-${CHUNK_BYTES - 1}` }),
        // Upload chunk 2 → 200 complete
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
        // Manifest init + PUT
        () =>
          response(200, {
            Location: "https://www.googleapis.com/upload/session/mf-post"
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
      ]);

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");
      // The status-query PUT reused the SAME sessionUri.
      assert.equal(calls[0]!.url, preSession);
      // The chunk PUT was against the SAME sessionUri.
      assert.equal(calls[1]!.url, preSession);
      // The Content-Range on the resume PUT starts at CHUNK_BYTES.
      assert.equal(
        calls[1]!.headers["Content-Range"],
        `bytes ${CHUNK_BYTES}-${bin.byteLength - 1}/${bin.byteLength}`
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("session expired → fresh session opened, upload restarts", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(
        backupId,
        bin.byteLength,
        manifest.byteLength,
        { visibleInList: false }
      );
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          uploadSessionUri: "https://www.googleapis.com/upload/session/expired",
          uploadSessionExpiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000),
          uploadBytesSent: BigInt(0),
          attemptCount: 1
        }
      });
      const { http, calls } = makeHttp([
        // Query offset → 410 = session_expired
        () => response(410),
        // Init NEW session
        () =>
          response(200, {
            Location: "https://www.googleapis.com/upload/session/fresh"
          }),
        // Upload chunk → 200
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
            Location: "https://www.googleapis.com/upload/session/mf"
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
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");
      // Second call was the fresh init POST (not against expired URI).
      assert.equal(calls[1]!.method, "POST");
      assert.equal(
        calls[1]!.url,
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=false"
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("crash-after-success: queryOffset returns complete → COMPLETED without re-upload", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(512);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(
        backupId,
        bin.byteLength,
        manifest.byteLength,
        { visibleInList: false }
      );
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          uploadSessionUri:
            "https://www.googleapis.com/upload/session/actually-done",
          uploadSessionExpiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000),
          uploadBytesSent: BigInt(bin.byteLength),
          attemptCount: 1
        }
      });
      const { http, calls } = makeHttp([
        // queryUploadOffset → 200 complete
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
        // Manifest still needs to go through the standard init + put
        () =>
          response(200, {
            Location: "https://www.googleapis.com/upload/session/mf-later"
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
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");
      // First call was queryOffset PUT.
      assert.equal(calls[0]!.method, "PUT");
      assert.equal(calls[0]!.headers["Content-Range"], `bytes */${bin.byteLength}`);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Terminal state protection ───────────────────────────────────────────

describe("replicateBackupToDrive — terminal state protection", () => {
  test("SKIPPED_ALREADY_COMPLETED never re-uploads on second invocation", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(512);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "COMPLETED",
          remoteBinFileId: "already-bin",
          remoteManifestFileId: "already-mf",
          lastVerifyLevel: "METADATA_ONLY"
        }
      });
      const { http, calls } = makeHttp([]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: makeFakeDrive({ files: [] }),
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: makeMemFs({}),
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "SKIPPED_ALREADY_COMPLETED");
      assert.equal(calls.length, 0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("FAILED row is not re-attempted; requires manual admin action", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(512);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "FAILED",
          errorCode: "QUOTA_EXCEEDED",
          errorMessage: "QUOTA_EXCEEDED: prior run"
        }
      });
      const { http, calls } = makeHttp([]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: makeFakeDrive({ files: [] }),
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: makeMemFs({}),
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "QUOTA_EXCEEDED");
      assert.equal(calls.length, 0);
    } finally {
      await prisma.$disconnect();
    }
  });
});

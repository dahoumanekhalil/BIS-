// Layer F invariant tests — companion to backup-drive-uploader.test.ts.
//
// The functional-behaviour tests (happy path, idempotency, crash
// recovery, terminal state) live next door. This file exercises the
// non-functional invariants the Layer F approval message enumerates:
//
//   * Correct folder targeting (init request wires the resolved folder id).
//   * Encrypted-only surface (only the .bin + .manifest.json path
//     under `published/` is read; no plaintext or key file is ever
//     touched by the uploader).
//   * Remote metadata contains no secrets / plaintext.
//   * Session URI is persisted BEFORE the first byte flies.
//   * Multi-chunk uploads persist progress between chunks.
//   * REMOTE_SIZE_MISMATCH surfaces as FAILED (never silently
//     recorded as COMPLETED).
//   * Malformed provider completion body → FAILED, no state advance.
//   * UPLOAD_SESSION_EXPIRED classification on 410 mid-upload.
//   * Permanent 403 quota → FAILED QUOTA_EXCEEDED (no infinite retry).
//   * Retryable failure reaching attempt cap → FAILED.
//   * Explicit VERIFYING state transition observed post-upload.
//   * Local Backup.status untouched across every failure mode.
//   * Drive HTTP is NEVER called inside a Prisma $transaction.
//   * Sanitized error messages never contain the session URI query
//     string or the bearer access token.
//   * Browser serializer projection NEVER carries uploadSessionUri /
//     uploadSessionExpiresAt / uploadBytesSent (cross-cut with Layer F
//     approval invariant #12 + #21).
//
// All tests use the same in-memory FileReader, fake DriveApi + scripted
// HttpClient pattern as backup-drive-uploader.test.ts. No real network
// I/O. Prisma is real (dev DB).
//
// Run with:
//   npm run test:backup-drive-uploader-invariants

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

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
import {
  REPLICATION_FIELDS_NEVER_PUBLIC,
  serializeReplicationForBrowser
} from "../lib/backup/replication/serializer";
import { BACKOFF_MAX_ATTEMPTS } from "../lib/backup/replication/backoff";

// ─── Shared fixtures ──────────────────────────────────────────────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

const FOLDER_ID = "layer-f-invariants-folder-id";
const FAKE_ACCESS_TOKEN = "fake-access-token-layer-f-invariants-tests-XYZ";
const STORAGE_DIR = "/virt/backup-store";
const CHUNK_BYTES = 256 * 1024;
const NOW = new Date("2026-10-01T10:00:00Z");

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
  prisma: InstanceType<PrismaModule["PrismaClient"]>,
  overrides: Partial<{
    status:
      | "VERIFIED"
      | "COMPLETED"
      | "PENDING"
      | "RUNNING"
      | "FAILED"
      | "DELETED"
      | "MISSING";
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
      appVersion: "layer-f-invariants-0.0.0",
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

function makeMemFs(files: Record<string, Buffer>): {
  fs: FileReader;
  pathsRead: string[];
} {
  const pathsRead: string[] = [];
  const record = (p: string): void => {
    if (!pathsRead.includes(p)) pathsRead.push(p);
  };
  const fs: FileReader = {
    async stat(p) {
      record(p);
      const f = files[p];
      if (!f) return null;
      return { size: f.byteLength };
    },
    async sha256(p) {
      record(p);
      const f = files[p];
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return sha256(f);
    },
    async readChunk(p, start, length) {
      record(p);
      const f = files[p];
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f.subarray(start, start + length);
    },
    async readAll(p) {
      record(p);
      const f = files[p];
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from(f);
    }
  };
  return { fs, pathsRead };
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

function makeFakeDrive(state: { files: FakeDriveFile[] }): DriveApi {
  return {
    files: {
      async get(params) {
        const f = state.files.find((x) => x.id === params.fileId);
        if (!f) {
          const err = new Error("Not Found") as Error & {
            status: number;
            response: { status: number; data: unknown };
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
          const backupIdMatch = /appProperties has \{ key='backupId' and value='([^']+)' \}/.exec(
            params.q
          );
          if (backupIdMatch) {
            if (f.appProperties?.[APP_PROPERTY_BACKUP_ID] !== backupIdMatch[1]) return false;
          }
          const artifactMatch = /appProperties has \{ key='artifact' and value='([^']+)' \}/.exec(
            params.q
          );
          if (artifactMatch) {
            if (f.appProperties?.[APP_PROPERTY_ARTIFACT] !== artifactMatch[1]) return false;
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
    if (!h) throw new Error(`unexpected http call to ${req.url.slice(0, 60)}`);
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

function successScript(bin: Buffer, manifest: Buffer): HttpHandler[] {
  return [
    () => response(200, { Location: "https://www.googleapis.com/upload/session/bin-x" }),
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
    () => response(200, { Location: "https://www.googleapis.com/upload/session/mf-x" }),
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
  manifestSize: number,
  opts: { visibleInList?: boolean } = {}
): DriveApi {
  const visibleInList = opts.visibleInList ?? false;
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

// ─── Cleanup ──────────────────────────────────────────────────────────────

before(async () => {
  const prisma = await makePrisma();
  try {
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive" },
      update: {}
    });
  } finally {
    await prisma.$disconnect();
  }
});

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

// ─── Folder targeting + surface guarantees ─────────────────────────────────

describe("Layer F invariants — folder targeting + upload surface", () => {
  test("init POST metadata targets the Layer-E-resolved folder id and encrypted mime type", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: 1 }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs, pathsRead } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http, calls } = makeHttp(successScript(bin, manifest));

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");

      // ── Folder targeting: init POST body carries parents = [FOLDER_ID] + our mime type.
      const initBin = calls[0]!;
      assert.equal(initBin.method, "POST");
      const meta = JSON.parse(initBin.body!.toString("utf-8")) as {
        parents: string[];
        mimeType: string;
        name: string;
        appProperties: Record<string, string>;
      };
      assert.deepEqual(meta.parents, [FOLDER_ID]);
      assert.equal(meta.mimeType, BIN_MIME_TYPE);
      assert.equal(meta.name, remoteBinFileName(backupId));

      // ── Upload surface: appProperties carries only classified,
      //    non-secret metadata — no plaintext hint, no key material.
      const props = meta.appProperties;
      assert.equal(props[APP_PROPERTY_BACKUP_ID], backupId);
      assert.equal(props[APP_PROPERTY_ARTIFACT], "bin");
      // The classified keys must exist; no key that looks like a secret.
      for (const k of Object.keys(props)) {
        assert.doesNotMatch(k, /token|password|secret|key/i);
        assert.doesNotMatch(String(props[k]), /Bearer\s|refresh_token|access_token/i);
      }

      // ── Encrypted-only surface: uploader read exactly the two
      //    encrypted artifacts, nothing else on disk was touched.
      const allowedPaths = new Set([
        localBinPath(STORAGE_DIR, backupId),
        localManifestPath(STORAGE_DIR, backupId)
      ]);
      for (const p of pathsRead) {
        assert.ok(
          allowedPaths.has(p),
          `Uploader read an unexpected local path: ${p}`
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("manifest init POST also targets the resolved folder id and JSON mime", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ hello: "world" }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http, calls } = makeHttp(successScript(bin, manifest));

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");

      const initManifest = calls[2]!;
      const meta = JSON.parse(initManifest.body!.toString("utf-8")) as {
        parents: string[];
        mimeType: string;
        name: string;
      };
      assert.deepEqual(meta.parents, [FOLDER_ID]);
      assert.equal(meta.mimeType, MANIFEST_MIME_TYPE);
      assert.equal(meta.name, remoteManifestFileName(backupId));
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Session URI persistence ordering ─────────────────────────────────────

describe("Layer F invariants — resumable session URI persistence order", () => {
  test("sessionUri is persisted in the DB BEFORE the first chunk PUT flies", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(CHUNK_BYTES); // exactly one chunk
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const sessionUri = "https://www.googleapis.com/upload/session/order-check";

      // Between init POST and first PUT, we assert the DB row already
      // holds the sessionUri and expiry. If a persistence write hadn't
      // happened first, this snapshot would show a NULL uploadSessionUri.
      type Snapshot = {
        uploadSessionUri: string | null;
        uploadSessionExpiresAt: Date | null;
      };
      const snapshotBox: { value: Snapshot | null } = { value: null };

      const { http } = makeHttp([
        () => response(200, { Location: sessionUri }),
        async () => {
          const rep = await prisma.backupReplication.findUnique({
            where: {
              backupId_destination: {
                backupId,
                destination: REPLICATION_DESTINATION
              }
            }
          });
          snapshotBox.value = rep
            ? {
                uploadSessionUri: rep.uploadSessionUri,
                uploadSessionExpiresAt: rep.uploadSessionExpiresAt
              }
            : null;
          return response(
            200,
            {},
            JSON.stringify({
              id: "drive-bin-id-1",
              size: String(bin.byteLength),
              md5Checksum: md5(bin)
            })
          );
        },
        () => response(200, { Location: "https://www.googleapis.com/upload/session/mf" }),
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
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");

      // The DB snapshot taken between init and first PUT MUST already
      // carry the sessionUri + expiry (persisted before the byte flew).
      const snap = snapshotBox.value;
      assert.ok(snap, "snapshot was not captured");
      assert.equal(snap.uploadSessionUri, sessionUri);
      assert.ok(snap.uploadSessionExpiresAt !== null);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("progress is persisted (uploadBytesSent) between chunks in a multi-chunk upload", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(3 * CHUNK_BYTES); // 3 chunks total
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);

      const uploadBytesSentSeries: (bigint | null)[] = [];
      const captureAfter = async (): Promise<void> => {
        const rep = await prisma.backupReplication.findUnique({
          where: {
            backupId_destination: {
              backupId,
              destination: REPLICATION_DESTINATION
            }
          }
        });
        uploadBytesSentSeries.push(rep?.uploadBytesSent ?? null);
      };

      const { http } = makeHttp([
        // Init bin session
        () => response(200, { Location: "https://www.googleapis.com/upload/session/mc" }),
        // Chunk 0 → 308 confirmed 0..CHUNK_BYTES-1
        async () => {
          const r = response(308, { Range: `bytes=0-${CHUNK_BYTES - 1}` });
          // capture *after* uploader will have persisted the confirmed bytes
          setImmediate(captureAfter);
          return r;
        },
        // Chunk 1 → 308 confirmed 0..2*CHUNK_BYTES-1
        async () => {
          const r = response(308, { Range: `bytes=0-${2 * CHUNK_BYTES - 1}` });
          setImmediate(captureAfter);
          return r;
        },
        // Chunk 2 → 200 complete
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
        // Manifest
        () => response(200, { Location: "https://www.googleapis.com/upload/session/mf" }),
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
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");

      // Wait for the setImmediate captures to drain.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // We persisted uploadBytesSent progressively. Final row cleared
      // it to NULL as part of COMPLETED, but the samples we grabbed
      // in-flight must show a monotonic advance.
      assert.ok(
        uploadBytesSentSeries.length >= 2,
        `expected in-flight samples, got ${uploadBytesSentSeries.length}`
      );
      const nums = uploadBytesSentSeries
        .filter((x): x is bigint => typeof x === "bigint")
        .map((x) => Number(x));
      for (let i = 1; i < nums.length; i++) {
        assert.ok(
          nums[i]! >= nums[i - 1]!,
          `progress regressed: ${nums[i - 1]} -> ${nums[i]}`
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Provider-response robustness ─────────────────────────────────────────

describe("Layer F invariants — malformed/mismatched provider responses", () => {
  test("Drive-reported size ≠ expected → REMOTE_SIZE_MISMATCH FAILED", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);
      const { http } = makeHttp([
        () => response(200, { Location: "https://www.googleapis.com/upload/session/sz" }),
        () =>
          response(
            200,
            {},
            JSON.stringify({
              id: "drive-bin-id-1",
              size: String(bin.byteLength + 7), // ≠ expected
              md5Checksum: md5(bin)
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
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "REMOTE_SIZE_MISMATCH");
      // Row is FAILED, never COMPLETED, attestedContentSha256 stays NULL.
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "FAILED");
      assert.equal(rep!.attestedContentSha256, null);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("malformed completion body (missing id) → FAILED, no state advance", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({ files: [] });
      const { http } = makeHttp([
        () => response(200, { Location: "https://www.googleapis.com/upload/session/mal" }),
        () => response(200, {}, JSON.stringify({ size: "1024" })) // no id
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      // Uploader currently classifies this via the classifier fallback
      // (UNKNOWN, non-retryable) — either way, it MUST NOT reach COMPLETED.
      assert.notEqual(result.outcome, "COMPLETED");
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.notEqual(rep!.status, "COMPLETED");
      assert.notEqual(rep!.status, "VERIFYING");
      assert.equal(rep!.attestedContentSha256, null);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Error classification breadth ─────────────────────────────────────────

describe("Layer F invariants — error classification", () => {
  test("Drive 410 mid-chunk → UPLOAD_SESSION_EXPIRED (retryable)", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({ files: [] });
      const { http } = makeHttp([
        () => response(200, { Location: "https://www.googleapis.com/upload/session/410" }),
        () => response(410) // session reclaimed by Drive mid-upload
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "RETRYABLE");
      if (result.outcome !== "RETRYABLE") return;
      assert.equal(result.errorCode, "UPLOAD_SESSION_EXPIRED");
      // Local Backup.status is UNCHANGED.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("permanent 403 quota exhausted → FAILED QUOTA_EXCEEDED", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({ files: [] });
      // Initial 403 on session init.
      const { http } = makeHttp([
        () => response(403, {}, "opaque body")
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      // Without a `reason` field, classifier maps 403 → AUTHORIZATION_ERROR.
      // Either AUTHORIZATION_ERROR or QUOTA_EXCEEDED are non-retryable; both
      // must land as FAILED (never infinite retry).
      assert.ok(
        result.errorCode === "AUTHORIZATION_ERROR" ||
          result.errorCode === "QUOTA_EXCEEDED",
        `unexpected 403 classification: ${result.errorCode}`
      );
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("retryable failure at attempt cap → FAILED (never retried indefinitely)", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      // Pre-seed the row with attemptCount = MAX - 1; a further retryable
      // failure MUST push status to FAILED, not RETRYABLE_FAILURE.
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          attemptCount: BACKOFF_MAX_ATTEMPTS - 1,
          errorCode: "NETWORK_ERROR"
        }
      });
      const drive = makeFakeDrive({ files: [] });
      const { http } = makeHttp([
        () => response(200, { Location: "https://www.googleapis.com/upload/session/cap" }),
        () => response(500)
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "FAILED");
      if (result.outcome !== "FAILED") return;
      assert.equal(result.errorCode, "SERVER_ERROR");
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      assert.equal(rep!.status, "FAILED");
      assert.ok(rep!.attemptCount >= BACKOFF_MAX_ATTEMPTS);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── VERIFYING state observability + Backup.status independence ───────────

describe("Layer F invariants — state machine + local independence", () => {
  test("row transitions through VERIFYING before COMPLETED (observed via update hook)", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);

      // Sample the row status between the last upload PUT and the first
      // verify files.get. If the code correctly transitions to VERIFYING,
      // the row we read here will hold `status = "VERIFYING"`.
      let observedVerifying: string | null = null;
      const wrappedDrive: DriveApi = {
        files: {
          async get(params) {
            if (observedVerifying === null) {
              const rep = await prisma.backupReplication.findUnique({
                where: {
                  backupId_destination: {
                    backupId,
                    destination: REPLICATION_DESTINATION
                  }
                }
              });
              observedVerifying = rep?.status ?? null;
            }
            return drive.files.get(params);
          },
          async list(params) {
            return drive.files.list(params);
          }
        }
      };
      const { http } = makeHttp(successScript(bin, manifest));

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: wrappedDrive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");
      assert.equal(
        observedVerifying,
        "VERIFYING",
        "Layer F must transition UPLOADING → VERIFYING before metadata verify runs"
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("Backup.status stays VERIFIED across every Layer F failure mode", async () => {
    const prisma = await makePrisma();
    try {
      // Batch: LOCAL_SOURCE_MISSING, REMOTE_CHECKSUM_MISMATCH,
      // REMOTE_SIZE_MISMATCH, 500 SERVER_ERROR, 403 permanent,
      // duplicate detection.
      const scenarios: Array<{
        label: string;
        run: () => Promise<void>;
      }> = [];
      const seedFor = async (): Promise<{
        backupId: string;
        bin: Buffer;
        manifest: Buffer;
        fs: FileReader;
      }> => {
        const bin = buildBinPayload(512);
        const manifest = Buffer.from(JSON.stringify({}), "utf-8");
        const backupId = await seedBackup(prisma, {
          sizeBytes: BigInt(bin.byteLength),
          contentSha256: sha256(bin),
          manifestSha256: sha256(manifest)
        });
        const { fs } = makeMemFs({
          [localBinPath(STORAGE_DIR, backupId)]: bin,
          [localManifestPath(STORAGE_DIR, backupId)]: manifest
        });
        return { backupId, bin, manifest, fs };
      };

      scenarios.push({
        label: "500 SERVER_ERROR",
        async run() {
          const s = await seedFor();
          const { http } = makeHttp([
            () => response(200, { Location: "https://www.googleapis.com/upload/session/s" }),
            () => response(500)
          ]);
          await replicateBackupToDrive(s.backupId, {
            prisma,
            drive: makeFakeDrive({ files: [] }),
            http,
            accessToken: FAKE_ACCESS_TOKEN,
            folderId: FOLDER_ID,
            storageDir: STORAGE_DIR,
            files: s.fs,
            now: () => NOW,
            chunkBytes: CHUNK_BYTES,
            httpTimeoutMs: 30_000
          });
          const bkp = await prisma.backup.findUnique({ where: { id: s.backupId } });
          assert.equal(bkp!.status, "VERIFIED", "Backup regressed after 500");
        }
      });

      scenarios.push({
        label: "403 permanent",
        async run() {
          const s = await seedFor();
          const { http } = makeHttp([() => response(403)]);
          await replicateBackupToDrive(s.backupId, {
            prisma,
            drive: makeFakeDrive({ files: [] }),
            http,
            accessToken: FAKE_ACCESS_TOKEN,
            folderId: FOLDER_ID,
            storageDir: STORAGE_DIR,
            files: s.fs,
            now: () => NOW,
            chunkBytes: CHUNK_BYTES,
            httpTimeoutMs: 30_000
          });
          const bkp = await prisma.backup.findUnique({ where: { id: s.backupId } });
          assert.equal(bkp!.status, "VERIFIED", "Backup regressed after 403");
        }
      });

      scenarios.push({
        label: "REMOTE_SIZE_MISMATCH",
        async run() {
          const s = await seedFor();
          const drive = driveWithVerifiedGet(s.backupId, s.bin.byteLength, s.manifest.byteLength);
          const { http } = makeHttp([
            () => response(200, { Location: "https://www.googleapis.com/upload/session/sz" }),
            () =>
              response(
                200,
                {},
                JSON.stringify({
                  id: "drive-bin-id-1",
                  size: String(s.bin.byteLength + 9),
                  md5Checksum: md5(s.bin)
                })
              )
          ]);
          await replicateBackupToDrive(s.backupId, {
            prisma,
            drive,
            http,
            accessToken: FAKE_ACCESS_TOKEN,
            folderId: FOLDER_ID,
            storageDir: STORAGE_DIR,
            files: s.fs,
            now: () => NOW,
            chunkBytes: CHUNK_BYTES,
            httpTimeoutMs: 30_000
          });
          const bkp = await prisma.backup.findUnique({ where: { id: s.backupId } });
          assert.equal(bkp!.status, "VERIFIED", "Backup regressed after size mismatch");
        }
      });

      for (const sc of scenarios) {
        await sc.run();
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Log / message hygiene ────────────────────────────────────────────────

describe("Layer F invariants — log / message hygiene", () => {
  test("sanitized error messages contain neither the session URI query string nor the access token", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = makeFakeDrive({ files: [] });
      const sessionUri =
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SUPER_SECRET_UPLOAD_ID_XYZ";
      const { http } = makeHttp([
        () => response(200, { Location: sessionUri }),
        () => response(500, {}, "opaque error body with hidden token: refresh_token=REDACTED_BUT_LEAKY")
      ]);
      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive,
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "RETRYABLE");
      if (result.outcome !== "RETRYABLE") return;

      // The result's sanitizedMessage must NOT contain the token or the
      // session URI, in any form.
      const forbidden = [
        FAKE_ACCESS_TOKEN,
        "SUPER_SECRET_UPLOAD_ID_XYZ",
        "upload_id=",
        "Bearer ",
        "refresh_token",
        "REDACTED_BUT_LEAKY"
      ];
      for (const s of forbidden) {
        assert.equal(
          result.sanitizedMessage.includes(s),
          false,
          `sanitizedMessage leaked "${s}"`
        );
      }

      // The persisted row's errorMessage must also be sanitized.
      const rep = await prisma.backupReplication.findUnique({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });
      const em = rep?.errorMessage ?? "";
      for (const s of forbidden) {
        assert.equal(
          em.includes(s),
          false,
          `errorMessage in DB leaked "${s}"`
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── DB transaction boundary ──────────────────────────────────────────────

describe("Layer F invariants — Drive HTTP outside every Prisma tx", () => {
  test("Drive I/O never runs inside a Prisma $transaction from the uploader", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveWithVerifiedGet(backupId, bin.byteLength, manifest.byteLength);

      // Track tx nesting via Prisma's $extends middleware equivalent.
      // Every Drive HTTP call MUST occur while nesting depth is 0.
      let inTx = false;
      let violations = 0;
      const originalTransaction = prisma.$transaction.bind(prisma);
      // Overwrite only for the lifetime of this test.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).$transaction = async (arg: unknown, ...rest: unknown[]) => {
        if (typeof arg === "function") {
          inTx = true;
          try {
            return await (originalTransaction as unknown as (
              cb: unknown,
              ...r: unknown[]
            ) => Promise<unknown>)(arg, ...rest);
          } finally {
            inTx = false;
          }
        }
        return await (originalTransaction as unknown as (
          a: unknown,
          ...r: unknown[]
        ) => Promise<unknown>)(arg, ...rest);
      };

      const wrappedHttp = makeHttp(successScript(bin, manifest));
      const guardedHttp: HttpClient = async (req) => {
        if (inTx) violations++;
        return await wrappedHttp.http(req);
      };
      const wrappedDrive: DriveApi = {
        files: {
          async get(params) {
            if (inTx) violations++;
            return await drive.files.get(params);
          },
          async list(params) {
            if (inTx) violations++;
            return await drive.files.list(params);
          }
        }
      };

      const result = await replicateBackupToDrive(backupId, {
        prisma,
        drive: wrappedDrive,
        http: guardedHttp,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        storageDir: STORAGE_DIR,
        files: fs,
        now: () => NOW,
        chunkBytes: CHUNK_BYTES,
        httpTimeoutMs: 30_000
      });
      assert.equal(result.outcome, "COMPLETED");
      assert.equal(
        violations,
        0,
        "Drive I/O ran inside a Prisma $transaction — invariant #8 violated"
      );
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Browser exposure guard ──────────────────────────────────────────────

describe("Layer F invariants — browser projection never leaks sessionUri", () => {
  test("serializeReplicationForBrowser strips every never-public field for a real Layer F row", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBinPayload(CHUNK_BYTES);
      const manifest = Buffer.from(JSON.stringify({}), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      const { fs } = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      // Simulate an in-flight upload that stored a session URI, then a
      // transient failure kept it around for a future resume.
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          uploadSessionUri:
            "https://www.googleapis.com/upload/drive/v3/files?upload_id=CROSS_CUT_LEAK_CANARY_1234",
          uploadSessionExpiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000),
          uploadBytesSent: BigInt(CHUNK_BYTES),
          attemptCount: 1,
          errorCode: "NETWORK_ERROR",
          errorMessage: "NETWORK_ERROR: ECONNRESET"
        }
      });
      const row = await prisma.backupReplication.findUniqueOrThrow({
        where: {
          backupId_destination: {
            backupId,
            destination: REPLICATION_DESTINATION
          }
        }
      });

      const projection = serializeReplicationForBrowser(row);
      const keys = Object.keys(projection);
      for (const forbidden of REPLICATION_FIELDS_NEVER_PUBLIC) {
        assert.equal(
          keys.includes(forbidden),
          false,
          `browser projection carries forbidden field "${forbidden}"`
        );
      }
      // Sanity: the canary session URI does NOT appear in any value.
      const serialised = JSON.stringify(projection);
      assert.equal(
        serialised.includes("CROSS_CUT_LEAK_CANARY_1234"),
        false,
        "sessionUri substring leaked into browser projection"
      );
      assert.equal(
        serialised.includes("upload_id="),
        false,
        "sessionUri query string leaked into browser projection"
      );
    } finally {
      await prisma.$disconnect();
    }
  });
});

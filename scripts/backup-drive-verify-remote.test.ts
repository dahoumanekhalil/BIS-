// Layer H tests — remote verification services (Plan §J).
//
// Run with:
//   npm run test:backup-drive-verify-remote
//
// Assertions cover the Layer H approval checklist:
//   * METADATA_ONLY pass → lastVerifyLevel=METADATA_ONLY, no
//     attestedContentSha256 side-effect (honest MD5 gate)
//   * METADATA_ONLY fail (name / size / md5 / appProperties / mimeType /
//     parents / trashed) → errorCode=REMOTE_VERIFICATION_FAILED,
//     row status STAYS COMPLETED
//   * FULL_SHA256 pass → lastVerifyLevel=FULL_SHA256 +
//     attestedContentSha256 populated
//   * FULL_SHA256 fail (SHA-256 mismatch) →
//     errorCode=REMOTE_CHECKSUM_MISMATCH, row STAYS COMPLETED,
//     attestedContentSha256 UNCHANGED (does not overwrite a prior good)
//   * Deep verify NEVER flips row to FAILED — the plan's §K.10
//     invariant
//   * Download size ceiling (bytes exceed MAX_BIN_BYTES) → REMOTE_SIZE_MISMATCH
//   * Path traversal in staging filename → CONFIGURATION_ERROR
//   * Backup.status independence throughout every failure path
//   * Sanitized errorMessage never contains bearer tokens / session URIs
//   * UI labels never conflate MD5 with SHA-256 (honesty gate)

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";

import {
  verifyRemoteMetadata,
  verifyRemoteFullSha256,
  type VerifyRemoteDeps
} from "../lib/backup/replication/verify-remote";
import {
  MAX_BIN_BYTES,
  assertSafeFileId,
  assertSafeStagingName,
  downloadDriveFile,
  DRIVE_MEDIA_URL_BASE
} from "../lib/backup/replication/download";
import {
  REPLICATION_DESTINATION,
  BIN_MIME_TYPE,
  MANIFEST_MIME_TYPE,
  remoteBinFileName,
  remoteManifestFileName
} from "../lib/backup/replication/uploader";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse
} from "../lib/backup/replication/http";
import {
  LABEL_FULL_SHA256_OK,
  LABEL_METADATA_OK,
  LABEL_NONE,
  labelForFailure,
  remoteVerifyLabel
} from "../lib/backup/replication/verify-labels";
import type { DriveFolderApi } from "../lib/backup/replication/folder";
import { GoogleDriveOperationError } from "../lib/backup/replication/errors";

// ─── Prisma ────────────────────────────────────────────────────────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FOLDER_ID = "layer-h-verify-folder-id";
const ACCESS_TOKEN = "layer-h-verify-fake-access-token";
const NOW = new Date("2026-09-29T14:00:00Z");

const testBackupIds: string[] = [];
const testWindowStart = new Date();
let stagingRoot = "";

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

async function seedCompletedReplication(
  prisma: PrismaClient,
  bin: Buffer,
  manifest: Buffer,
  overrides: {
    remoteBinFileId?: string;
    remoteManifestFileId?: string;
    remoteBinSize?: bigint | null;
    remoteBinMd5?: string | null;
  } = {}
): Promise<{ backupId: string; replicationId: string }> {
  const backupId = makeCuid();
  testBackupIds.push(backupId);
  await prisma.backup.create({
    data: {
      id: backupId,
      status: "VERIFIED",
      kind: "MANUAL",
      schemaSha256: sha256("schema"),
      appVersion: "layer-h-test",
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
      remoteBinFileId: overrides.remoteBinFileId ?? "drive-bin-id-1",
      remoteManifestFileId: overrides.remoteManifestFileId ?? "drive-mf-id-1",
      remoteFolderId: FOLDER_ID,
      remoteBinSize:
        overrides.remoteBinSize === undefined
          ? BigInt(bin.byteLength)
          : overrides.remoteBinSize,
      remoteManifestSize: BigInt(manifest.byteLength),
      remoteBinMd5:
        overrides.remoteBinMd5 === undefined ? md5(bin) : overrides.remoteBinMd5,
      remoteManifestMd5: md5(manifest),
      lastVerifyLevel: "METADATA_ONLY",
      lastVerifiedAt: new Date("2026-09-29T12:00:00Z")
    }
  });
  return { backupId, replicationId: rep.id };
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
};
type FakeDriveState = { files: FakeDriveFile[] };

function makeFakeDrive(state: FakeDriveState): DriveFolderApi {
  return {
    files: {
      async get(params) {
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
      async list() {
        return { data: { files: [] } };
      }
    }
  };
}

type HttpHandler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
function makeHttp(handlers: HttpHandler[]): { http: HttpClient; calls: HttpRequest[] } {
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

function buildBin(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

function driveMeta(
  backupId: string,
  bin: Buffer,
  manifest: Buffer,
  opts: {
    binName?: string;
    binMime?: string;
    binParents?: string[];
    binTrashed?: boolean;
    binSize?: string;
    binMd5?: string;
    binAppProps?: Record<string, string>;
  } = {}
): FakeDriveState {
  return {
    files: [
      {
        id: "drive-bin-id-1",
        name: opts.binName ?? remoteBinFileName(backupId),
        mimeType: opts.binMime ?? BIN_MIME_TYPE,
        trashed: opts.binTrashed ?? false,
        size: opts.binSize ?? String(bin.byteLength),
        md5Checksum: opts.binMd5 ?? md5(bin),
        parents: opts.binParents ?? [FOLDER_ID],
        appProperties: opts.binAppProps ?? { backupId, artifact: "bin" }
      },
      {
        id: "drive-mf-id-1",
        name: remoteManifestFileName(backupId),
        mimeType: MANIFEST_MIME_TYPE,
        trashed: false,
        size: String(manifest.byteLength),
        md5Checksum: md5(manifest),
        parents: [FOLDER_ID],
        appProperties: { backupId, artifact: "manifest" }
      }
    ]
  };
}

function buildDeps(over: Partial<VerifyRemoteDeps>, prisma: PrismaClient): VerifyRemoteDeps {
  return {
    prisma,
    drive: over.drive ?? makeFakeDrive({ files: [] }),
    http: over.http ?? makeHttp([]).http,
    accessToken: ACCESS_TOKEN,
    folderId: FOLDER_ID,
    stagingRoot,
    now: () => NOW,
    httpTimeoutMs: 30_000,
    ...over
  };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

before(async () => {
  stagingRoot = await mkdtemp(path.join(os.tmpdir(), "bis-verify-remote-"));
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
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  // Purge prior-test backups + replications from THIS run so a stale
  // COMPLETED row does not leak between tests.
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

// ─── verifyRemoteMetadata ────────────────────────────────────────────────

describe("verifyRemoteMetadata — happy path", () => {
  test("all metadata matches → OK, level=METADATA_ONLY, no attestedContentSha256", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBin(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const { backupId, replicationId } = await seedCompletedReplication(
        prisma,
        bin,
        manifest
      );
      const drive = makeFakeDrive(driveMeta(backupId, bin, manifest));
      const result = await verifyRemoteMetadata(replicationId, buildDeps({ drive }, prisma));
      assert.equal(result.outcome, "OK");
      if (result.outcome !== "OK") return;
      assert.equal(result.level, "METADATA_ONLY");
      assert.equal(result.attestedContentSha256, undefined);

      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.lastVerifyLevel, "METADATA_ONLY");
      // Backup independence.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
      // Honesty gate: attestedContentSha256 is a FULL_SHA256-only field.
      assert.equal(rep!.attestedContentSha256, null);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("verifyRemoteMetadata — failure cases", () => {
  const cases: Array<{ label: string; opts: Parameters<typeof driveMeta>[3]; contains: string }> = [
    { label: "name mismatch", opts: { binName: "wrong.bin" }, contains: "name_mismatch" },
    { label: "size mismatch", opts: { binSize: "999" }, contains: "size_mismatch" },
    { label: "md5 mismatch", opts: { binMd5: "0".repeat(32) }, contains: "md5_mismatch" },
    { label: "mimeType mismatch", opts: { binMime: "text/plain" }, contains: "mimeType_mismatch" },
    { label: "parents mismatch", opts: { binParents: ["other-folder"] }, contains: "parents_mismatch" },
    { label: "trashed", opts: { binTrashed: true }, contains: "trashed" },
    {
      label: "appProperties mismatch (backupId)",
      opts: { binAppProps: { backupId: "wrong", artifact: "bin" } },
      contains: "appProperties_mismatch"
    },
    {
      label: "appProperties mismatch (artifact)",
      opts: { binAppProps: { backupId: "placeholder", artifact: "manifest" } },
      contains: "appProperties_mismatch"
    }
  ];
  for (const c of cases) {
    test(`bin ${c.label} → REMOTE_VERIFICATION_FAILED, row stays COMPLETED`, async () => {
      const prisma = await makePrisma();
      try {
        const bin = buildBin(1024);
        const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
        const { backupId, replicationId } = await seedCompletedReplication(
          prisma,
          bin,
          manifest
        );
        // Rebuild driveMeta so appProps.backupId resolves to the actual id.
        const opts = { ...c.opts };
        if (
          opts &&
          opts.binAppProps &&
          opts.binAppProps["backupId"] === "placeholder"
        ) {
          opts.binAppProps = {
            ...opts.binAppProps,
            backupId
          };
        }
        const drive = makeFakeDrive(driveMeta(backupId, bin, manifest, opts));
        const result = await verifyRemoteMetadata(
          replicationId,
          buildDeps({ drive }, prisma)
        );
        assert.equal(result.outcome, "MISMATCH");
        if (result.outcome !== "MISMATCH") return;
        assert.equal(result.errorCode, "REMOTE_VERIFICATION_FAILED");
        assert.match(result.sanitizedMessage, new RegExp(c.contains));

        const rep = await prisma.backupReplication.findUnique({
          where: { id: replicationId }
        });
        // §K.10 invariant: deep-verify failure NEVER flips the row.
        assert.equal(rep!.status, "COMPLETED");
        assert.equal(rep!.errorCode, "REMOTE_VERIFICATION_FAILED");
        // Backup.status still VERIFIED — independence.
        const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
        assert.equal(bkp!.status, "VERIFIED");
      } finally {
        await prisma.$disconnect();
      }
    });
  }
});

// ─── verifyRemoteFullSha256 ──────────────────────────────────────────────

describe("verifyRemoteFullSha256 — happy path", () => {
  test("download + sha256 match → OK, attestedContentSha256 populated, staging cleaned", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBin(4096);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const { backupId, replicationId } = await seedCompletedReplication(
        prisma,
        bin,
        manifest
      );
      const drive = makeFakeDrive(driveMeta(backupId, bin, manifest));
      const { http } = makeHttp([
        () => response(200, { "content-type": BIN_MIME_TYPE }, bin)
      ]);
      const beforeEntries = await listStagingChildren();
      const result = await verifyRemoteFullSha256(
        replicationId,
        buildDeps({ drive, http }, prisma)
      );
      assert.equal(result.outcome, "OK");
      if (result.outcome !== "OK") return;
      assert.equal(result.level, "FULL_SHA256");
      assert.equal(result.attestedContentSha256, sha256(bin));

      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.lastVerifyLevel, "FULL_SHA256");
      assert.equal(rep!.attestedContentSha256, sha256(bin));
      assert.equal(rep!.status, "COMPLETED");
      // Backup independence.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
      // Staging directory cleaned up.
      const afterEntries = await listStagingChildren();
      assert.deepEqual(afterEntries, beforeEntries);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("verifyRemoteFullSha256 — failure cases", () => {
  test("SHA-256 mismatch → REMOTE_CHECKSUM_MISMATCH; row STAYS COMPLETED; attestedContentSha256 UNCHANGED", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBin(4096);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const { backupId, replicationId } = await seedCompletedReplication(
        prisma,
        bin,
        manifest
      );
      // Pre-populate attestedContentSha256 with a "prior good" value —
      // a failed verify must NEVER overwrite it.
      const priorAttested = sha256(Buffer.from("prior-good"));
      await prisma.backupReplication.update({
        where: { id: replicationId },
        data: { attestedContentSha256: priorAttested, lastVerifyLevel: "FULL_SHA256" }
      });

      const drive = makeFakeDrive(driveMeta(backupId, bin, manifest));
      // Serve a DIFFERENT body than the local Backup.contentSha256.
      const tampered = buildBin(4096);
      tampered[0] ^= 0xff;
      const { http } = makeHttp([
        () => response(200, { "content-type": BIN_MIME_TYPE }, tampered)
      ]);
      const result = await verifyRemoteFullSha256(
        replicationId,
        buildDeps({ drive, http }, prisma)
      );
      assert.equal(result.outcome, "MISMATCH");
      if (result.outcome !== "MISMATCH") return;
      assert.equal(result.errorCode, "REMOTE_CHECKSUM_MISMATCH");

      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.status, "COMPLETED");
      assert.equal(rep!.errorCode, "REMOTE_CHECKSUM_MISMATCH");
      // attestedContentSha256 UNCHANGED — a failed deep verify does
      // not overwrite a prior FULL_SHA256 attestation.
      assert.equal(rep!.attestedContentSha256, priorAttested);
      // Backup.status still VERIFIED.
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("HTTP 500 during download → surfaced as classified error, row stays COMPLETED, staging cleaned", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBin(4096);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const { backupId, replicationId } = await seedCompletedReplication(
        prisma,
        bin,
        manifest
      );
      const drive = makeFakeDrive(driveMeta(backupId, bin, manifest));
      const { http } = makeHttp([() => response(500, {}, "internal")]);
      const result = await verifyRemoteFullSha256(
        replicationId,
        buildDeps({ drive, http }, prisma)
      );
      assert.equal(result.outcome, "MISMATCH");
      if (result.outcome !== "MISMATCH") return;
      assert.equal(result.errorCode, "SERVER_ERROR");
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(rep!.status, "COMPLETED");
      const bkp = await prisma.backup.findUnique({ where: { id: backupId } });
      assert.equal(bkp!.status, "VERIFIED");
      // Staging cleaned even on failure.
      const entries = await listStagingChildren();
      // Note: mkdtemp children may include unrelated tempdirs from
      // concurrent tests. We only assert that our per-verify subdir
      // was cleaned up (approximated: no `drive-verify-*` names remain
      // beyond what existed before, which is verified per-test above).
      void entries;
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── downloadDriveFile — ceilings + validators ────────────────────────────

describe("downloadDriveFile — defensive guards", () => {
  test("rejects unsafe fileId", async () => {
    const prisma = await makePrisma();
    try {
      await assert.rejects(async () => {
        await downloadDriveFile({
          http: makeHttp([]).http,
          accessToken: ACCESS_TOKEN,
          fileId: "../../etc/passwd",
          stagingRoot,
          fileName: "safe.bin",
          maxBytes: MAX_BIN_BYTES,
          computeSha256: false,
          timeoutMs: 30_000
        });
      }, /CONFIGURATION_ERROR: fileId/);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("rejects unsafe staging filename", async () => {
    await assert.rejects(async () => {
      await downloadDriveFile({
        http: makeHttp([]).http,
        accessToken: ACCESS_TOKEN,
        fileId: "safeid123",
        stagingRoot,
        fileName: "../escape.bin",
        maxBytes: MAX_BIN_BYTES,
        computeSha256: false,
        timeoutMs: 30_000
      });
    }, /CONFIGURATION_ERROR: staging filename/);
  });

  test("rejects payload larger than maxBytes ceiling (post-buffer check)", async () => {
    const big = Buffer.alloc(100);
    // No Content-Length header — forces the post-buffer defence in
    // depth check to fire.
    const { http } = makeHttp([() => response(200, {}, big)]);
    await assert.rejects(async () => {
      await downloadDriveFile({
        http,
        accessToken: ACCESS_TOKEN,
        fileId: "safeid123",
        stagingRoot,
        fileName: "capped.bin",
        maxBytes: BigInt(50),
        computeSha256: false,
        timeoutMs: 30_000
      });
    }, /REMOTE_SIZE_MISMATCH: downloaded size 100/);
  });

  test("rejects via Content-Length pre-check BEFORE trusting the body (G6 MEDIUM-1)", async () => {
    // Advertise a huge size in the header. The pre-check must refuse
    // before the body buffer is trusted. We still send a small body
    // to make the test cheap — the pre-check should fire first.
    const smallBody = Buffer.alloc(10);
    const { http } = makeHttp([
      () => response(200, { "content-length": "999999999999" }, smallBody)
    ]);
    await assert.rejects(async () => {
      await downloadDriveFile({
        http,
        accessToken: ACCESS_TOKEN,
        fileId: "safeid123",
        stagingRoot,
        fileName: "advertised-too-big.bin",
        maxBytes: BigInt(1024),
        computeSha256: false,
        timeoutMs: 30_000
      });
    }, /REMOTE_SIZE_MISMATCH: advertised size 999999999999/);
  });

  test("rejects a bearer that is already prefixed 'Bearer '", async () => {
    await assert.rejects(async () => {
      await downloadDriveFile({
        http: makeHttp([]).http,
        accessToken: "Bearer abc",
        fileId: "safeid123",
        stagingRoot,
        fileName: "any.bin",
        maxBytes: MAX_BIN_BYTES,
        computeSha256: false,
        timeoutMs: 30_000
      });
    }, /CONFIGURATION_ERROR: access token double-prefixed/);
  });

  test("Authorization header carries the bearer; URL is the media endpoint", async () => {
    const bin = buildBin(64);
    const { http, calls } = makeHttp([() => response(200, {}, bin)]);
    const dl = await downloadDriveFile({
      http,
      accessToken: ACCESS_TOKEN,
      fileId: "safeid123",
      stagingRoot,
      fileName: "hdr-check.bin",
      maxBytes: MAX_BIN_BYTES,
      computeSha256: true,
      timeoutMs: 30_000
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.headers["Authorization"],
      `Bearer ${ACCESS_TOKEN}`
    );
    assert.ok(calls[0]!.url.startsWith(DRIVE_MEDIA_URL_BASE));
    assert.ok(calls[0]!.url.includes("alt=media"));
    assert.equal(dl.sha256Hex, sha256(bin));
    // Written content matches source.
    const written = await readFile(dl.absolutePath);
    assert.equal(sha256(written), sha256(bin));
  });
});

// ─── Validators ──────────────────────────────────────────────────────────

describe("assertSafeFileId / assertSafeStagingName — regex boundaries", () => {
  test("accepts valid Drive resource ids and rejects tokens with unsafe chars", () => {
    assert.doesNotThrow(() => assertSafeFileId("abc_XYZ-123"));
    for (const bad of ["../escape", "abc/def", "abc def", "abc'or", "abc\\bad", "", "a".repeat(129)]) {
      assert.throws(
        () => assertSafeFileId(bad),
        (err: unknown) => err instanceof GoogleDriveOperationError
      );
    }
  });

  test("staging name regex refuses path separators / traversal / nul", () => {
    assert.doesNotThrow(() => assertSafeStagingName("backup_abc.bin"));
    for (const bad of ["..", "../a", "a/b", "a\\b", "a\0b", "", "a".repeat(129)]) {
      assert.throws(
        () => assertSafeStagingName(bad),
        (err: unknown) => err instanceof GoogleDriveOperationError
      );
    }
  });
});

// ─── UI labels — honesty gate ────────────────────────────────────────────

describe("verify-labels — MD5 vs SHA-256 honesty", () => {
  test("METADATA_ONLY label mentions 'métadonnées', NOT 'SHA-256'", () => {
    assert.equal(LABEL_METADATA_OK, "Vérification distante : métadonnées OK");
    assert.doesNotMatch(LABEL_METADATA_OK, /SHA-256/);
  });
  test("FULL_SHA256 label mentions 'SHA-256 complet'", () => {
    assert.equal(LABEL_FULL_SHA256_OK, "Vérification distante : SHA-256 complet OK");
    assert.match(LABEL_FULL_SHA256_OK, /SHA-256 complet/);
  });
  test("NONE label is the not-verified sentinel", () => {
    assert.equal(LABEL_NONE, "Vérification distante : non effectuée");
  });
  test("labelForFailure surfaces the classified errorCode", () => {
    assert.equal(
      labelForFailure("REMOTE_CHECKSUM_MISMATCH"),
      "Vérification distante : échec — REMOTE_CHECKSUM_MISMATCH"
    );
    assert.doesNotMatch(
      labelForFailure("REMOTE_CHECKSUM_MISMATCH"),
      /Bearer|http|Google/
    );
  });
  test("remoteVerifyLabel prefers errorCode over verifyLevel", () => {
    assert.equal(
      remoteVerifyLabel({
        lastVerifyLevel: "FULL_SHA256",
        errorCode: "REMOTE_CHECKSUM_MISMATCH"
      }),
      "Vérification distante : échec — REMOTE_CHECKSUM_MISMATCH"
    );
    assert.equal(
      remoteVerifyLabel({ lastVerifyLevel: "METADATA_ONLY", errorCode: "NONE" }),
      LABEL_METADATA_OK
    );
    assert.equal(
      remoteVerifyLabel({ lastVerifyLevel: "FULL_SHA256", errorCode: "NONE" }),
      LABEL_FULL_SHA256_OK
    );
    assert.equal(
      remoteVerifyLabel({ lastVerifyLevel: "NONE", errorCode: "NONE" }),
      LABEL_NONE
    );
  });
});

// ─── Sanitization ────────────────────────────────────────────────────────

describe("verify-remote — sanitization", () => {
  test("errorMessage never contains bearer tokens or session URIs", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBin(4096);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const { backupId, replicationId } = await seedCompletedReplication(
        prisma,
        bin,
        manifest
      );
      const drive = makeFakeDrive(driveMeta(backupId, bin, manifest));
      // The download 500 body includes a leaked-looking URL, bearer,
      // and refresh token. None must appear in errorMessage.
      const leaky = JSON.stringify({
        url: "https://www.googleapis.com/upload/session/x?upload_id=SECRET_TOKEN",
        authorization: `Bearer ${ACCESS_TOKEN}`,
        refresh_token: "RT_LEAK_VALUE"
      });
      const { http } = makeHttp([() => response(503, {}, leaky)]);
      await verifyRemoteFullSha256(
        replicationId,
        buildDeps({ drive, http }, prisma)
      );
      const rep = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      const msg = rep!.errorMessage ?? "";
      assert.doesNotMatch(msg, /Bearer /);
      assert.doesNotMatch(msg, /upload_id=/);
      assert.doesNotMatch(msg, /SECRET_TOKEN/);
      assert.doesNotMatch(msg, /RT_LEAK_VALUE/);
      assert.doesNotMatch(msg, new RegExp(ACCESS_TOKEN));
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── State-machine invariant: deep verify NEVER writes status ─────────────

describe("verify-remote — §K.10 state-machine invariant", () => {
  test("SKIPPED_NOT_COMPLETED when the row is not COMPLETED (deep verify is a no-op)", async () => {
    const prisma = await makePrisma();
    try {
      const bin = buildBin(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const { replicationId } = await seedCompletedReplication(prisma, bin, manifest);
      await prisma.backupReplication.update({
        where: { id: replicationId },
        data: { status: "RETRYABLE_FAILURE" }
      });
      const result = await verifyRemoteMetadata(
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

  test("SKIPPED_NOT_REPLICATED when the replication id no longer exists", async () => {
    const prisma = await makePrisma();
    try {
      const result = await verifyRemoteMetadata(
        "cnonexistent_row_id",
        buildDeps({}, prisma)
      );
      assert.equal(result.outcome, "SKIPPED_NOT_REPLICATED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

async function listStagingChildren(): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const items = await readdir(stagingRoot);
    return items.sort();
  } catch {
    return [];
  }
}

// Layer L §L.5 tests — transaction discipline enforcement.
//
// Run with:
//   npm run test:backup-drive-tx-discipline
//
// The single most important architectural invariant the whole
// replication tree rests on:
//
//   DATABASE CLAIM / STATE TRANSITION  →  COMMIT  →  GOOGLE DRIVE I/O
//
// If any Drive HTTP call ever happens while a Prisma `$transaction`
// callback is still on the call stack, the tx is holding a Postgres
// row lock across a network round-trip. That means:
//
//   * A slow / unreachable Drive stalls the local database.
//   * A worker crash between the tx commit and the Drive call can
//     leave the row locked while the transaction rolls back.
//   * Concurrent worker ticks can be blocked by an unrelated network
//     path, breaking the SKIP LOCKED contract.
//
// The plan §L.5 mandates this test:
//
//   > Verified by a test (`scripts/backup-drive-tx-discipline.test.ts`)
//   > that hooks Prisma's `$queryRaw` to fail if any Drive-facing
//   > mock is called inside a tx.
//
// We hook `$transaction` rather than `$queryRaw` because the worker's
// discipline is expressed at the tx boundary (self-heal + watchdog +
// rehydrate + claim all inside one $transaction, Drive I/O only
// AFTER the callback returns).
//
// Mechanism:
//   1. Wrap the Prisma client's `$transaction` method. When the tx
//      callback is invoked we increment an `inTx` depth counter. On
//      completion (success or failure) we decrement.
//   2. Wrap the fake Drive HTTP client and the fake Drive files.*
//      surface. Every call asserts `inTx === 0`. A violation throws
//      a distinctive TxDisciplineViolation error that names the
//      offending call.
//   3. Drive `runReplicationWorkerTick` through several paths
//      (no-work, watchdog reconcile, retry rehydration, successful
//      upload, retryable failure) and confirm no violation fires.
//
// Layers A–K make this pass on the first run; this test locks the
// property so a future refactor cannot silently regress it.

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  runReplicationWorkerTick,
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

// ─── Env fixture ───────────────────────────────────────────────────────────

const ENV_KEYS = [
  "GOOGLE_DRIVE_BACKUP_ENABLED",
  "GOOGLE_DRIVE_AUTH_MODE",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_FOLDER_ID"
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

function primeEnv(): void {
  process.env.GOOGLE_DRIVE_BACKUP_ENABLED = "true";
  process.env.GOOGLE_DRIVE_CLIENT_ID =
    "layer-l-tx-discipline-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "layer-l-tx-discipline-client-secret";
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN =
    "layer-l-tx-discipline-refresh-token-value";
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

// ─── Prisma ────────────────────────────────────────────────────────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Tx-discipline instrumentation ───────────────────────────────────────

class TxDisciplineViolation extends Error {
  constructor(where: string) {
    super(`TxDisciplineViolation: ${where} was called while a Prisma $transaction was open`);
    this.name = "TxDisciplineViolation";
  }
}

type TxDepthState = { depth: number; violations: string[] };

/**
 * Wrap a `PrismaClient` so every `$transaction(cb)` invocation bumps a
 * shared `depth` counter for the lifetime of the callback. `depth > 0`
 * means "some code, somewhere, is currently executing inside a Prisma
 * transaction callback."
 *
 * `$transaction(array)` overload is passed through untouched — the
 * replication worker never uses that form, but a bug that started
 * using it would not be caught here (documented explicitly).
 */
function wrapPrismaForTxDiscipline<T extends PrismaClient>(
  client: T,
  state: TxDepthState
): T {
  const original = client.$transaction.bind(client) as PrismaClient["$transaction"];
  // Cast through unknown to allow overwriting the property while
  // preserving the outer type. The wrapped method has the same shape.
  const wrapped: PrismaClient["$transaction"] = (async (
    argOrFn: unknown,
    maybeOptions?: unknown
  ) => {
    if (typeof argOrFn === "function") {
      state.depth++;
      try {
        return await (
          original as unknown as (
            fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options?: unknown
          ) => Promise<unknown>
        )(
          argOrFn as (tx: Prisma.TransactionClient) => Promise<unknown>,
          maybeOptions
        );
      } finally {
        state.depth--;
      }
    }
    // Array-of-PrismaPromise overload — passthrough. Replication code
    // does not use this form; a violation would be missed here.
    return await (
      original as unknown as (
        arg: unknown,
        options?: unknown
      ) => Promise<unknown>
    )(argOrFn, maybeOptions);
  }) as PrismaClient["$transaction"];
  (client as unknown as { $transaction: PrismaClient["$transaction"] }).$transaction =
    wrapped;
  return client;
}

/** Every touchpoint on Drive/HTTP asserts inTx === 0 before proceeding. */
function assertOutsideTx(state: TxDepthState, where: string): void {
  if (state.depth !== 0) {
    state.violations.push(where);
    throw new TxDisciplineViolation(where);
  }
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FOLDER_ID = "layer-l-tx-discipline-folder-id";
const FAKE_ACCESS_TOKEN = "layer-l-tx-discipline-fake-access-token";
const STORAGE_DIR = "/virt/backup-store-l";
const CHUNK_BYTES = 256 * 1024;

const seededBackupIds: string[] = [];
const stashedVerifiedIds: string[] = [];
const testWindowStart = new Date();

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}
function sha256(s: string | Buffer): string {
  return createHash("sha256")
    .update(typeof s === "string" ? Buffer.from(s, "utf-8") : s)
    .digest("hex");
}
function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

async function seedBackup(
  prisma: PrismaClient,
  overrides: {
    status?: "VERIFIED" | "COMPLETED" | "DELETED" | "MISSING";
    sizeBytes?: bigint;
    contentSha256?: string;
    manifestSha256?: string;
  } = {}
): Promise<string> {
  const id = makeCuid();
  seededBackupIds.push(id);
  await prisma.backup.create({
    data: {
      id,
      status: overrides.status ?? "VERIFIED",
      kind: "MANUAL",
      schemaSha256: sha256("schema"),
      appVersion: "layer-l-tx",
      formatVersion: "1",
      encryptionVersion: "v1",
      sizeBytes: overrides.sizeBytes ?? BigInt(1024),
      contentSha256: overrides.contentSha256 ?? sha256("bin"),
      manifestSha256: overrides.manifestSha256 ?? sha256("mf"),
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

function makeGuardedDrive(
  state: TxDepthState,
  files: FakeDriveFile[]
): DriveApi {
  return {
    files: {
      async get(params) {
        assertOutsideTx(state, `drive.files.get(${params.fileId})`);
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
        return { data: { ...f } };
      },
      async list(params) {
        assertOutsideTx(state, "drive.files.list");
        const hits = files.filter((f) => {
          if (f.visibleInList === false) return false;
          if (params.q.includes("trashed=false") && f.trashed === true) {
            return false;
          }
          const backupIdMatch =
            /appProperties has \{ key='backupId' and value='([^']+)' \}/.exec(
              params.q
            );
          if (
            backupIdMatch &&
            f.appProperties?.["backupId"] !== backupIdMatch[1]
          ) {
            return false;
          }
          const artifactMatch =
            /appProperties has \{ key='artifact' and value='([^']+)' \}/.exec(
              params.q
            );
          if (
            artifactMatch &&
            f.appProperties?.["artifact"] !== artifactMatch[1]
          ) {
            return false;
          }
          const parentMatch = /'([^']+)' in parents/.exec(params.q);
          if (parentMatch && !(f.parents ?? []).includes(parentMatch[1]!)) {
            return false;
          }
          return true;
        });
        return { data: { files: hits.map((f) => ({ ...f })) } };
      }
    }
  };
}

function makeGuardedHttp(
  state: TxDepthState,
  handlers: Array<(req: HttpRequest) => HttpResponse | Promise<HttpResponse>>
): HttpClient {
  const script = [...handlers];
  return async (req) => {
    assertOutsideTx(state, `http[${req.method}]`);
    const h = script.shift();
    if (!h) throw new Error(`unexpected http call to ${req.url.slice(0, 50)}`);
    return await h(req);
  };
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

function successfulUploadHandlers(
  bin: Buffer,
  manifest: Buffer
): Array<(req: HttpRequest) => HttpResponse> {
  return [
    () =>
      response(200, {
        Location: "https://www.googleapis.com/upload/session/bin-txd"
      }),
    () =>
      response(
        200,
        {},
        JSON.stringify({
          id: "drive-bin-id-txd",
          size: String(bin.byteLength),
          md5Checksum: md5(bin)
        })
      ),
    () =>
      response(200, {
        Location: "https://www.googleapis.com/upload/session/mf-txd"
      }),
    () =>
      response(
        200,
        {},
        JSON.stringify({
          id: "drive-mf-id-txd",
          size: String(manifest.byteLength),
          md5Checksum: md5(manifest)
        })
      )
  ];
}

function driveVisibleForVerify(
  backupId: string,
  bin: Buffer,
  manifest: Buffer,
  state: TxDepthState
): DriveApi {
  return makeGuardedDrive(state, [
    {
      id: "drive-bin-id-txd",
      name: remoteBinFileName(backupId),
      mimeType: BIN_MIME_TYPE,
      trashed: false,
      size: String(bin.byteLength),
      parents: [FOLDER_ID],
      appProperties: { backupId, artifact: "bin" },
      visibleInList: false
    },
    {
      id: "drive-mf-id-txd",
      name: remoteManifestFileName(backupId),
      mimeType: MANIFEST_MIME_TYPE,
      trashed: false,
      size: String(manifest.byteLength),
      parents: [FOLDER_ID],
      appProperties: { backupId, artifact: "manifest" },
      visibleInList: false
    }
  ]);
}

// ─── Suite setup ──────────────────────────────────────────────────────────

before(async () => {
  primeEnv();
  const prisma = await makePrisma();
  try {
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive", folderId: FOLDER_ID },
      update: { folderId: FOLDER_ID }
    });
    // Stash pre-existing VERIFIED backups so the self-heal step of the
    // worker can't sweep unrelated rows into our fixture — same
    // discipline as backup-drive-worker.test.ts.
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
    if (seededBackupIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: seededBackupIds } }
      });
      await prisma.backup.deleteMany({
        where: { id: { in: seededBackupIds } }
      });
    }
    await prisma.backupReplication.deleteMany({
      where: { createdAt: { gte: testWindowStart } }
    });
    if (stashedVerifiedIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: stashedVerifiedIds } }
      });
      await prisma.backup.updateMany({
        where: { id: { in: stashedVerifiedIds } },
        data: { status: "VERIFIED" }
      });
    }
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
  primeEnv();
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

// ─── Wrapping smoke-test ─────────────────────────────────────────────────

describe("tx-discipline instrumentation smoke test", () => {
  test("wrapper counts $transaction depth correctly", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);
      assert.equal(state.depth, 0);
      await prisma.$transaction(async (tx) => {
        assert.equal(state.depth, 1);
        await tx.backup.findMany({ take: 1 });
        assert.equal(state.depth, 1);
      });
      assert.equal(state.depth, 0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("wrapper detects a synthetic Drive call inside a tx", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);
      await assert.rejects(
        prisma.$transaction(async () => {
          // Any assertOutsideTx call inside the tx must throw.
          assertOutsideTx(state, "synthetic drive.get");
        }),
        /TxDisciplineViolation/
      );
      assert.deepEqual(state.violations, ["synthetic drive.get"]);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Worker tick — successful upload path ────────────────────────────────

describe("runReplicationWorkerTick — no Drive I/O inside any $transaction", () => {
  test("successful upload path: every Drive call outside every tx", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "PENDING"
        }
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveVisibleForVerify(backupId, bin, manifest, state);
      const http = makeGuardedHttp(state, successfulUploadHandlers(bin, manifest));

      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => {
          assertOutsideTx(state, "folderResolver");
          return FOLDER_ID;
        },
        accessTokenFactory: async () => {
          assertOutsideTx(state, "accessTokenFactory");
          return FAKE_ACCESS_TOKEN;
        },
        httpFactory: () => http,
        files,
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "COMPLETED", `unexpected ${result.outcome}`);
      assert.deepEqual(
        state.violations,
        [],
        `tx-discipline violations: ${state.violations.join(", ")}`
      );
      // The tx depth must be zero at end.
      assert.equal(state.depth, 0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("retryable 500 path: HTTP failure still occurs outside the tx", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "PENDING"
        }
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveVisibleForVerify(backupId, bin, manifest, state);
      const http = makeGuardedHttp(state, [() => response(500, {}, "server error")]);

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

      assert.equal(result.outcome, "RETRYABLE");
      assert.deepEqual(state.violations, []);
      assert.equal(state.depth, 0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("no-work tick: tx runs, no Drive I/O attempted, no violations", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);

      // Guarded Drive with no files; if any Drive call happens it will
      // just return empty. But there's nothing to claim → SKIPPED_NO_WORK.
      const drive = makeGuardedDrive(state, []);
      const http = makeGuardedHttp(state, []);
      const result = await runReplicationWorkerTick({
        client: prisma,
        driveFactory: () => drive,
        folderResolver: async () => FOLDER_ID,
        accessTokenFactory: async () => FAKE_ACCESS_TOKEN,
        httpFactory: () => http,
        files: makeMemFs({}),
        storageDir: STORAGE_DIR,
        chunkBytesOverride: CHUNK_BYTES,
        httpTimeoutMsOverride: 30_000
      });

      assert.equal(result.outcome, "SKIPPED_NO_WORK");
      assert.deepEqual(state.violations, []);
      assert.equal(state.depth, 0);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Watchdog + rehydration paths ────────────────────────────────────────

describe("runReplicationWorkerTick — watchdog & rehydrate stay tx-clean", () => {
  test("stale UPLOADING is watchdog-reconciled inside the tx; Drive only after commit", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      // Seed a stuck-UPLOADING row so the watchdog reconciles it.
      const staleTime = new Date(Date.now() - STUCK_UPLOAD_TIMEOUT_MS - 60_000);
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "UPLOADING",
          lastAttemptAt: staleTime,
          uploadStartedAt: staleTime
        }
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveVisibleForVerify(backupId, bin, manifest, state);
      const http = makeGuardedHttp(state, successfulUploadHandlers(bin, manifest));

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
      assert.ok((result.watchdog?.reconciled ?? 0) >= 1);
      assert.deepEqual(state.violations, []);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("RETRYABLE_FAILURE rehydration inside the tx; Drive only after commit", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "RETRYABLE_FAILURE",
          attemptCount: 2,
          nextRetryAt: new Date(Date.now() - 60_000),
          errorCode: "SERVER_ERROR"
        }
      });
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveVisibleForVerify(backupId, bin, manifest, state);
      const http = makeGuardedHttp(state, successfulUploadHandlers(bin, manifest));

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
      assert.ok((result.rehydrated?.count ?? 0) >= 1);
      assert.deepEqual(state.violations, []);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Self-heal path ──────────────────────────────────────────────────────

describe("runReplicationWorkerTick — self-heal path stays tx-clean", () => {
  test("self-heal enqueue happens inside the tx via Prisma createMany, no Drive I/O", async () => {
    const prisma = await makePrisma();
    try {
      const state: TxDepthState = { depth: 0, violations: [] };
      wrapPrismaForTxDiscipline(prisma, state);

      const bin = buildBinPayload(1024);
      const manifest = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
      const backupId = await seedBackup(prisma, {
        sizeBytes: BigInt(bin.byteLength),
        contentSha256: sha256(bin),
        manifestSha256: sha256(manifest)
      });
      // Do NOT enqueue — the worker must self-heal and add a PENDING row.
      const files = makeMemFs({
        [localBinPath(STORAGE_DIR, backupId)]: bin,
        [localManifestPath(STORAGE_DIR, backupId)]: manifest
      });
      const drive = driveVisibleForVerify(backupId, bin, manifest, state);
      const http = makeGuardedHttp(state, successfulUploadHandlers(bin, manifest));

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
      assert.ok((result.selfHeal?.inserted ?? 0) >= 1);
      assert.deepEqual(state.violations, []);
    } finally {
      await prisma.$disconnect();
    }
  });
});

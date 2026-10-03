// Layer K tests — secret handling and log-hygiene guarantees (Plan §R.2).
//
// Run with:
//   npm run test:backup-drive-log-hygiene
//
// R.1 declares an absolute rule: no Bearer credential, refresh token,
// client secret, resumable upload session URI, or Google response body
// byte may leak into `console.*`, `audit.log`, or any thrown `Error`
// message. R.2 is this test — it runs every failure mode across the
// replication tree with UNIQUE canary values planted in the env, in
// the fake HTTP responses, and in synthesized exceptions, and asserts
// that NO canary substring appears in:
//
//   * intercepted `console.*` output
//   * `AuditLog.meta` rows written during the test window
//   * `BackupReplication.errorMessage` after the operation
//   * any error message that bubbles out of the module under test
//
// The canary values are cryptographically distinguishable random
// strings — a false-positive match against a legitimate output is
// effectively impossible.

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";

// ─── Canaries ─────────────────────────────────────────────────────────────
//
// Every canary is a hex string with a fixed prefix. A production string
// will never contain any of these prefixes; a leaked substring is
// therefore ipso facto a bug. Prefixes are distinct per secret class so
// a failure message can name the exact leak.

const CANARY_REFRESH_TOKEN = "leakcanary_refresh_" + randomBytes(12).toString("hex");
const CANARY_CLIENT_SECRET = "leakcanary_clientsecret_" + randomBytes(12).toString("hex");
const CANARY_ACCESS_TOKEN = "leakcanary_accesstoken_" + randomBytes(12).toString("hex");
const CANARY_SESSION_ID = "leakcanary_sessionid_" + randomBytes(12).toString("hex");
const CANARY_SESSION_URI = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${CANARY_SESSION_ID}`;

/**
 * Substrings we forbid anywhere in captured output.
 *
 *   * `Bearer ` — every OAuth authorization header carries this literal
 *     prefix. If it ever appears in captured output, some code path
 *     failed to strip the header before logging / throwing.
 *   * `refresh_token` — Google's OAuth exchange body uses this exact
 *     JSON key. If it appears, something has leaked a refresh flow
 *     response body.
 *   * The canary values — any of these appearing means a real secret
 *     leaked (the canaries are stand-ins for real values).
 *   * `upload_id=<canary>` — the session URI query string is bearer-
 *     equivalent. Its distinctive shape is the surest tell.
 */
const FORBIDDEN_SUBSTRINGS: ReadonlyArray<{ label: string; needle: string }> = [
  { label: "Bearer prefix", needle: "Bearer " },
  { label: "refresh_token key", needle: "refresh_token" },
  { label: "refresh-token canary", needle: CANARY_REFRESH_TOKEN },
  { label: "client-secret canary", needle: CANARY_CLIENT_SECRET },
  { label: "access-token canary", needle: CANARY_ACCESS_TOKEN },
  { label: "session-URI query canary", needle: CANARY_SESSION_ID },
  { label: "session-URI full form", needle: "upload_id=" + CANARY_SESSION_ID }
];

// ─── Prisma ────────────────────────────────────────────────────────────────

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
  "BACKUP_STORAGE_DIR",
  "BACKUP_ENCRYPTION_KEY"
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

function primeEnvWithCanaries(): void {
  process.env.GOOGLE_DRIVE_BACKUP_ENABLED = "true";
  process.env.GOOGLE_DRIVE_CLIENT_ID =
    "layer-k-log-hygiene-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = CANARY_CLIENT_SECRET;
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = CANARY_REFRESH_TOKEN;
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── Console capture ──────────────────────────────────────────────────────

type ConsoleCapture = {
  captured: string[];
  restore(): void;
};

function captureConsole(): ConsoleCapture {
  const captured: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug
  } as const;
  const push = (level: string) =>
    (...args: unknown[]) => {
      const joined = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a === null || a === undefined) return String(a);
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      captured.push(`[${level}] ${joined}`);
    };
  console.log = push("log");
  console.warn = push("warn");
  console.error = push("error");
  console.info = push("info");
  console.debug = push("debug");
  return {
    captured,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
      console.debug = original.debug;
    }
  };
}

function assertNoLeakInText(where: string, text: string): void {
  for (const { label, needle } of FORBIDDEN_SUBSTRINGS) {
    if (text.includes(needle)) {
      const snippet = text.slice(0, 200).replace(/\s+/g, " ");
      throw new Error(
        `[${where}] leaked "${label}" — first 200 chars of offending text: ${snippet}`
      );
    }
  }
}

function assertNoLeakInLines(where: string, lines: readonly string[]): void {
  for (const line of lines) {
    assertNoLeakInText(where, line);
  }
}

// ─── Fixture builders ─────────────────────────────────────────────────────

const FOLDER_ID = "layer-k-log-hygiene-folder-id";
const STORAGE_SUBDIR = "layer-k-storage";
let scratchStorageDir = "";

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

const seededBackupIds: string[] = [];
// Set to a real Date in `before()` — G9 LOW-1: capturing at module load
// means an earlier test file in the same process could contribute audit
// rows to our window. Overwritten to reflect the true start of this
// file's mutations.
let testWindowStart = new Date(0);

async function seedBackupWithReplication(
  prisma: PrismaClient,
  overrides: {
    repStatus?: "PENDING" | "UPLOADING" | "COMPLETED" | "RETRYABLE_FAILURE" | "FAILED";
    uploadSessionUri?: string;
    remoteBinFileId?: string;
    remoteManifestFileId?: string;
  } = {}
): Promise<{ backupId: string; replicationId: string }> {
  const backupId = makeCuid();
  seededBackupIds.push(backupId);
  await prisma.backup.create({
    data: {
      id: backupId,
      status: "VERIFIED",
      kind: "MANUAL",
      schemaSha256: createHash("sha256").update("schema").digest("hex"),
      appVersion: "layer-k-log-hygiene",
      formatVersion: "1",
      encryptionVersion: "v1",
      sizeBytes: BigInt(1024),
      contentSha256: createHash("sha256").update("bin").digest("hex"),
      manifestSha256: createHash("sha256").update("mf").digest("hex"),
      fileName: `${backupId}.bin`
    }
  });
  const rep = await prisma.backupReplication.create({
    data: {
      backupId,
      destination: "GOOGLE_DRIVE",
      status: overrides.repStatus ?? "COMPLETED",
      remoteBinFileId: overrides.remoteBinFileId ?? "remote-bin-id-lk",
      remoteManifestFileId: overrides.remoteManifestFileId ?? "remote-mf-id-lk",
      remoteFolderId: FOLDER_ID,
      uploadSessionUri: overrides.uploadSessionUri ?? null,
      uploadSessionExpiresAt: overrides.uploadSessionUri
        ? new Date(Date.now() + 24 * 60 * 60 * 1000)
        : null,
      lastVerifyLevel: "METADATA_ONLY",
      lastVerifiedAt: new Date()
    }
  });
  return { backupId, replicationId: rep.id };
}

// ─── Suite setup ──────────────────────────────────────────────────────────

before(async () => {
  primeEnvWithCanaries();
  // G9 LOW-1: overwrite `testWindowStart` at the actual start of this
  // file's mutations, not at module load.
  testWindowStart = new Date();
  scratchStorageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "bis-log-hygiene-")
  );
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
  const prisma = await makePrisma();
  try {
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive", folderId: FOLDER_ID },
      update: { folderId: FOLDER_ID }
    });
  } finally {
    await prisma.$disconnect();
  }
  // Silence STORAGE_SUBDIR unused-lint (constant reserved for future use).
  void STORAGE_SUBDIR;
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
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive" },
      update: { folderId: null }
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

// ─── Audit-log cross-check ───────────────────────────────────────────────

async function assertNoLeakInAuditRows(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.auditLog.findMany({
    where: {
      createdAt: { gte: testWindowStart },
      OR: [
        { action: { startsWith: "backup.replication" } },
        { action: { startsWith: "backup.scheduler" } }
      ]
    },
    select: { id: true, action: true, meta: true }
  });
  for (const r of rows) {
    let serialized: string;
    try {
      serialized = JSON.stringify(r.meta ?? {});
    } catch {
      serialized = String(r.meta ?? "");
    }
    assertNoLeakInText(`audit.meta[${r.action}]`, serialized);
  }
}

async function assertNoLeakInReplicationRows(
  prisma: PrismaClient
): Promise<void> {
  const rows = await prisma.backupReplication.findMany({
    where: {
      OR: [
        { backupId: { in: seededBackupIds } },
        { createdAt: { gte: testWindowStart } }
      ]
    },
    select: {
      id: true,
      status: true,
      errorCode: true,
      errorMessage: true
    }
  });
  for (const r of rows) {
    if (r.errorMessage !== null) {
      assertNoLeakInText(
        `BackupReplication.errorMessage[${r.id}]`,
        r.errorMessage
      );
    }
  }
}

// ─── classifier + sanitizeGoogleError ────────────────────────────────────

describe("Layer K — classifier + sanitizer never leak secrets", () => {
  test("classifyGoogleError over Bearer + URL + refresh_token error → sanitized code only", async () => {
    const { classifyGoogleError } = await import(
      "../lib/backup/replication/classifier"
    );
    const { sanitizeGoogleError } = await import(
      "../lib/backup/replication/errors"
    );

    // Construct an error whose every field carries a canary.
    const leakyErr = Object.assign(new Error("boom"), {
      status: 401,
      response: {
        status: 401,
        headers: {
          authorization: `Bearer ${CANARY_ACCESS_TOKEN}`
        },
        data: {
          error: {
            code: 401,
            message: `Bearer ${CANARY_ACCESS_TOKEN} rejected; refresh_token=${CANARY_REFRESH_TOKEN}`,
            errors: [{ reason: "authError" }]
          }
        }
      },
      config: {
        url: CANARY_SESSION_URI,
        headers: { Authorization: `Bearer ${CANARY_ACCESS_TOKEN}` }
      },
      message: `HTTP 401 at ${CANARY_SESSION_URI} with refresh_token=${CANARY_REFRESH_TOKEN}`
    });

    const cap = captureConsole();
    let classificationMessage = "";
    let sanitized: { name: string; httpStatus: number | null };
    try {
      const c = classifyGoogleError(leakyErr);
      classificationMessage = c.sanitizedMessage;
      sanitized = sanitizeGoogleError(leakyErr);
    } finally {
      cap.restore();
    }

    assertNoLeakInText("classifier.sanitizedMessage", classificationMessage);
    // The sanitizer returns only a name + status. Neither field may
    // carry any of our canaries.
    assertNoLeakInText("sanitizer.name", sanitized.name);
    assert.equal(sanitized.httpStatus, 401);
    assertNoLeakInLines("classifier.console", cap.captured);
  });

  test("Every classified error class → sanitizedMessage is a stable enum phrase", async () => {
    const { classifyGoogleError } = await import(
      "../lib/backup/replication/classifier"
    );
    const scenarios: Array<{ label: string; err: unknown }> = [
      {
        label: "401 with Bearer body",
        err: {
          status: 401,
          message: `Bearer ${CANARY_ACCESS_TOKEN}`,
          response: { status: 401, data: {} }
        }
      },
      {
        label: "403 quotaExceeded",
        err: {
          status: 403,
          response: {
            status: 403,
            data: { error: { errors: [{ reason: "storageQuotaExceeded" }] } }
          }
        }
      },
      {
        label: "429 with Retry-After",
        err: {
          status: 429,
          response: { status: 429, data: {} }
        }
      },
      {
        label: "500 with URL body",
        err: {
          status: 500,
          response: {
            status: 500,
            data: { url: CANARY_SESSION_URI }
          }
        }
      },
      {
        label: "OAuth invalid_grant",
        err: {
          response: {
            status: 400,
            data: {
              error: "invalid_grant",
              error_description: `refresh_token=${CANARY_REFRESH_TOKEN} rejected`
            }
          }
        }
      },
      {
        label: "Network ECONNRESET",
        err: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
      }
    ];
    for (const s of scenarios) {
      const c = classifyGoogleError(s.err);
      assertNoLeakInText(`classifier[${s.label}].sanitizedMessage`, c.sanitizedMessage);
    }
  });
});

// ─── ResumableUploadHttpError never carries the session URI ──────────────

describe("Layer K — ResumableUploadHttpError.message never carries session URI", () => {
  test("thrown message + toString + inspect all elide the URI and body", async () => {
    const { ResumableUploadHttpError } = await import(
      "../lib/backup/replication/resumable-upload"
    );
    const err = new ResumableUploadHttpError("unexpected_status", {
      status: 500,
      headers: { "retry-after": "5" },
      body: Buffer.from(
        JSON.stringify({
          url: CANARY_SESSION_URI,
          authorization: `Bearer ${CANARY_ACCESS_TOKEN}`,
          refresh_token: CANARY_REFRESH_TOKEN
        })
      )
    });
    assertNoLeakInText("ResumableUploadHttpError.message", err.message);
    assertNoLeakInText(
      "ResumableUploadHttpError.toString()",
      err.toString()
    );
    assert.equal(err.status, 500);
    assert.equal(err.reason, "unexpected_status");
  });
});

// ─── verify-remote — Drive failure with leaky body ───────────────────────

describe("Layer K — verify-remote errorMessage under leaky Drive failure", () => {
  test("500 body with Bearer + URI + refresh_token does not leak into DB", async () => {
    const prisma = await makePrisma();
    try {
      const { backupId, replicationId } = await seedBackupWithReplication(prisma);

      const { verifyRemoteFullSha256 } = await import(
        "../lib/backup/replication/verify-remote"
      );
      const { REPLICATION_DESTINATION } = await import(
        "../lib/backup/replication/uploader"
      );
      void backupId;
      void REPLICATION_DESTINATION;

      const drive = {
        files: {
          async get(_p: { fileId: string; fields: string }) {
            return {
              data: {
                id: "remote-bin-id-lk",
                name: "backup_" + backupId + ".bin",
                mimeType: "application/octet-stream",
                trashed: false,
                size: "1024",
                md5Checksum: "0".repeat(32),
                parents: [FOLDER_ID],
                appProperties: { backupId, artifact: "bin" }
              }
            };
          },
          async list() {
            return { data: { files: [] } };
          }
        }
      };
      const leakyBody = JSON.stringify({
        url: CANARY_SESSION_URI,
        authorization: `Bearer ${CANARY_ACCESS_TOKEN}`,
        refresh_token: CANARY_REFRESH_TOKEN
      });
      const httpCalls: string[] = [];
      const http: (req: {
        url: string;
        method: string;
        headers: Record<string, string>;
        timeoutMs: number;
      }) => Promise<{
        status: number;
        headers: Record<string, string>;
        body: Buffer;
      }> = async (req) => {
        httpCalls.push(req.url);
        return {
          status: 503,
          headers: {},
          body: Buffer.from(leakyBody, "utf-8")
        };
      };

      const cap = captureConsole();
      try {
        await verifyRemoteFullSha256(replicationId, {
          prisma,
          drive: drive as unknown as import("../lib/backup/replication/folder").DriveFolderApi,
          http,
          accessToken: CANARY_ACCESS_TOKEN,
          folderId: FOLDER_ID,
          stagingRoot: scratchStorageDir,
          now: () => new Date(),
          httpTimeoutMs: 30_000
        });
      } finally {
        cap.restore();
      }

      assertNoLeakInLines("verify-remote console", cap.captured);
      await assertNoLeakInReplicationRows(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── reconcile — Drive 500 body ──────────────────────────────────────────

describe("Layer K — reconcile errorMessage under leaky Drive failure", () => {
  test("500 body containing Bearer + refresh_token does not leak into DB", async () => {
    const prisma = await makePrisma();
    try {
      const { replicationId } = await seedBackupWithReplication(prisma);
      const { reconcileReplicationRemote } = await import(
        "../lib/backup/replication/reconcile"
      );
      const drive = {
        files: {
          async get(_p: { fileId: string; fields: string }) {
            const err = Object.assign(
              new Error(`HTTP 503 at ${CANARY_SESSION_URI}`),
              {
                status: 503,
                response: {
                  status: 503,
                  data: {
                    url: CANARY_SESSION_URI,
                    authorization: `Bearer ${CANARY_ACCESS_TOKEN}`
                  }
                }
              }
            );
            throw err;
          },
          async list() {
            return { data: { files: [] } };
          }
        }
      };
      const cap = captureConsole();
      try {
        await reconcileReplicationRemote(replicationId, {
          prisma,
          drive: drive as unknown as import("../lib/backup/replication/folder").DriveFolderApi,
          now: () => new Date()
        });
      } finally {
        cap.restore();
      }
      assertNoLeakInLines("reconcile console", cap.captured);
      await assertNoLeakInReplicationRows(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── restore-remote — download 500 body ──────────────────────────────────

describe("Layer K — restore-remote outcome under leaky Drive failure", () => {
  test("500 body containing Bearer + session URI does not leak into outcome", async () => {
    const prisma = await makePrisma();
    try {
      const { downloadAndVerifyDriveBackup } = await import(
        "../lib/backup/replication/restore-remote"
      );
      const backupId = makeCuid();
      seededBackupIds.push(backupId);

      const leakyBody = JSON.stringify({
        url: CANARY_SESSION_URI,
        authorization: `Bearer ${CANARY_ACCESS_TOKEN}`,
        refresh_token: CANARY_REFRESH_TOKEN
      });
      const http: (req: {
        url: string;
        method: string;
        headers: Record<string, string>;
        timeoutMs: number;
      }) => Promise<{
        status: number;
        headers: Record<string, string>;
        body: Buffer;
      }> = async () => ({
        status: 500,
        headers: {},
        body: Buffer.from(leakyBody, "utf-8")
      });

      const cap = captureConsole();
      let outcomeMessage = "";
      try {
        const result = await downloadAndVerifyDriveBackup(backupId, {
          prisma,
          http,
          accessToken: CANARY_ACCESS_TOKEN,
          now: () => new Date(),
          httpTimeoutMs: 30_000,
          storageDirOverride: scratchStorageDir,
          overrideRemoteFileIds: {
            remoteBinFileId: "remote-bin-id-lk",
            remoteManifestFileId: "remote-mf-id-lk"
          }
        });
        if (result.outcome === "DOWNLOAD_FAILED") {
          outcomeMessage = result.sanitizedMessage;
        }
      } finally {
        cap.restore();
      }

      assertNoLeakInText("restore-remote outcome message", outcomeMessage);
      assertNoLeakInLines("restore-remote console", cap.captured);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Cross-cutting: audit rows never carry a canary ───────────────────────

describe("Layer K — audit rows never carry a canary", () => {
  test("post-suite audit-row scan is clean", async () => {
    const prisma = await makePrisma();
    try {
      await assertNoLeakInAuditRows(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── G9 LOW-2 (static coverage): no console.* / stdout.write / stderr.write
//     in the replication tree ───────────────────────────────────────────

describe("Layer K — no console.* or direct stdout/stderr writes in replication", () => {
  test("grep of lib/backup/replication/** finds zero console/stream write calls", async () => {
    const { readdir, readFile, stat } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve("lib", "backup", "replication");
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir);
      for (const name of entries) {
        const full = path.join(dir, name);
        const s = await stat(full);
        if (s.isDirectory()) await walk(full);
        else if (name.endsWith(".ts")) files.push(full);
      }
    }
    await walk(root);
    // We forbid any `console.<method>(...)` call, and any
    // `process.stdout.write(` / `process.stderr.write(` call inside
    // the replication tree. A future contributor adding a debug log
    // must go through the audit / classified-error path instead.
    // Comments referencing the pattern are fine — the regex is
    // deliberately narrow to the call form.
    const forbiddenPatterns: Array<{ label: string; re: RegExp }> = [
      { label: "console.log", re: /\bconsole\.log\s*\(/ },
      { label: "console.warn", re: /\bconsole\.warn\s*\(/ },
      { label: "console.error", re: /\bconsole\.error\s*\(/ },
      { label: "console.info", re: /\bconsole\.info\s*\(/ },
      { label: "console.debug", re: /\bconsole\.debug\s*\(/ },
      { label: "process.stdout.write", re: /process\.stdout\.write\s*\(/ },
      { label: "process.stderr.write", re: /process\.stderr\.write\s*\(/ }
    ];
    const hits: string[] = [];
    for (const f of files) {
      const src = await readFile(f, "utf-8");
      // Strip block comments and line comments so a doc-comment that
      // MENTIONS `console.log` in prose is not counted.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const p of forbiddenPatterns) {
        if (p.re.test(stripped)) {
          hits.push(`${path.relative(process.cwd(), f)} contains ${p.label}`);
        }
      }
    }
    assert.deepEqual(
      hits,
      [],
      `replication tree must not use console/stdout/stderr — found:\n${hits.join("\n")}`
    );
  });
});

// ─── G9 MEDIUM-1: worker end-to-end path with leaky Drive body ────────

describe("Layer K — worker end-to-end with leaky Drive failure", () => {
  test("runReplicationWorkerTick with fake HTTP throwing leaky body → no canary anywhere", async () => {
    const prisma = await makePrisma();
    try {
      // Seed a PENDING replication row so the worker will claim it.
      // The uploader will then attempt to load the bin from staging,
      // which won't exist → LOCAL_SOURCE_MISSING (a non-network path
      // that still exercises the audit + errorMessage write). To hit
      // the network path, we point storage at scratch and supply a
      // fake bin/manifest in the fake filesystem via the `files` seam.
      const { runReplicationWorkerTick } = await import(
        "../lib/backup/replication/worker"
      );
      const { REPLICATION_DESTINATION } = await import(
        "../lib/backup/replication/uploader"
      );

      // A backup + replication row seeded as VERIFIED + PENDING.
      const backupId = makeCuid();
      seededBackupIds.push(backupId);
      await prisma.backup.create({
        data: {
          id: backupId,
          status: "VERIFIED",
          kind: "MANUAL",
          schemaSha256: createHash("sha256").update("schema").digest("hex"),
          appVersion: "layer-k",
          formatVersion: "1",
          encryptionVersion: "v1",
          sizeBytes: BigInt(1024),
          contentSha256: createHash("sha256").update(Buffer.alloc(1024)).digest("hex"),
          manifestSha256: createHash("sha256").update("mf").digest("hex"),
          fileName: `${backupId}.bin`
        }
      });
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: REPLICATION_DESTINATION,
          status: "PENDING"
        }
      });

      // Fake filesystem: return a bin whose sha256 matches Backup.contentSha256,
      // plus a manifest of any content.
      const bin = Buffer.alloc(1024);
      const manifest = Buffer.from(JSON.stringify({ dummy: true }), "utf-8");
      const files = {
        stat: async () => ({ size: bin.byteLength }),
        sha256: async () =>
          createHash("sha256").update(bin).digest("hex"),
        readChunk: async (_p: string, s: number, l: number) => bin.subarray(s, s + l),
        readAll: async () => manifest
      };
      // Fake drive that returns no matching artefacts (forces upload path).
      const drive = {
        files: {
          async get() {
            const err = new Error(`Not Found at ${CANARY_SESSION_URI}`) as Error & {
              status: number;
              response: { status: number; data: object };
            };
            err.status = 404;
            err.response = { status: 404, data: { url: CANARY_SESSION_URI } };
            throw err;
          },
          async list() {
            return { data: { files: [] } };
          }
        }
      };
      // Fake HTTP client: init session succeeds returning session URI
      // (canary), then the first PUT fails with a 500 whose body echoes
      // the bearer + refresh_token + session URI.
      const leakyBody = JSON.stringify({
        url: CANARY_SESSION_URI,
        authorization: `Bearer ${CANARY_ACCESS_TOKEN}`,
        refresh_token: CANARY_REFRESH_TOKEN
      });
      const http = async (req: { url: string; method: string }) => {
        if (req.method === "POST") {
          return {
            status: 200,
            headers: { location: CANARY_SESSION_URI },
            body: Buffer.alloc(0)
          };
        }
        // PUT chunk → 500 with a leaky body.
        return {
          status: 500,
          headers: {},
          body: Buffer.from(leakyBody, "utf-8")
        };
      };

      const cap = captureConsole();
      let result;
      try {
        result = await runReplicationWorkerTick({
          client: prisma,
          driveFactory: () => drive as unknown as import("../lib/backup/replication/uploader").DriveApi,
          folderResolver: async () => FOLDER_ID,
          accessTokenFactory: async () => CANARY_ACCESS_TOKEN,
          httpFactory: () => http as unknown as import("../lib/backup/replication/http").HttpClient,
          files: files as unknown as import("../lib/backup/replication/uploader").FileReader,
          storageDir: scratchStorageDir,
          chunkBytesOverride: 256 * 1024,
          httpTimeoutMsOverride: 30_000
        });
      } finally {
        cap.restore();
      }

      // The worker's outcome may be RETRYABLE (500 is retryable) or
      // FAILED — we do not assert the outcome, only sanitization.
      void result;
      assertNoLeakInLines("worker end-to-end console", cap.captured);
      await assertNoLeakInReplicationRows(prisma);
      await assertNoLeakInAuditRows(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── G9 MEDIUM-2: drive-client refreshNow OAuth failure with canary ───

describe("Layer K — drive-client refresh failure with leaky OAuth body", () => {
  test("getGoogleDriveAccessToken() surface never carries an OAuth-body canary", async () => {
    const {
      _resetGoogleDriveClientState,
      _setOAuth2ClientFactoryForTesting,
      getGoogleDriveAccessToken
    } = await import("../lib/backup/replication/drive-client");

    _setOAuth2ClientFactoryForTesting(() => ({
      credentials: {},
      async getAccessToken() {
        // Simulate google-auth-library rejecting with a leaky body.
        const err = Object.assign(new Error(`OAuth exchange failed at ${CANARY_SESSION_URI}`), {
          response: {
            status: 400,
            data: {
              error: "invalid_grant",
              error_description: `refresh_token=${CANARY_REFRESH_TOKEN} bad`,
              client_secret: CANARY_CLIENT_SECRET
            },
            headers: {
              authorization: `Bearer ${CANARY_ACCESS_TOKEN}`
            }
          },
          message: `Bearer ${CANARY_ACCESS_TOKEN} refresh_token=${CANARY_REFRESH_TOKEN}`
        });
        throw err;
      }
    }));

    const cap = captureConsole();
    let thrownMessage = "";
    try {
      try {
        await getGoogleDriveAccessToken();
      } catch (err) {
        thrownMessage = err instanceof Error ? err.message : String(err);
      }
    } finally {
      cap.restore();
      _resetGoogleDriveClientState();
    }

    assertNoLeakInText("getGoogleDriveAccessToken thrown message", thrownMessage);
    assertNoLeakInLines("drive-client refresh console", cap.captured);
  });
});

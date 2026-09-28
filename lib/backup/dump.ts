import "server-only";

import { promises as fs, constants as fsConstants } from "fs";
import { createHash } from "crypto";
import path from "path";
import { PrismaClient, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";

import {
  loadBackupSubkeys,
  wipeSubkeys,
  createBackupEncryptStream,
  createContentDigest,
  IV_BYTES,
  TAG_BYTES
} from "./crypto";
import {
  openStagingWriteStream,
  writeStagingManifest,
  fsyncStaging,
  promoteFromStaging,
  deleteStaging,
  deletePublishedBackup
} from "./storage";
import {
  buildSignedManifest,
  MANIFEST_VERSION,
  type ManifestInput
} from "./manifest";
import {
  MODEL_ORDER,
  assertModelCoverage,
  delegateFor,
  type BackupModelName
} from "./model-order";
import { coerceRow, serializeRecord } from "./serializer";

// ─── Backup dump engine ─────────────────────────────────────────────────────
//
// SINGLE PUBLIC ENTRY POINT: `runBackupDump`. Callers never construct the
// pipeline by hand — this is deliberate (INFO-4 in the Phase 0-3 gate
// review): missing the tag-append or fsync step from an ad-hoc call site
// would silently produce an unrestorable backup. Every backup goes
// through this exact sequence.
//
// ORCHESTRATOR INVARIANT (INFO-6 in the gate review):
// A backup ONLY reaches `status = COMPLETED` after:
//   1. Every source row was read inside a REPEATABLE READ transaction.
//   2. Every row was successfully coerced + serialized + encrypted.
//   3. The GCM auth tag was appended to the on-disk file.
//   4. `fsync` returned success on the file.
//   5. A signed manifest was written to staging (also fsynced).
//   6. Both files were atomically promoted from staging to published.
//   7. The row's DB update to COMPLETED committed.
// Any failure at ANY of these steps leaves the row in `FAILED` (or
// `RUNNING` if the process died) — never `COMPLETED`.
//
// FILE LAYOUT of the .bin (see crypto.ts):
//   [12-byte IV][ciphertext of NDJSON stream][16-byte GCM tag]
//
// NDJSON stream shape (before encryption):
//   {"__meta":{...}}
//   {"__row":{"model":"Event","data":{...}}}
//   ...
//   {"__end":{"rowCounts":{...},"totalRows":N}}

const FORMAT_VERSION = "1";
const ENCRYPTION_VERSION = "v1";
const CURSOR_BATCH = 500;

// Prisma default interactive-transaction timeout is 5 seconds — nowhere
// near enough for a full dump. Ceiling has been intentionally lowered
// to 30 min (was 1h in an early draft) because a longer hold risks
// starving the shared Prisma pool AND many managed Postgres providers
// (Supabase, Neon, RDS) impose `idle_in_transaction_session_timeout`
// well under 1h and will kill the txn silently. If an operator needs
// longer, they set BACKUP_DUMP_TIMEOUT_MS explicitly and accept the
// trade-off; the ceiling is 2h.
const DEFAULT_DUMP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_DUMP_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIN_DUMP_TIMEOUT_MS = 60 * 1000; // 1 minute
const DEFAULT_DUMP_MAX_WAIT_MS = 5_000;

function loadDumpTimeoutMs(): number {
  const raw = process.env.BACKUP_DUMP_TIMEOUT_MS;
  if (!raw) return DEFAULT_DUMP_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_DUMP_TIMEOUT_MS || n > MAX_DUMP_TIMEOUT_MS) {
    // Refuse absurd values silently — fail closed to the default.
    return DEFAULT_DUMP_TIMEOUT_MS;
  }
  return Math.floor(n);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface RunBackupDumpOptions {
  /** MANUAL | SCHEDULED | SAFETY */
  kind: "MANUAL" | "SCHEDULED" | "SAFETY";
  /** AdminUser.id for MANUAL/SAFETY (NULL for SCHEDULED). */
  createdById?: string | null;
  /** Optional Prisma client (tests inject a scratch DB). */
  client?: PrismaClient;
  /**
   * Optional pre-generated backup id — TEST ONLY. Runtime-gated to
   * `NODE_ENV=test`. Production code MUST NOT pass this: doing so would
   * let a caller plant a specific filename in staging/published.
   */
  overrideBackupId?: string;
}

const CUID_RE = /^c[a-z0-9]{24}$/;

export interface RunBackupDumpResult {
  backupId: string;
  sizeBytes: number;
  rowCounts: Record<string, number>;
  totalRows: number;
  contentSha256: string;
}

export class BackupDumpError extends Error {
  constructor(
    message: string,
    public readonly backupId?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "BackupDumpError";
  }
}

/**
 * Orchestrate a full encrypted database dump. See file header for the
 * full invariant list. On success, a row exists in the `Backup` table
 * with `status = COMPLETED` and every integrity anchor populated. On
 * any failure, the row is `FAILED` and the staging file has been
 * removed — the on-disk `published/` directory is untouched.
 */
export async function runBackupDump(
  opts: RunBackupDumpOptions
): Promise<RunBackupDumpResult> {
  const client = opts.client ?? prisma;

  // Runtime gate on the test-only escape hatch. Passing this in prod
  // is a bug — refuse rather than silently allow a caller-controlled
  // filename to land in staging/published.
  if (opts.overrideBackupId !== undefined) {
    if (process.env.NODE_ENV !== "test") {
      throw new BackupDumpError(
        "overrideBackupId is a test-only option and must not be used outside NODE_ENV=test."
      );
    }
    if (!CUID_RE.test(opts.overrideBackupId)) {
      throw new BackupDumpError("overrideBackupId must be a cuid.");
    }
  }

  // Defence-in-depth on the FK: server actions in Phase 6+ already
  // resolve this from `requirePermission(...)`; catching a stray value
  // here (empty string, email, etc.) surfaces the bug immediately
  // rather than as an opaque Postgres FK violation whose message we
  // now scrub for PII.
  if (
    opts.createdById !== undefined &&
    opts.createdById !== null &&
    !CUID_RE.test(opts.createdById)
  ) {
    throw new BackupDumpError("createdById must be a cuid or null.");
  }

  // Fail-fast on schema drift. This forces a developer who added a new
  // model to classify it BEFORE the next backup runs — no silent skip.
  assertModelCoverage();

  // Load subkeys UP FRONT so a missing/malformed BACKUP_ENCRYPTION_KEY
  // fails the backup before we've touched the DB row.
  const subkeys = loadBackupSubkeys();

  let backupId: string | null = null;
  try {
    // Read schema.prisma up front — we need its hash + text for the
    // manifest. Doing it now (before the DB row is created) means a
    // filesystem error surfaces immediately.
    const { schemaPrisma, schemaSha256 } = await readSchemaSnapshot();
    const appVersion = await readAppVersion();

    // Create the row (PENDING). If a scheduler / manual trigger races
    // on the tick endpoint, the row-lock is Phase 8's responsibility;
    // this file is agnostic.
    const row = await client.backup.create({
      data: {
        id: opts.overrideBackupId, // undefined → cuid default
        status: "PENDING",
        kind: opts.kind,
        schemaSha256,
        appVersion,
        formatVersion: FORMAT_VERSION,
        encryptionVersion: ENCRYPTION_VERSION,
        createdById: opts.createdById ?? null
      },
      select: { id: true, startedAt: true }
    });
    backupId = row.id;

    // Immediately promote to RUNNING so a concurrent tick that checks
    // for in-progress backups sees this one.
    await client.backup.update({
      where: { id: backupId },
      data: { status: "RUNNING" }
    });

    // Open the staging write stream and start the crypto pipeline.
    const { stream: writeStream } = await openStagingWriteStream(backupId);
    const encStream = createBackupEncryptStream(subkeys.encKey);
    const digest = createContentDigest();

    // Track the count of bytes written to disk so `sizeBytes` in the
    // manifest matches the file's real size exactly.
    let sizeBytes = 0;

    // Persistent latch for stream errors — checked at every drain point.
    // Attaching a per-await 'error' listener would leak listeners in a
    // long dump (MaxListenersExceeded on batch >10 writes). This single
    // listener is enough.
    let writeStreamError: Error | null = null;
    writeStream.on("error", (err) => {
      writeStreamError = err;
    });

    // Write a chunk to disk AND feed the content digest at the same time.
    // Uses `once('drain')` for backpressure, and re-checks the latch.
    const writeAndHash = async (chunk: Buffer): Promise<void> => {
      if (writeStreamError) throw writeStreamError;
      digest.push(chunk);
      sizeBytes += chunk.length;
      if (!writeStream.write(chunk)) {
        await new Promise<void>((resolve) => writeStream.once("drain", resolve));
        if (writeStreamError) throw writeStreamError;
      }
    };

    // Encryption pipeline: NDJSON bytes → encStream.transform → we
    // consume the encStream output chunks and push to writeAndHash.
    // We drive the encStream by writing plaintext into it and
    // consuming its `data` events. Same persistent-latch pattern as
    // the write stream to avoid listener leaks.
    const encChunks: Buffer[] = [];
    let encStreamError: Error | null = null;
    encStream.transform.on("data", (c: Buffer) => encChunks.push(c));
    encStream.transform.on("error", (err) => {
      encStreamError = err;
    });

    const drainEnc = async (): Promise<void> => {
      for (const c of encChunks.splice(0)) {
        await writeAndHash(c);
      }
    };

    // Write the IV FIRST (unencrypted) as the file header.
    await writeAndHash(encStream.iv);

    // Feed plaintext through the encStream. Backpressure-aware.
    const feedPlaintext = async (line: string): Promise<void> => {
      if (encStreamError) throw encStreamError;
      const buf = Buffer.from(line, "utf8");
      if (!encStream.transform.write(buf)) {
        await new Promise<void>((resolve) => encStream.transform.once("drain", resolve));
        if (encStreamError) throw encStreamError;
      }
      await drainEnc();
    };

    // Row counts start empty and are populated as we go — MUST match the
    // final __end record and the manifest.
    const rowCounts: Record<string, number> = {};
    let totalRows = 0;
    const createdAt = row.startedAt;

    // ── Meta record ─────────────────────────────────────────────────
    await feedPlaintext(
      serializeRecord({
        __meta: {
          formatVersion: FORMAT_VERSION,
          encryptionVersion: ENCRYPTION_VERSION,
          manifestVersion: MANIFEST_VERSION,
          backupId,
          createdAt: createdAt.toISOString(),
          kind: opts.kind,
          appVersion,
          schemaSha256,
          modelOrder: [...MODEL_ORDER]
        }
      })
    );

    // ── The 30-model dump inside REPEATABLE READ ────────────────────
    //
    // We do the actual reads inside `client.$transaction([...])` array
    // form? No — that requires all queries to be built up-front. We
    // need INTERACTIVE transactions (callback form) to iterate cursors
    // and stream. Prisma supports this with:
    //     client.$transaction(async (tx) => { ... },
    //       { isolationLevel: 'RepeatableRead', timeout, maxWait })
    //
    // The callback returns after ALL streaming is complete AND the
    // encStream has been end()-ed. We stream inside the callback and
    // ONLY commit after the last chunk lands on disk.

    await client.$transaction(
      async (tx) => {
        for (const modelName of MODEL_ORDER) {
          const n = await dumpModel(tx, modelName, feedPlaintext);
          rowCounts[modelName] = n;
          totalRows += n;
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: loadDumpTimeoutMs(),
        maxWait: DEFAULT_DUMP_MAX_WAIT_MS
      }
    );

    // ── End record ──────────────────────────────────────────────────
    await feedPlaintext(
      serializeRecord({
        __end: { rowCounts, totalRows }
      })
    );

    // Close the encryption stream, forcing cipher.final() and any
    // remaining ciphertext bytes out through the transform.
    encStream.transform.end();
    await new Promise<void>((resolve, reject) => {
      encStream.transform.once("end", () => resolve());
      // The persistent error latch was already installed above; also
      // reject here in case an error fires between end() and 'end'.
      const check = () => {
        if (encStreamError) reject(encStreamError);
      };
      encStream.transform.once("close", check);
      check();
    });
    if (encStreamError) throw encStreamError;
    await drainEnc();

    // Append the 16-byte GCM tag as the file trailer.
    const tag = encStream.finalize();
    if (tag.length !== TAG_BYTES) {
      throw new BackupDumpError(
        `Unexpected GCM tag length ${tag.length}, expected ${TAG_BYTES}.`,
        backupId
      );
    }
    await writeAndHash(tag);

    // Close the write stream and wait for `finish`. From this point
    // the underlying FileHandle is closed by autoClose:true.
    await new Promise<void>((resolve, reject) => {
      if (writeStreamError) {
        reject(writeStreamError);
        return;
      }
      writeStream.once("finish", () => {
        if (writeStreamError) reject(writeStreamError);
        else resolve();
      });
      writeStream.end();
    });
    if (writeStreamError) throw writeStreamError;

    // fsync the .bin so a crash between here and promote does not lose
    // the payload we just wrote. See storage.ts::fsyncStaging.
    await fsyncStaging(backupId);

    // Compute the content digest now that all bytes are through it.
    const contentSha256 = digest.digest();

    // Sanity: written bytes = IV (12) + ciphertext + tag (16). If they
    // don't add up, our accounting has a bug — refuse to publish.
    if (sizeBytes < IV_BYTES + TAG_BYTES) {
      throw new BackupDumpError(
        `Impossibly small backup file (${sizeBytes} bytes) — refusing to publish.`,
        backupId
      );
    }

    // Build the signed manifest.
    const manifestInput: ManifestInput = {
      backupId,
      createdAt,
      kind: opts.kind,
      appVersion,
      formatVersion: FORMAT_VERSION,
      encryptionVersion: ENCRYPTION_VERSION,
      contentSha256,
      schemaSha256,
      schemaPrisma,
      sizeBytes,
      rowCounts
    };
    const manifestBytes = buildSignedManifest(subkeys.hmacKey, manifestInput);
    const manifestSha256 = sha256Hex(manifestBytes);

    // Write manifest to staging (fsynced inside writeStagingManifest).
    await writeStagingManifest(backupId, manifestBytes);

    // Atomically promote both files. If this throws, the .bin is
    // rolled back to staging (see storage.ts) and the row goes FAILED.
    await promoteFromStaging(backupId);

    // Finally: mark COMPLETED. From THIS instant, the backup is valid.
    await client.backup.update({
      where: { id: backupId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        sizeBytes: BigInt(sizeBytes),
        fileName: `${backupId}.bin`,
        contentSha256,
        manifestSha256,
        rowCounts: rowCounts as Prisma.InputJsonValue
      }
    });

    return { backupId, sizeBytes, rowCounts, totalRows, contentSha256 };
  } catch (err) {
    // Failure recovery path — best-effort. Row → FAILED (if we ever
    // created it); staging files removed. Never rethrow the cleanup
    // failure; always surface the ORIGINAL error to the caller.
    if (backupId) {
      await client.backup
        .update({
          where: { id: backupId },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            // PII-safe summary — see safeErrorSummary. Never store raw
            // Prisma error messages (they include field values that
            // could contain user PII).
            errorMessage: safeErrorSummary(err)
          }
        })
        .catch(() => undefined);
      await deleteStaging(backupId).catch(() => undefined);
      // Belt-and-braces: if we made it past the atomic promote (i.e.
      // published/ has the .bin+manifest) BEFORE crashing, clean those
      // up too so an orphaned pair doesn't confuse the reconciliation
      // sweep. Cheap and safe — deletePublishedBackup is idempotent.
      await deletePublishedBackup(backupId).catch(() => undefined);
    }
    if (err instanceof BackupDumpError) throw err;
    throw new BackupDumpError(
      `Backup dump failed: ${errorMessageOf(err)}`,
      backupId ?? undefined,
      err
    );
  } finally {
    // Best-effort key wipe. Documented as best-effort in crypto.ts.
    wipeSubkeys(subkeys);
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

async function dumpModel(
  tx: Prisma.TransactionClient,
  modelName: BackupModelName,
  feed: (line: string) => Promise<void>
): Promise<number> {
  const delegate = delegateFor(tx, modelName);
  const strategy = paginationStrategy(modelName);
  let count = 0;

  if (strategy.kind === "keyset") {
    // Keyset pagination on a single-column primary key. O(1) per batch
    // vs. the O(n²) behaviour of skip/take on large tables.
    let cursor: string | undefined = undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows: Array<Record<string, unknown>> = await delegate.findMany({
        take: CURSOR_BATCH,
        ...(cursor !== undefined
          ? { cursor: { [strategy.keyField]: cursor }, skip: 1 }
          : {}),
        orderBy: { [strategy.keyField]: "asc" } as never
      });
      for (const row of rows) {
        const line = serializeRecord({
          __row: {
            model: modelName,
            data: coerceRow(row as Record<string, unknown>)
          }
        });
        await feed(line);
        count += 1;
      }
      if (rows.length < CURSOR_BATCH) break;
      const last = rows[rows.length - 1] as Record<string, unknown>;
      const nextCursor = last[strategy.keyField];
      if (typeof nextCursor !== "string") {
        // Cursor value must be a string (all our key columns are `text`
        // in Postgres — Prisma maps them to string). If not, safer to
        // stop than to loop forever.
        break;
      }
      cursor = nextCursor;
    }
  } else {
    // Composite-PK tables (SessionSpeaker, ParticipantAccess,
    // AccessPointTeamMember). Row counts are tiny at this project's
    // scale (join tables between event entities); skip/take is
    // acceptable and simpler than a keyset predicate on 2 columns.
    let skip = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows: Array<Record<string, unknown>> = await delegate.findMany({
        take: CURSOR_BATCH,
        skip,
        orderBy: strategy.orderBy as never
      });
      for (const row of rows) {
        const line = serializeRecord({
          __row: {
            model: modelName,
            data: coerceRow(row as Record<string, unknown>)
          }
        });
        await feed(line);
        count += 1;
      }
      if (rows.length < CURSOR_BATCH) break;
      skip += rows.length;
    }
  }
  return count;
}

/**
 * Pagination strategy per model. Single-PK tables use keyset (O(1) per
 * batch); composite-PK tables use skip/take (fine for join tables which
 * are small in practice).
 */
type PaginationStrategy =
  | { kind: "keyset"; keyField: string }
  | { kind: "offset"; orderBy: unknown };

function paginationStrategy(modelName: BackupModelName): PaginationStrategy {
  switch (modelName) {
    case "SessionSpeaker":
      return {
        kind: "offset",
        orderBy: [{ sessionId: "asc" }, { speakerId: "asc" }]
      };
    case "ParticipantAccess":
      return {
        kind: "offset",
        orderBy: [{ participantId: "asc" }, { accessPointId: "asc" }]
      };
    case "AccessPointTeamMember":
      return {
        kind: "offset",
        orderBy: [{ accessPointId: "asc" }, { adminUserId: "asc" }]
      };
    case "SiteContent":
      return { kind: "keyset", keyField: "key" };
    default:
      return { kind: "keyset", keyField: "id" };
  }
}

// Hard cap so a corrupted or replaced schema file cannot balloon memory.
// The manifest zod schema enforces the same cap after the read.
const MAX_SCHEMA_BYTES = 512 * 1024;
const HAS_O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number";

async function readSchemaSnapshot(): Promise<{ schemaPrisma: string; schemaSha256: string }> {
  const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
  // Open with O_NOFOLLOW on POSIX for symmetry with the storage layer —
  // if an attacker with repo-write access has symlinked schema.prisma
  // elsewhere, we refuse to embed a rehosted file into the manifest.
  const flags = fsConstants.O_RDONLY | (HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
  const handle = await fs.open(schemaPath, flags);
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_SCHEMA_BYTES) {
      throw new BackupDumpError(
        `prisma/schema.prisma is ${stat.size} bytes; max embed size is ${MAX_SCHEMA_BYTES}.`
      );
    }
    const buf = Buffer.alloc(stat.size);
    await handle.read(buf, 0, stat.size, 0);
    const schemaPrisma = buf.toString("utf8");
    const schemaSha256 = sha256Hex(buf);
    return { schemaPrisma, schemaSha256 };
  } finally {
    await handle.close();
  }
}

async function readAppVersion(): Promise<string> {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Extract a full-fidelity message for THROWING to the caller. May
 * contain PII (Prisma unique-constraint errors embed field values,
 * validation errors embed the offending value, etc.). Never persist
 * this to the DB or to logs — use `safeErrorSummary` for that.
 */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * PII-safe error summary for `Backup.errorMessage`. Prisma error
 * messages include row values (P2002 → conflicting field values,
 * P2000 → the truncated value); those must NEVER land in a table any
 * admin can read via the UI. This function whitelists known error
 * shapes and reduces everything else to `<ErrorName>: <static text>`.
 *
 * On Prisma known-request errors, we emit `{ code, model, target }` —
 * enough to diagnose without leaking values. On our own domain errors
 * (BackupCryptoConfigError, BackupSerializerError, BackupDumpError,
 * BackupStorageError, BackupConfigError, ManifestParseError,
 * ManifestHmacError), the messages are code-authored and known-safe.
 */
function safeErrorSummary(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as {
      name?: string;
      code?: unknown;
      message?: unknown;
      constructor?: { name?: string };
      meta?: { modelName?: unknown; target?: unknown; field_name?: unknown };
    };
    const name = anyErr.name ?? anyErr.constructor?.name ?? "Error";

    // Prisma known-request errors expose a `code` (P2xxx). Their raw
    // message contains values — DO NOT include it. Emit code + model +
    // target only.
    if (typeof anyErr.code === "string" && /^P\d{4}$/.test(anyErr.code)) {
      const parts = [name, String(anyErr.code)];
      const m = anyErr.meta;
      if (m) {
        if (typeof m.modelName === "string") parts.push(`model=${m.modelName}`);
        if (typeof m.target === "string") parts.push(`target=${m.target}`);
        if (Array.isArray(m.target)) parts.push(`target=${m.target.join(",")}`);
        if (typeof m.field_name === "string") parts.push(`field=${m.field_name}`);
      }
      return parts.join(" ");
    }

    // Our own domain errors — messages are code-authored, no user
    // values interpolated. Safe to include verbatim (truncated).
    const SAFE_ERROR_NAMES = new Set([
      "BackupCryptoConfigError",
      "BackupSerializerError",
      "BackupDumpError",
      "BackupStorageError",
      "BackupConfigError",
      "ManifestParseError",
      "ManifestHmacError"
    ]);
    if (SAFE_ERROR_NAMES.has(name) && typeof anyErr.message === "string") {
      return truncate(`${name}: ${anyErr.message}`, 500);
    }

    // Everything else: name only.
    return `${name} (details suppressed to avoid PII leak)`;
  }
  return "Unknown error (details suppressed to avoid PII leak)";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

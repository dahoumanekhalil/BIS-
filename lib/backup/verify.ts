import "server-only";

import { promises as fs, constants as fsConstants, createReadStream } from "fs";
import { createHash } from "crypto";
import path from "path";
import { pipeline } from "stream/promises";
import { Writable } from "stream";
import { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/db";

import {
  loadBackupSubkeys,
  wipeSubkeys,
  createBackupDecryptStream,
  IV_BYTES,
  TAG_BYTES,
  BackupCryptoConfigError
} from "./crypto";
import {
  openPublishedReadStream,
  readPublishedManifest,
  statPublishedBackup,
  publishedBackupExists,
  assertValidBackupId,
  BackupStorageError
} from "./storage";
import {
  parseAndVerifyManifest,
  ManifestParseError,
  ManifestHmacError,
  MANIFEST_VERSION,
  type Manifest
} from "./manifest";
import { MODEL_ORDER, type BackupModelName } from "./model-order";
import { decodeRow, BackupSerializerError } from "./serializer";

// ─── Backup verification engine (Phase 5) ───────────────────────────────────
//
// Given a backup ID, run every check needed to attest that:
//   1. The on-disk artefacts (bin + manifest) belong together and haven't
//      been swapped, tampered, truncated, or replaced during verification.
//   2. The manifest is authentic (HMAC-signed with the derived hmacKey).
//   3. The ciphertext is authentic (AES-256-GCM tag verifies) AND matches
//      the fast-lane sha256 recorded in the manifest.
//   4. The decrypted NDJSON is structurally sound and covers exactly the
//      models the backup format declares.
//   5. The per-model row counts and total row count are internally
//      consistent (embedded __end record ↔ computed ↔ manifest).
//   6. The Backup DB row (if present) agrees with the manifest on every
//      security-sensitive integrity anchor.
//
// SECURITY chain (authoritative):
//
//   Encrypted payload
//        ├── AES-256-GCM authentication (during decrypt)
//        └── SHA-256 content digest (fast pre-decrypt integrity check)
//                        │
//                        ↓
//                    Manifest
//                        │
//                        └── HMAC-SHA256 (authenticates every field, incl.
//                            the contentSha256 anchor above)
//
// SHA-256 alone does NOT authenticate a backup — it is a digest. The
// authentication chain requires the manifest HMAC to establish trust in
// `contentSha256`, and the manifest HMAC in turn is anchored to the
// derived hmacKey from `BACKUP_ENCRYPTION_KEY`.
//
// NEVER trust security-sensitive manifest fields before HMAC verification
// succeeds. In particular: `backupId`, `contentSha256`, `schemaSha256`,
// `formatVersion`, `encryptionVersion`, `rowCounts`, `sizeBytes`.
//
// STAGE ORDER (see §3 of the phase spec):
//   1  STORAGE_IDENTITY      cuid shape, file exists, initial stat
//   2  MANIFEST_READ         bounded-size read of manifest JSON
//   3  MANIFEST_PARSE        zod schema + version check
//   4  MANIFEST_HMAC         HMAC-SHA256 verify
//   5  BACKUP_ID_CROSSCHECK  filename ID === manifest.backupId (HIGH-1)
//   6  DB_METADATA           row (if any) agrees with manifest
//   7  CONTENT_DIGEST        streaming sha256 == manifest.contentSha256
//   8  ENVELOPE              size >= IV+TAG; encryptionVersion supported
//   9  DECRYPTION            AES-256-GCM auth via decipher.final()
//   10 META                  __meta record cross-checks manifest fields
//   11 NDJSON                well-formed, single __meta, single __end
//   12 MODEL_COVERAGE        every __row.model in MODEL_ORDER
//   13 ROW_COUNTS            computed ↔ __end ↔ manifest
//   14 SERIALIZER            $-wrapped values decode without error
//   15 RACE_DETECT           final stat matches initial (size, mtime)
//   16 SCHEMA_COMPATIBILITY  informational — sets result.schemaCompatible
//
// Verification is streaming: no decrypted bytes are held in memory beyond
// one NDJSON line at a time, no ciphertext beyond a few KB at a time.
// Every reader is capped so a malicious or corrupted file cannot exhaust
// process memory.

const MAX_MANIFEST_BYTES = 1024 * 1024; // 1 MB — INFO-11
const MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024; // 8 MB per row
const MAX_TOTAL_ROWS = 100_000_000; // safety upper bound
const MAX_BIN_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB safety upper bound
const SUPPORTED_FORMAT_VERSION = "1";
const SUPPORTED_ENCRYPTION_VERSION = "v1";
const NEWLINE = 0x0a;

const MODEL_SET = new Set<string>(MODEL_ORDER);

// ─── Public API ─────────────────────────────────────────────────────────────

export type VerifyStage =
  | "STORAGE_IDENTITY"
  | "MANIFEST_READ"
  | "MANIFEST_PARSE"
  | "MANIFEST_HMAC"
  | "BACKUP_ID_CROSSCHECK"
  | "DB_METADATA"
  | "CONTENT_DIGEST"
  | "ENVELOPE"
  | "DECRYPTION"
  | "META"
  | "NDJSON"
  | "MODEL_COVERAGE"
  | "ROW_COUNTS"
  | "SERIALIZER"
  | "RACE_DETECT"
  | "SCHEMA_COMPATIBILITY";

export type VerifyFailureCode =
  | "INVALID_BACKUP_ID"
  | "STORAGE_MISSING"
  | "STORAGE_ERROR"
  | "SIZE_MISMATCH"
  | "MANIFEST_OVERSIZED"
  | "MANIFEST_UNREADABLE"
  | "MANIFEST_INVALID"
  | "MANIFEST_HMAC_INVALID"
  | "FORMAT_UNSUPPORTED"
  | "BACKUP_ID_MISMATCH"
  | "DB_METADATA_MISMATCH"
  | "CONTENT_DIGEST_MISMATCH"
  | "ENVELOPE_INVALID"
  | "DECRYPTION_FAILED"
  | "META_INVALID"
  | "FORMAT_INVALID"
  | "MODEL_COVERAGE_INVALID"
  | "ROW_COUNT_MISMATCH"
  | "SERIALIZER_INVALID"
  | "FILE_MUTATED"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "CRYPTO_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type VerifyOutcome = "VERIFIED" | "FAILED";

export interface VerifyBackupOptions {
  backupId: string;
  /** Prisma client override (tests). */
  client?: PrismaClient;
  /**
   * Compare the manifest against the persisted Backup row (default: true).
   * Set false only when verifying a bare on-disk artefact (e.g., a
   * disaster-recovery drill where the DB has already been wiped).
   */
  compareDb?: boolean;
  /**
   * Persist the verification result to the Backup row (verifiedAt,
   * verifiedById, verifyResult, status). Default: true.
   */
  persist?: boolean;
  /** AdminUser.id to record as `verifiedById` when persisting. */
  verifiedById?: string | null;
}

export interface VerifyResult {
  outcome: VerifyOutcome;
  backupId: string;
  code: VerifyFailureCode | "OK";
  stage: VerifyStage;
  /** Safe, static message. NEVER contains PII or key material. */
  detail?: string;
  durationMs: number;
  contentSha256?: string;
  sizeBytes?: number;
  totalRows?: number;
  rowCounts?: Record<string, number>;
  /**
   * Only populated when verification reaches the schema-compatibility
   * stage (i.e., all cryptographic + structural checks passed). Set to
   * `true` when the manifest's schemaSha256 matches the current on-disk
   * `prisma/schema.prisma`. A `false` here means the backup is
   * cryptographically valid but restore requires an explicit
   * schema-mismatch override — it does NOT mean the backup is corrupt.
   */
  schemaCompatible?: boolean;
  formatVersion?: string;
  encryptionVersion?: string;
}

/**
 * Precise verification error used internally to surface stage + code
 * together. NEVER contains sensitive values in `detail` — the string is
 * a code-authored constant or a well-known enum-like fragment.
 */
export class BackupVerifyError extends Error {
  constructor(
    public readonly code: VerifyFailureCode,
    public readonly stage: VerifyStage,
    public readonly detail: string
  ) {
    super(`[${stage}] ${code}: ${detail}`);
    this.name = "BackupVerifyError";
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Run all verification stages against a published backup. On success the
 * result carries per-model row counts, the (re-computed) contentSha256,
 * and a `schemaCompatible` boolean. On any failure the result carries a
 * discriminating code+stage, never a raw exception message.
 */
export async function verifyBackup(opts: VerifyBackupOptions): Promise<VerifyResult> {
  const start = Date.now();
  const client = opts.client ?? prisma;
  const compareDb = opts.compareDb !== false;
  const persist = opts.persist !== false;

  // Immediately validate the ID shape — refuse to persist ANY result for
  // an invalid ID; we do not want an attacker-supplied ID to leak into
  // a Backup row via UPDATE. Also produce a fail-closed result.
  try {
    assertValidBackupId(opts.backupId);
  } catch {
    return finish({
      outcome: "FAILED",
      backupId: String(opts.backupId ?? "").slice(0, 32),
      code: "INVALID_BACKUP_ID",
      stage: "STORAGE_IDENTITY",
      detail: "backup id must match /^c[a-z0-9]{24}$/",
      start
    });
  }

  let subkeys: { encKey: Buffer; hmacKey: Buffer } | null = null;
  try {
    // Load subkeys up-front. A missing/malformed key is a config error,
    // not a verification result — but the caller wants a stable result
    // shape, so we translate to CRYPTO_UNAVAILABLE (distinct code).
    try {
      subkeys = loadBackupSubkeys();
    } catch (err) {
      if (err instanceof BackupCryptoConfigError) {
        return finish({
          outcome: "FAILED",
          backupId: opts.backupId,
          code: "CRYPTO_UNAVAILABLE",
          stage: "MANIFEST_HMAC",
          detail: "BACKUP_ENCRYPTION_KEY is not configured or is malformed",
          start
        });
      }
      throw err;
    }

    const result = await runStages({
      backupId: opts.backupId,
      client,
      compareDb,
      subkeys,
      start
    });

    // Persist to the Backup row (if requested + row exists + id valid).
    if (persist) {
      await persistResult(client, opts.backupId, result, opts.verifiedById ?? null);
    }
    return result;
  } catch (err) {
    // Any unexpected error → INTERNAL_ERROR. Message is scrubbed by
    // safeDetail (never surfaces raw Prisma text with PII).
    const result = finish({
      outcome: "FAILED",
      backupId: opts.backupId,
      code: "INTERNAL_ERROR",
      stage: "STORAGE_IDENTITY",
      detail: safeDetail(err),
      start
    });
    if (persist) {
      await persistResult(client, opts.backupId, result, opts.verifiedById ?? null).catch(
        () => undefined
      );
    }
    return result;
  } finally {
    if (subkeys) wipeSubkeys(subkeys);
  }
}

// ─── Stage runner ───────────────────────────────────────────────────────────

interface StageContext {
  backupId: string;
  client: PrismaClient;
  compareDb: boolean;
  subkeys: { encKey: Buffer; hmacKey: Buffer };
  start: number;
}

async function runStages(ctx: StageContext): Promise<VerifyResult> {
  try {
    // ── 1. STORAGE_IDENTITY ─────────────────────────────────────────
    if (!(await publishedBackupExists(ctx.backupId))) {
      throw new BackupVerifyError(
        "STORAGE_MISSING",
        "STORAGE_IDENTITY",
        "published .bin file does not exist"
      );
    }
    let initialStat;
    try {
      initialStat = await statPublishedBackup(ctx.backupId);
    } catch (err) {
      if (err instanceof BackupStorageError) {
        throw new BackupVerifyError("STORAGE_ERROR", "STORAGE_IDENTITY", "stat failed");
      }
      // ENOENT surfaced as generic Error: manifest missing OR bin missing.
      throw new BackupVerifyError(
        "STORAGE_MISSING",
        "STORAGE_IDENTITY",
        "bin or manifest missing on disk"
      );
    }

    if (initialStat.binSize > MAX_BIN_BYTES) {
      throw new BackupVerifyError(
        "RESOURCE_LIMIT_EXCEEDED",
        "STORAGE_IDENTITY",
        `bin size ${initialStat.binSize} exceeds ${MAX_BIN_BYTES}`
      );
    }
    if (initialStat.manifestSize > MAX_MANIFEST_BYTES) {
      throw new BackupVerifyError(
        "MANIFEST_OVERSIZED",
        "MANIFEST_READ",
        `manifest ${initialStat.manifestSize} bytes exceeds cap ${MAX_MANIFEST_BYTES}`
      );
    }

    // ── 2. MANIFEST_READ ────────────────────────────────────────────
    let manifestBytes: Buffer;
    try {
      manifestBytes = await readPublishedManifest(ctx.backupId);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new BackupVerifyError(
        "MANIFEST_UNREADABLE",
        "MANIFEST_READ",
        code === "ENOENT" ? "manifest not found" : "manifest read failed"
      );
    }
    if (manifestBytes.length > MAX_MANIFEST_BYTES) {
      throw new BackupVerifyError(
        "MANIFEST_OVERSIZED",
        "MANIFEST_READ",
        "manifest exceeds cap after read"
      );
    }

    // ── 3 + 4. MANIFEST_PARSE + MANIFEST_HMAC ───────────────────────
    let manifest: Manifest;
    try {
      manifest = parseAndVerifyManifest(ctx.subkeys.hmacKey, manifestBytes);
    } catch (err) {
      if (err instanceof ManifestParseError) {
        throw new BackupVerifyError(
          "MANIFEST_INVALID",
          "MANIFEST_PARSE",
          "manifest failed schema or JSON parse"
        );
      }
      if (err instanceof ManifestHmacError) {
        throw new BackupVerifyError(
          "MANIFEST_HMAC_INVALID",
          "MANIFEST_HMAC",
          "manifest HMAC did not verify"
        );
      }
      throw err;
    }

    // Sanity: manifestVersion is enforced by zod but re-check defensively.
    if (manifest.manifestVersion !== MANIFEST_VERSION) {
      throw new BackupVerifyError(
        "FORMAT_UNSUPPORTED",
        "MANIFEST_PARSE",
        `unsupported manifestVersion ${manifest.manifestVersion}`
      );
    }

    // ── 5. BACKUP_ID_CROSSCHECK (HIGH-1) ────────────────────────────
    // The manifest is now HMAC-verified. Its `backupId` field is
    // authenticated. Enforce that it matches the filename identity —
    // this is the single most important integrity property in the
    // whole verifier (see §4 of the phase spec).
    if (manifest.backupId !== ctx.backupId) {
      throw new BackupVerifyError(
        "BACKUP_ID_MISMATCH",
        "BACKUP_ID_CROSSCHECK",
        "manifest.backupId does not match filename"
      );
    }

    // ── Format/encryption version support ────────────────────────────
    if (manifest.formatVersion !== SUPPORTED_FORMAT_VERSION) {
      throw new BackupVerifyError(
        "FORMAT_UNSUPPORTED",
        "MANIFEST_PARSE",
        `unsupported formatVersion ${manifest.formatVersion}`
      );
    }
    if (manifest.encryptionVersion !== SUPPORTED_ENCRYPTION_VERSION) {
      throw new BackupVerifyError(
        "FORMAT_UNSUPPORTED",
        "MANIFEST_PARSE",
        `unsupported encryptionVersion ${manifest.encryptionVersion}`
      );
    }

    // ── 6. DB_METADATA ──────────────────────────────────────────────
    if (ctx.compareDb) {
      const row = await ctx.client.backup.findUnique({
        where: { id: ctx.backupId },
        select: {
          id: true,
          contentSha256: true,
          sizeBytes: true,
          schemaSha256: true,
          appVersion: true,
          formatVersion: true,
          encryptionVersion: true,
          kind: true,
          manifestSha256: true
        }
      });
      if (row) {
        checkDbMetadata(row, manifest, manifestBytes);
      }
      // Row missing is not fatal — a bare-file verification path is a
      // legitimate use case (disaster recovery). We just skip this stage.
    }

    // ── 7. CONTENT_DIGEST + SIZE ────────────────────────────────────
    if (initialStat.binSize !== manifest.sizeBytes) {
      throw new BackupVerifyError(
        "SIZE_MISMATCH",
        "CONTENT_DIGEST",
        `on-disk ${initialStat.binSize} vs manifest ${manifest.sizeBytes}`
      );
    }
    const contentSha256 = await streamSha256(ctx.backupId);
    if (contentSha256 !== manifest.contentSha256) {
      throw new BackupVerifyError(
        "CONTENT_DIGEST_MISMATCH",
        "CONTENT_DIGEST",
        "sha256 of .bin does not match manifest.contentSha256"
      );
    }

    // ── 8. ENVELOPE ─────────────────────────────────────────────────
    if (initialStat.binSize < IV_BYTES + TAG_BYTES) {
      throw new BackupVerifyError(
        "ENVELOPE_INVALID",
        "ENVELOPE",
        "file smaller than IV+TAG"
      );
    }

    // ── 9. DECRYPTION setup ─────────────────────────────────────────
    // Read IV (first 12 bytes) and tag (last 16 bytes) via bounded
    // range reads. GCM requires the tag to be `setAuthTag`ed BEFORE
    // any ciphertext is fed to the decrypter — hence tag is read up
    // front rather than accumulated during streaming.
    const iv = await readRange(ctx.backupId, 0, IV_BYTES);
    const tag = await readRange(
      ctx.backupId,
      initialStat.binSize - TAG_BYTES,
      TAG_BYTES
    );
    if (iv.length !== IV_BYTES) {
      throw new BackupVerifyError(
        "ENVELOPE_INVALID",
        "ENVELOPE",
        "short IV read"
      );
    }
    if (tag.length !== TAG_BYTES) {
      throw new BackupVerifyError(
        "ENVELOPE_INVALID",
        "ENVELOPE",
        "short tag read"
      );
    }

    // ── 10–14. Streaming decrypt + NDJSON verify ────────────────────
    const parser = new NdjsonVerifier({
      expectedBackupId: manifest.backupId,
      expectedSchemaSha256: manifest.schemaSha256,
      expectedFormatVersion: manifest.formatVersion,
      expectedEncryptionVersion: manifest.encryptionVersion,
      expectedAppVersion: manifest.appVersion,
      expectedKind: manifest.kind,
      // manifest.createdAt is a Date; the embedded __meta.createdAt is the
      // .toISOString() form of the same instant. Compare both as strings.
      expectedCreatedAt: manifest.createdAt,
      expectedRowCounts: manifest.rowCounts,
      modelOrder: MODEL_ORDER
    });

    const cipherStart = IV_BYTES;
    const cipherEndInclusive = initialStat.binSize - TAG_BYTES - 1;
    if (cipherEndInclusive < cipherStart) {
      // No ciphertext bytes at all — file is exactly IV+TAG. This can
      // never be a valid backup (we always write at least a __meta and
      // __end record). But GCM allows empty ciphertext so we let the
      // decrypt run and the NDJSON parser will fail with FORMAT_INVALID.
    }
    const cipherStream = openPublishedReadStream(ctx.backupId, {
      start: cipherStart,
      end: cipherEndInclusive
    });
    const decryptStream = createBackupDecryptStream(ctx.subkeys.encKey, iv, tag);

    try {
      await pipeline(cipherStream, decryptStream.transform, parser);
    } catch (err) {
      if (err instanceof BackupVerifyError) throw err;
      // Any error inside the pipeline before pipeline itself resolves
      // is either a decrypt failure (bad tag / wrong key / bit-flip)
      // or a downstream verifier failure that we let bubble as
      // BackupVerifyError above.
      throw new BackupVerifyError(
        "DECRYPTION_FAILED",
        "DECRYPTION",
        "authenticated decryption failed"
      );
    }

    const parseResult = parser.result();

    // ── 15. RACE_DETECT ─────────────────────────────────────────────
    const finalStat = await statPublishedBackup(ctx.backupId);
    if (
      finalStat.binSize !== initialStat.binSize ||
      finalStat.binMtime.getTime() !== initialStat.binMtime.getTime()
    ) {
      throw new BackupVerifyError(
        "FILE_MUTATED",
        "RACE_DETECT",
        "bin size or mtime changed during verification"
      );
    }

    // ── 16. SCHEMA_COMPATIBILITY (informational) ────────────────────
    const schemaCompatible = await computeSchemaCompatibility(manifest.schemaSha256);

    return finish({
      outcome: "VERIFIED",
      backupId: ctx.backupId,
      code: "OK",
      stage: "SCHEMA_COMPATIBILITY",
      start: ctx.start,
      contentSha256,
      sizeBytes: initialStat.binSize,
      totalRows: parseResult.totalRows,
      rowCounts: parseResult.rowCounts,
      schemaCompatible,
      formatVersion: manifest.formatVersion,
      encryptionVersion: manifest.encryptionVersion
    });
  } catch (err) {
    if (err instanceof BackupVerifyError) {
      return finish({
        outcome: "FAILED",
        backupId: ctx.backupId,
        code: err.code,
        stage: err.stage,
        detail: err.detail,
        start: ctx.start
      });
    }
    if (err instanceof BackupStorageError) {
      return finish({
        outcome: "FAILED",
        backupId: ctx.backupId,
        code: "STORAGE_ERROR",
        stage: "STORAGE_IDENTITY",
        detail: "storage layer refused the id/path",
        start: ctx.start
      });
    }
    // Unknown — do NOT leak the raw message.
    return finish({
      outcome: "FAILED",
      backupId: ctx.backupId,
      code: "INTERNAL_ERROR",
      stage: "STORAGE_IDENTITY",
      detail: safeDetail(err),
      start: ctx.start
    });
  }
}

// ─── Individual stage helpers ───────────────────────────────────────────────

function checkDbMetadata(
  row: {
    contentSha256: string | null;
    sizeBytes: bigint | null;
    schemaSha256: string;
    appVersion: string;
    formatVersion: string;
    encryptionVersion: string;
    kind: string;
    manifestSha256: string | null;
  },
  manifest: Manifest,
  manifestBytes: Buffer
): void {
  // The manifest is the AUTHORITY for on-disk file integrity (contentSha256,
  // sizeBytes, schemaSha256). We compare against the row to detect drift
  // between the recorded metadata and the actual disk state — either side
  // could be the source of drift, but a mismatch is always a red flag.
  //
  // A row field of `null` (e.g., a row that failed to reach COMPLETED)
  // means "no committed value" — skip that comparison.
  if (row.contentSha256 !== null && row.contentSha256 !== manifest.contentSha256) {
    throw new BackupVerifyError(
      "DB_METADATA_MISMATCH",
      "DB_METADATA",
      "row.contentSha256 differs from manifest.contentSha256"
    );
  }
  if (row.sizeBytes !== null && row.sizeBytes !== BigInt(manifest.sizeBytes)) {
    throw new BackupVerifyError(
      "DB_METADATA_MISMATCH",
      "DB_METADATA",
      "row.sizeBytes differs from manifest.sizeBytes"
    );
  }
  if (row.schemaSha256 !== manifest.schemaSha256) {
    throw new BackupVerifyError(
      "DB_METADATA_MISMATCH",
      "DB_METADATA",
      "row.schemaSha256 differs from manifest.schemaSha256"
    );
  }
  if (row.appVersion !== manifest.appVersion) {
    throw new BackupVerifyError(
      "DB_METADATA_MISMATCH",
      "DB_METADATA",
      "row.appVersion differs"
    );
  }
  if (row.formatVersion !== manifest.formatVersion) {
    throw new BackupVerifyError(
      "DB_METADATA_MISMATCH",
      "DB_METADATA",
      "row.formatVersion differs"
    );
  }
  if (row.encryptionVersion !== manifest.encryptionVersion) {
    throw new BackupVerifyError(
      "DB_METADATA_MISMATCH",
      "DB_METADATA",
      "row.encryptionVersion differs"
    );
  }
  if (row.kind !== manifest.kind) {
    throw new BackupVerifyError(
      "DB_METADATA_MISMATCH",
      "DB_METADATA",
      "row.kind differs"
    );
  }
  // manifestSha256: if the row recorded one, it should match the sha256
  // of the manifest bytes we just read. This catches manifest swaps that
  // preserve the HMAC (which they can, since the HMAC only authenticates
  // the manifest contents — not its bytes-as-stored). Very tight anchor.
  if (row.manifestSha256 !== null) {
    const actual = createHash("sha256").update(manifestBytes).digest("hex");
    if (row.manifestSha256 !== actual) {
      throw new BackupVerifyError(
        "DB_METADATA_MISMATCH",
        "DB_METADATA",
        "row.manifestSha256 differs from sha256(manifest bytes)"
      );
    }
  }
}

async function streamSha256(backupId: string): Promise<string> {
  const h = createHash("sha256");
  const rs = openPublishedReadStream(backupId);
  await pipeline(
    rs,
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        h.update(chunk);
        cb();
      }
    })
  );
  return h.digest("hex");
}

async function readRange(
  backupId: string,
  start: number,
  length: number
): Promise<Buffer> {
  const rs = openPublishedReadStream(backupId, {
    start,
    end: start + length - 1 // fs createReadStream `end` is inclusive
  });
  const chunks: Buffer[] = [];
  await pipeline(
    rs,
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      }
    })
  );
  const out = Buffer.concat(chunks);
  // Guard against a short read — should not happen for a file that has
  // already been sized above, but a race between stat and range-read
  // (RACE_DETECT catches this at the end) would show up here first.
  if (out.length !== length) {
    throw new BackupVerifyError(
      "ENVELOPE_INVALID",
      "ENVELOPE",
      `expected ${length} bytes at offset ${start}, got ${out.length}`
    );
  }
  return out;
}

const HAS_O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number";
const MAX_SCHEMA_BYTES = 512 * 1024;

async function computeSchemaCompatibility(manifestSchemaSha256: string): Promise<boolean> {
  // Compare the manifest's schema hash to the sha256 of the current
  // on-disk `prisma/schema.prisma`. A mismatch is INFORMATIONAL — the
  // backup is still cryptographically valid; restoration may just
  // require an explicit schema-mismatch override (Phase 7).
  const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
  const flags = fsConstants.O_RDONLY | (HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await fs.open(schemaPath, flags);
  } catch {
    return false;
  }
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_SCHEMA_BYTES) return false;
    const buf = Buffer.alloc(stat.size);
    await handle.read(buf, 0, stat.size, 0);
    const current = createHash("sha256").update(buf).digest("hex");
    return current === manifestSchemaSha256;
  } finally {
    await handle.close();
  }
}

// ─── NDJSON verifier stream ─────────────────────────────────────────────────

interface NdjsonVerifierOptions {
  expectedBackupId: string;
  expectedSchemaSha256: string;
  expectedFormatVersion: string;
  expectedEncryptionVersion: string;
  expectedAppVersion: string;
  expectedKind: string;
  expectedCreatedAt: string;
  expectedRowCounts: Record<string, number>;
  modelOrder: readonly BackupModelName[];
}

interface NdjsonVerifierResult {
  rowCounts: Record<string, number>;
  totalRows: number;
}

/**
 * Writable that consumes decrypted NDJSON bytes and streams-parses them.
 * Every line is bounded by MAX_NDJSON_LINE_BYTES. The first line must be
 * a `__meta` record, the last line must be a `__end` record, everything
 * between must be `__row` records with `model` in MODEL_ORDER.
 *
 * A row's `data` is fed through `decodeRow` (from serializer.ts) so
 * $-wrapped values (Date, BigInt, Buffer) are validated exactly as the
 * dump engine encoded them. A row whose `data` cannot be decoded fails
 * verification — a backup that decrypts but is undeserializable is not
 * restorable and MUST NOT be marked VERIFIED.
 */
class NdjsonVerifier extends Writable {
  private buf = Buffer.alloc(0);
  private state: "AWAIT_META" | "IN_BODY" | "AFTER_END" = "AWAIT_META";
  private endRecord: unknown = null;
  private rowCounts: Record<string, number> = Object.create(null);
  private totalRows = 0;
  private readonly opts: NdjsonVerifierOptions;
  private failed = false;

  constructor(opts: NdjsonVerifierOptions) {
    super();
    this.opts = opts;
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      // Append and consume line-by-line. Reset `this.buf` up front and
      // let the partial-line handler re-populate it inside the loop —
      // a prior implementation post-cleared the buffer AFTER the loop,
      // which erased the just-saved remainder.
      const combined = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.buf = Buffer.alloc(0);
      let cursor = 0;
      while (cursor < combined.length) {
        const nl = combined.indexOf(NEWLINE, cursor);
        if (nl === -1) {
          // Partial line — buffer the remainder for the next _write.
          const remainder = combined.subarray(cursor);
          if (remainder.length > MAX_NDJSON_LINE_BYTES) {
            throw new BackupVerifyError(
              "RESOURCE_LIMIT_EXCEEDED",
              "NDJSON",
              `line exceeds cap ${MAX_NDJSON_LINE_BYTES}`
            );
          }
          this.buf = Buffer.from(remainder); // detach from combined buffer
          break;
        }
        const line = combined.subarray(cursor, nl);
        if (line.length > MAX_NDJSON_LINE_BYTES) {
          throw new BackupVerifyError(
            "RESOURCE_LIMIT_EXCEEDED",
            "NDJSON",
            `line exceeds cap ${MAX_NDJSON_LINE_BYTES}`
          );
        }
        this.processLine(line);
        cursor = nl + 1;
      }
      cb();
    } catch (err) {
      this.failed = true;
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _final(cb: (err?: Error | null) => void): void {
    try {
      // A trailing non-newline-terminated line is technically allowed by
      // NDJSON, but our dump engine ALWAYS terminates every record with
      // '\n'. A missing trailing newline is a format defect.
      if (this.buf.length > 0) {
        // Try to parse — if it's the __end record without a trailing
        // newline, we can still validate. But we then require it to be
        // exactly one line's worth.
        if (this.buf.length > MAX_NDJSON_LINE_BYTES) {
          throw new BackupVerifyError(
            "RESOURCE_LIMIT_EXCEEDED",
            "NDJSON",
            "trailing line exceeds cap"
          );
        }
        this.processLine(this.buf);
        this.buf = Buffer.alloc(0);
      }
      this.finalize();
      cb();
    } catch (err) {
      this.failed = true;
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private processLine(bytes: Buffer): void {
    // Empty lines are not valid NDJSON in our format — the dump engine
    // never emits them. Reject to prevent an attacker inserting a bunch
    // of empty lines to slow verification (and preserve the exact
    // wire format).
    if (bytes.length === 0) {
      throw new BackupVerifyError("FORMAT_INVALID", "NDJSON", "empty line");
    }
    let obj: unknown;
    try {
      obj = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "line is not valid JSON"
      );
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "record must be a JSON object"
      );
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length !== 1) {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "record must have exactly one top-level key"
      );
    }
    const kind = keys[0];

    if (this.state === "AWAIT_META") {
      if (kind !== "__meta") {
        throw new BackupVerifyError(
          "FORMAT_INVALID",
          "META",
          "first line must be __meta"
        );
      }
      this.validateMeta(rec.__meta);
      this.state = "IN_BODY";
      return;
    }

    if (this.state === "AFTER_END") {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "records present after __end"
      );
    }

    if (kind === "__row") {
      this.processRow(rec.__row);
      return;
    }
    if (kind === "__end") {
      this.endRecord = rec.__end;
      this.state = "AFTER_END";
      return;
    }
    if (kind === "__meta") {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "META",
        "duplicate __meta record"
      );
    }
    throw new BackupVerifyError(
      "FORMAT_INVALID",
      "NDJSON",
      `unknown record kind: ${sanitizeToken(kind)}`
    );
  }

  private validateMeta(meta: unknown): void {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta is not an object"
      );
    }
    const m = meta as Record<string, unknown>;

    if (m.backupId !== this.opts.expectedBackupId) {
      throw new BackupVerifyError(
        "BACKUP_ID_MISMATCH",
        "META",
        "embedded __meta.backupId differs from manifest/filename"
      );
    }
    if (m.schemaSha256 !== this.opts.expectedSchemaSha256) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.schemaSha256 differs from manifest"
      );
    }
    if (m.formatVersion !== this.opts.expectedFormatVersion) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.formatVersion differs from manifest"
      );
    }
    if (m.encryptionVersion !== this.opts.expectedEncryptionVersion) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.encryptionVersion differs from manifest"
      );
    }
    if (m.appVersion !== this.opts.expectedAppVersion) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.appVersion differs from manifest"
      );
    }
    if (m.kind !== this.opts.expectedKind) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.kind differs from manifest"
      );
    }
    if (m.createdAt !== this.opts.expectedCreatedAt) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.createdAt differs from manifest"
      );
    }
    if (m.manifestVersion !== MANIFEST_VERSION) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.manifestVersion differs"
      );
    }
    if (!Array.isArray(m.modelOrder)) {
      throw new BackupVerifyError(
        "META_INVALID",
        "META",
        "__meta.modelOrder is not an array"
      );
    }
    if (m.modelOrder.length !== this.opts.modelOrder.length) {
      throw new BackupVerifyError(
        "MODEL_COVERAGE_INVALID",
        "MODEL_COVERAGE",
        `__meta.modelOrder length ${m.modelOrder.length} != expected ${this.opts.modelOrder.length}`
      );
    }
    for (let i = 0; i < this.opts.modelOrder.length; i++) {
      if (m.modelOrder[i] !== this.opts.modelOrder[i]) {
        throw new BackupVerifyError(
          "MODEL_COVERAGE_INVALID",
          "MODEL_COVERAGE",
          `__meta.modelOrder[${i}] differs`
        );
      }
    }
  }

  private processRow(row: unknown): void {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "__row must be an object"
      );
    }
    const r = row as Record<string, unknown>;
    if (typeof r.model !== "string") {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "__row.model missing or non-string"
      );
    }
    if (!MODEL_SET.has(r.model)) {
      throw new BackupVerifyError(
        "MODEL_COVERAGE_INVALID",
        "MODEL_COVERAGE",
        `unknown model in __row: ${sanitizeToken(r.model)}`
      );
    }
    if (typeof r.data !== "object" || r.data === null || Array.isArray(r.data)) {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "__row.data must be a plain object"
      );
    }

    // Full serializer round-trip: if this throws, the backup contains a
    // value that we cannot restore — mark it as SERIALIZER_INVALID, not
    // VERIFIED. Restore-time (Phase 7) will re-run decodeRow anyway; a
    // verifier that skipped this would give a false confidence signal.
    try {
      decodeRow(r.data);
    } catch (err) {
      if (err instanceof BackupSerializerError) {
        throw new BackupVerifyError(
          "SERIALIZER_INVALID",
          "SERIALIZER",
          "value could not be decoded"
        );
      }
      throw err;
    }

    this.rowCounts[r.model] = (this.rowCounts[r.model] ?? 0) + 1;
    this.totalRows += 1;
    if (this.totalRows > MAX_TOTAL_ROWS) {
      throw new BackupVerifyError(
        "RESOURCE_LIMIT_EXCEEDED",
        "NDJSON",
        `row count exceeds cap ${MAX_TOTAL_ROWS}`
      );
    }
  }

  private finalize(): void {
    if (this.state === "AWAIT_META") {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "META",
        "no __meta record found"
      );
    }
    if (this.state !== "AFTER_END") {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "no __end record found"
      );
    }
    if (typeof this.endRecord !== "object" || this.endRecord === null || Array.isArray(this.endRecord)) {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "__end is not an object"
      );
    }
    const end = this.endRecord as { rowCounts?: unknown; totalRows?: unknown };
    if (typeof end.totalRows !== "number" || !Number.isFinite(end.totalRows) || end.totalRows < 0) {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "__end.totalRows missing or invalid"
      );
    }
    if (!isPlainRecord(end.rowCounts)) {
      throw new BackupVerifyError(
        "FORMAT_INVALID",
        "NDJSON",
        "__end.rowCounts missing or malformed"
      );
    }

    // Normalize: fill zero-count entries so equality with manifest is
    // unambiguous.
    const computed: Record<string, number> = Object.create(null);
    for (const m of this.opts.modelOrder) {
      computed[m] = this.rowCounts[m] ?? 0;
    }

    const endCounts = end.rowCounts as Record<string, unknown>;

    // Reject any key in __end.rowCounts that is not a known model.
    for (const k of Object.keys(endCounts)) {
      if (!MODEL_SET.has(k)) {
        throw new BackupVerifyError(
          "MODEL_COVERAGE_INVALID",
          "MODEL_COVERAGE",
          `unknown model in __end.rowCounts: ${sanitizeToken(k)}`
        );
      }
    }
    // Same for manifest rowCounts. This catches a manifest that lists
    // a model we do not know about.
    for (const k of Object.keys(this.opts.expectedRowCounts)) {
      if (!MODEL_SET.has(k)) {
        throw new BackupVerifyError(
          "MODEL_COVERAGE_INVALID",
          "MODEL_COVERAGE",
          `unknown model in manifest.rowCounts: ${sanitizeToken(k)}`
        );
      }
    }

    // Compare computed ↔ __end.
    for (const m of this.opts.modelOrder) {
      const raw = endCounts[m];
      const endN = raw === undefined ? 0 : raw;
      if (typeof endN !== "number" || !Number.isFinite(endN) || endN < 0) {
        throw new BackupVerifyError(
          "FORMAT_INVALID",
          "NDJSON",
          `__end.rowCounts.${m} not a non-negative finite number`
        );
      }
      if (endN !== computed[m]) {
        throw new BackupVerifyError(
          "ROW_COUNT_MISMATCH",
          "ROW_COUNTS",
          `__end vs computed for ${m}`
        );
      }
      // Compare computed ↔ manifest.
      const manifestN = this.opts.expectedRowCounts[m] ?? 0;
      if (manifestN !== computed[m]) {
        throw new BackupVerifyError(
          "ROW_COUNT_MISMATCH",
          "ROW_COUNTS",
          `manifest vs computed for ${m}`
        );
      }
    }
    // Total: computed sum == __end.totalRows == sum of manifest.rowCounts.
    let sumComputed = 0;
    let sumManifest = 0;
    for (const m of this.opts.modelOrder) {
      sumComputed += computed[m];
      sumManifest += this.opts.expectedRowCounts[m] ?? 0;
    }
    if (sumComputed !== this.totalRows) {
      throw new BackupVerifyError(
        "ROW_COUNT_MISMATCH",
        "ROW_COUNTS",
        "internal computed sum mismatch"
      );
    }
    if (end.totalRows !== this.totalRows) {
      throw new BackupVerifyError(
        "ROW_COUNT_MISMATCH",
        "ROW_COUNTS",
        "__end.totalRows differs from computed"
      );
    }
    if (sumManifest !== this.totalRows) {
      throw new BackupVerifyError(
        "ROW_COUNT_MISMATCH",
        "ROW_COUNTS",
        "manifest sum differs from computed"
      );
    }
  }

  result(): NdjsonVerifierResult {
    if (this.failed) {
      throw new Error("NdjsonVerifier: result() called after failure");
    }
    // Materialize plain (non-Object.create(null)) result copy.
    const rowCounts: Record<string, number> = {};
    for (const m of this.opts.modelOrder) {
      rowCounts[m] = this.rowCounts[m] ?? 0;
    }
    return { rowCounts, totalRows: this.totalRows };
  }
}

// ─── DB persistence ─────────────────────────────────────────────────────────

async function persistResult(
  client: PrismaClient,
  backupId: string,
  result: VerifyResult,
  verifiedById: string | null
): Promise<void> {
  // Refuse to persist if id is malformed (defence-in-depth; the caller
  // already validated it, but this UPDATE is a security-relevant write).
  try {
    assertValidBackupId(backupId);
  } catch {
    return;
  }
  // Only touch a row that already exists — verify does NOT create rows.
  const row = await client.backup.findUnique({
    where: { id: backupId },
    select: { id: true }
  });
  if (!row) return;

  const verifyResult = result.outcome === "VERIFIED" ? "OK" : result.code;

  // Status transitions:
  //   VERIFIED     → status = VERIFIED
  //   STORAGE_MISSING → status = MISSING
  //   everything else → status = FAILED
  //
  // Note: we deliberately do NOT clobber a prior COMPLETED row to FAILED
  // for transient DB_METADATA_MISMATCH failures where the operator may
  // simply have run verify against a stale DB — but detecting that
  // reliably requires more context than the verifier has. Rather than
  // silently paper over the mismatch, we surface FAILED and let the
  // operator investigate. This matches the plan's spec: §5 says "sets
  // status = VERIFIED on OK, FAILED on anything else".
  let status: "VERIFIED" | "MISSING" | "FAILED";
  if (result.outcome === "VERIFIED") status = "VERIFIED";
  else if (result.code === "STORAGE_MISSING") status = "MISSING";
  else status = "FAILED";

  await client.backup
    .update({
      where: { id: backupId },
      data: {
        status,
        verifiedAt: new Date(),
        verifiedById,
        verifyResult
      }
    })
    .catch(() => undefined);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function finish(input: {
  outcome: VerifyOutcome;
  backupId: string;
  code: VerifyFailureCode | "OK";
  stage: VerifyStage;
  detail?: string;
  start: number;
  contentSha256?: string;
  sizeBytes?: number;
  totalRows?: number;
  rowCounts?: Record<string, number>;
  schemaCompatible?: boolean;
  formatVersion?: string;
  encryptionVersion?: string;
}): VerifyResult {
  return {
    outcome: input.outcome,
    backupId: input.backupId,
    code: input.code,
    stage: input.stage,
    detail: input.detail,
    durationMs: Date.now() - input.start,
    contentSha256: input.contentSha256,
    sizeBytes: input.sizeBytes,
    totalRows: input.totalRows,
    rowCounts: input.rowCounts,
    schemaCompatible: input.schemaCompatible,
    formatVersion: input.formatVersion,
    encryptionVersion: input.encryptionVersion
  };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Truncate + strip control chars from a token before quoting it back into
 * an error message. We do NOT allow arbitrary attacker-controlled strings
 * into `result.detail` even though `detail` is not stored to the DB (only
 * the code is via `verifyResult`) — belt and braces.
 */
function sanitizeToken(s: unknown): string {
  const raw = typeof s === "string" ? s : String(s);
  const stripped = raw.replace(/[^\x20-\x7e]/g, "?");
  return stripped.length > 40 ? stripped.slice(0, 40) + "..." : stripped;
}

/**
 * Reduce an unexpected exception to a static, PII-free summary. Never
 * echoes the raw message (may contain field values). Mirrors the
 * `safeErrorSummary` helper in dump.ts, adapted for verify's stricter
 * envelope (no field/model detail exposed).
 */
function safeDetail(err: unknown): string {
  if (err instanceof BackupVerifyError) return `${err.code}`;
  if (err instanceof BackupStorageError) return "storage error";
  if (err instanceof BackupCryptoConfigError) return "crypto config error";
  if (err instanceof ManifestHmacError) return "manifest hmac error";
  if (err instanceof ManifestParseError) return "manifest parse error";
  if (err instanceof BackupSerializerError) return "serializer error";
  if (err && typeof err === "object" && "name" in err && typeof (err as { name: unknown }).name === "string") {
    return `${(err as { name: string }).name} (details suppressed)`;
  }
  return "unknown error (details suppressed)";
}

import "server-only";

// Layer F — Google Drive off-site backup replication uploader.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §F, §G,
// §H, §I, §J-METADATA-ONLY.
//
// This module ONLY replicates a locally VERIFIED encrypted backup.
// It NEVER touches `Backup.status`, NEVER encrypts, decrypts, or
// reads plaintext, NEVER handles the encryption key, NEVER stores
// credentials in the DB.
//
// Absolute invariants (Layer F approval message):
//   1. Uploads exactly two artifacts per backup: `<id>.bin` (ciphertext)
//      + `<id>.manifest.json` (HMAC-signed manifest). Both were
//      produced by the local backup pipeline; this module never
//      generates or transforms their content.
//   2. NEVER uploads plaintext.
//   3. NEVER uploads the encryption key.
//   4. NEVER uploads a refresh token / access token / bearer header.
//   5. Local `Backup.status` is untouched — every DB write below
//      targets `BackupReplication` only.
//   6. Google Drive failure produces a classified state on the
//      replication row; the Backup row is unaffected.
//   7. Drive I/O NEVER runs inside a Prisma transaction.
//   8. Uploads land in the Layer-E-resolved folder id; a caller that
//      passes an arbitrary folder id is fail-closed by the marker
//      check that Layer E already applied.
//   9. `uploadSessionUri` is treated as bearer-equivalent — never
//      logged, never returned, never in an audit row, never in an
//      admin-UI projection (see serializer.ts).
//  10. METADATA_ONLY verify only. FULL_SHA256 (download + rehash) is
//      Layer J and NOT implemented here. `attestedContentSha256`
//      stays NULL after this module runs.
//
// Test seams: `deps` accepts a full-plumbed set of dependencies so
// tests inject fake filesystem + fake HttpClient + fake DriveApi.

import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";
import type { BackupReplicationErrorCode } from "@prisma/client";

import { classifyGoogleError } from "./classifier";
import { GoogleDriveOperationError } from "./errors";
import type { DriveFolderApi, DriveFileMeta } from "./folder";
import {
  BACKOFF_MAX_ATTEMPTS,
  computeNextRetryAt,
  isAttemptCapReached
} from "./backoff";
import type { HttpClient } from "./http";
import {
  CHUNK_ALIGNMENT_BYTES,
  ResumableUploadHttpError,
  alignChunkBytesDown,
  initResumableSession,
  putChunk,
  queryUploadOffset,
  type PutChunkResult
} from "./resumable-upload";

// ─── Constants ──────────────────────────────────────────────────────────────

export const REPLICATION_DESTINATION = "GOOGLE_DRIVE" as const;
export const BIN_MIME_TYPE = "application/octet-stream";
export const MANIFEST_MIME_TYPE = "application/json";
export const APP_PROPERTY_BACKUP_ID = "backupId";
export const APP_PROPERTY_ARTIFACT = "artifact";
export const APP_PROPERTY_CONTENT_SHA256 = "contentSha256";
export const APP_PROPERTY_SIZE_BYTES = "sizeBytes";
export const APP_PROPERTY_APP_VERSION = "appVersion";
export const APP_PROPERTY_FORMAT_VERSION = "formatVersion";
export const APP_PROPERTY_ENCRYPTION_VERSION = "encryptionVersion";
export const APP_PROPERTY_PRODUCED_AT = "producedAt";

// Session URI expiry per Google docs (~7 days). We store an
// intentionally-conservative 6 days so the reconciler always has a
// safety margin.
const SESSION_URI_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;

// ─── Public types ──────────────────────────────────────────────────────────

export type FileReader = {
  /** `null` when the path does not exist. Every other error propagates. */
  stat(absPath: string): Promise<{ size: number } | null>;
  sha256(absPath: string): Promise<string>;
  readChunk(absPath: string, start: number, length: number): Promise<Buffer>;
  readAll(absPath: string): Promise<Buffer>;
};

export function defaultFileReader(): FileReader {
  return {
    async stat(p) {
      try {
        const s = await fsStat(p);
        return { size: Number(s.size) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async sha256(p) {
      const h = createHash("sha256");
      await pipeline(createReadStream(p), h);
      return h.digest("hex");
    },
    async readChunk(p, start, length) {
      const fh = await fsOpen(p, "r");
      try {
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buf, 0, length, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    async readAll(p) {
      const fh = await fsOpen(p, "r");
      try {
        const s = await fh.stat();
        const buf = Buffer.allocUnsafe(Number(s.size));
        await fh.read(buf, 0, buf.byteLength, 0);
        return buf;
      } finally {
        await fh.close();
      }
    }
  };
}

/**
 * Narrow slice of `drive_v3.Drive` the uploader consumes. Reuses the
 * shape declared by Layer E's `DriveFolderApi` for `files.get` and
 * `files.list`; the uploader doesn't need any new googleapis
 * surface — resumable uploads use the raw HttpClient.
 */
export type DriveApi = DriveFolderApi;

export type ReplicateDeps = {
  prisma: PrismaClient;
  drive: DriveApi;
  http: HttpClient;
  /** Bearer token for the raw HTTP resumable protocol. */
  accessToken: string;
  /** Layer-E-resolved folder id. */
  folderId: string;
  /** `<BACKUP_STORAGE_DIR>` — absolute path from `loadBackupStorageDir()`. */
  storageDir: string;
  files: FileReader;
  now: () => Date;
  /** Target chunk size (aligned down to 256 KiB). Default 16 MiB. */
  chunkBytes: number;
  httpTimeoutMs: number;
  /** Injectable RNG for deterministic backoff in tests. */
  rand?: () => number;
};

export type ReplicateResult =
  | { outcome: "SKIPPED_NOT_VERIFIED"; backupStatus: string | null }
  | {
      outcome: "SKIPPED_ALREADY_COMPLETED";
      remoteBinFileId: string;
      remoteManifestFileId: string;
    }
  | {
      outcome: "COMPLETED";
      remoteBinFileId: string;
      remoteManifestFileId: string;
    }
  | {
      outcome: "RETRYABLE";
      errorCode: BackupReplicationErrorCode;
      sanitizedMessage: string;
      nextRetryAt: Date;
      attemptCount: number;
    }
  | {
      outcome: "FAILED";
      errorCode: BackupReplicationErrorCode;
      sanitizedMessage: string;
      attemptCount: number;
    };

// ─── Defensive id validator (G4-LOW carry-forward #1 + #2) ────────────────
//
// `backupId` and `folderId` are both spliced into strings that flow to
// disk (path.join) and to Google Drive (`q=` query language). Neither
// value ever originates from a browser request in the current code
// path — a `Backup.id` is a server-issued cuid, and a `folderId` is
// loaded from validated env / DB. But defence-in-depth is cheap here:
// a future admin action that accidentally threaded user input through
// the wrong parameter would be caught at the splicing boundary rather
// than silently smuggling `..` into a path or `'` into a Drive q.
//
// Drive resource ids are opaque strings drawn from `[A-Za-z0-9_-]`.
// CUIDs match the same alphabet. A single regex covers both.
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafeId(kind: "backupId" | "folderId", value: string): void {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      `CONFIGURATION_ERROR: ${kind} failed defensive slug check`
    );
  }
}

// ─── Naming helpers (deterministic; no user input) ────────────────────────

export function remoteBinFileName(backupId: string): string {
  assertSafeId("backupId", backupId);
  return `backup_${backupId}.bin`;
}
export function remoteManifestFileName(backupId: string): string {
  assertSafeId("backupId", backupId);
  return `backup_${backupId}.manifest.json`;
}
export function localBinPath(storageDir: string, backupId: string): string {
  assertSafeId("backupId", backupId);
  return path.join(storageDir, "published", `${backupId}.bin`);
}
export function localManifestPath(storageDir: string, backupId: string): string {
  assertSafeId("backupId", backupId);
  return path.join(storageDir, "published", `${backupId}.manifest.json`);
}

// ─── Main entry ────────────────────────────────────────────────────────────

/**
 * Replicate a single Backup to Google Drive. Callable from a Layer L
 * worker or an admin server action.
 *
 * Failure paths NEVER touch `Backup.status`. The Backup row is loaded
 * read-only. Every write is `BackupReplication.*`.
 */
export async function replicateBackupToDrive(
  backupId: string,
  deps: ReplicateDeps
): Promise<ReplicateResult> {
  // 1. Load Backup (read-only precondition).
  const backup = await deps.prisma.backup.findUnique({
    where: { id: backupId },
    select: {
      id: true,
      status: true,
      sizeBytes: true,
      contentSha256: true,
      manifestSha256: true,
      appVersion: true,
      formatVersion: true,
      encryptionVersion: true
    }
  });
  if (!backup || backup.status !== "VERIFIED") {
    return {
      outcome: "SKIPPED_NOT_VERIFIED",
      backupStatus: backup?.status ?? null
    };
  }
  if (
    typeof backup.contentSha256 !== "string" ||
    backup.contentSha256.length !== 64
  ) {
    // A VERIFIED backup without a contentSha256 is a schema
    // invariant break. Refuse to touch it.
    return {
      outcome: "FAILED",
      errorCode: "CONFIGURATION_ERROR",
      sanitizedMessage:
        "CONFIGURATION_ERROR: backup row is VERIFIED but missing contentSha256",
      attemptCount: 0
    };
  }
  if (backup.sizeBytes === null || backup.sizeBytes === undefined) {
    return {
      outcome: "FAILED",
      errorCode: "CONFIGURATION_ERROR",
      sanitizedMessage:
        "CONFIGURATION_ERROR: backup row is VERIFIED but missing sizeBytes",
      attemptCount: 0
    };
  }
  const expectedBinSize = Number(backup.sizeBytes);

  // 2. Upsert the replication row. Preserves state across restarts.
  const now = deps.now();
  const rep = await deps.prisma.backupReplication.upsert({
    where: {
      backupId_destination: {
        backupId,
        destination: REPLICATION_DESTINATION
      }
    },
    create: {
      backupId,
      destination: REPLICATION_DESTINATION,
      status: "PENDING",
      remoteFolderId: deps.folderId
    },
    update: {}
  });

  // Terminal states are no-ops. FAILED requires an admin action
  // (`retryReplicationService`, Layer P) to transition back to PENDING.
  if (rep.status === "COMPLETED") {
    if (
      typeof rep.remoteBinFileId === "string" &&
      typeof rep.remoteManifestFileId === "string"
    ) {
      return {
        outcome: "SKIPPED_ALREADY_COMPLETED",
        remoteBinFileId: rep.remoteBinFileId,
        remoteManifestFileId: rep.remoteManifestFileId
      };
    }
    // Malformed row (COMPLETED without ids) — refuse quietly rather
    // than escalate to FAILED; a Layer L reconciler can heal.
    return {
      outcome: "SKIPPED_ALREADY_COMPLETED",
      remoteBinFileId: rep.remoteBinFileId ?? "",
      remoteManifestFileId: rep.remoteManifestFileId ?? ""
    };
  }
  if (rep.status === "FAILED") {
    return {
      outcome: "FAILED",
      errorCode: rep.errorCode,
      sanitizedMessage:
        typeof rep.errorMessage === "string"
          ? rep.errorMessage
          : "FAILED: previous permanent failure",
      attemptCount: rep.attemptCount
    };
  }

  // 3. Transition to UPLOADING (short DB tx, no Drive I/O inside).
  const attemptedAt = deps.now();
  const nextAttemptCount = rep.attemptCount + 1;
  await deps.prisma.backupReplication.update({
    where: { id: rep.id },
    data: {
      status: "UPLOADING",
      uploadStartedAt: rep.uploadStartedAt ?? attemptedAt,
      lastAttemptAt: attemptedAt,
      attemptCount: nextAttemptCount,
      errorCode: "NONE",
      errorMessage: null,
      nextRetryAt: null
    }
  });

  try {
    // ── 4. Local preflight ─────────────────────────────────────────
    const binAbs = localBinPath(deps.storageDir, backupId);
    const manifestAbs = localManifestPath(deps.storageDir, backupId);

    const binStat = await deps.files.stat(binAbs);
    if (binStat === null) {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "LOCAL_SOURCE_MISSING",
        sanitizedMessage:
          "LOCAL_SOURCE_MISSING: encrypted backup .bin absent from local storage",
        retryable: false
      });
    }
    if (binStat.size !== expectedBinSize) {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "LOCAL_SOURCE_CORRUPTED",
        sanitizedMessage:
          "LOCAL_SOURCE_CORRUPTED: local .bin size does not match Backup.sizeBytes",
        retryable: false
      });
    }
    const localSha = await deps.files.sha256(binAbs);
    if (localSha !== backup.contentSha256) {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "LOCAL_SOURCE_CORRUPTED",
        sanitizedMessage:
          "LOCAL_SOURCE_CORRUPTED: local .bin sha256 does not match Backup.contentSha256",
        retryable: false
      });
    }
    const manifestStat = await deps.files.stat(manifestAbs);
    if (manifestStat === null) {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "LOCAL_SOURCE_MISSING",
        sanitizedMessage:
          "LOCAL_SOURCE_MISSING: signed manifest absent from local storage",
        retryable: false
      });
    }

    // ── 5. Idempotency check (§F.3) ────────────────────────────────
    const binIdemp = await checkRemoteArtifact(deps, backupId, "bin");
    if (binIdemp.state === "duplicate") {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "REMOTE_VERIFICATION_FAILED",
        sanitizedMessage:
          "REMOTE_VERIFICATION_FAILED: DUPLICATE_DETECTED for .bin at destination",
        retryable: false
      });
    }
    if (
      binIdemp.state === "found" &&
      binIdemp.metaMatches !== "match"
    ) {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "REMOTE_VERIFICATION_FAILED",
        sanitizedMessage:
          "REMOTE_VERIFICATION_FAILED: existing .bin metadata mismatch — worker will not overwrite",
        retryable: false
      });
    }

    // ── 6. Bin upload path (reuse-or-upload) ───────────────────────
    let binFileId: string;
    let binSize: number;
    let binRemoteMd5: string | null;
    let binLocalMd5: string | null;

    if (binIdemp.state === "found") {
      // Reconcile — treat existing remote object as the source of truth.
      // No SHA-256 attestation happens on this branch either (§J: only
      // FULL_SHA256 sets attestedContentSha256).
      binFileId = binIdemp.fileId;
      binSize = binIdemp.size;
      binRemoteMd5 = binIdemp.md5;
      binLocalMd5 = null;
    } else {
      const uploaded = await uploadBin(deps, {
        backup: {
          id: backup.id,
          contentSha256: backup.contentSha256,
          appVersion: backup.appVersion,
          formatVersion: backup.formatVersion,
          encryptionVersion: backup.encryptionVersion,
          expectedSize: expectedBinSize,
          producedAt: attemptedAt.toISOString()
        },
        replicationRowId: rep.id,
        existingSessionUri: rep.uploadSessionUri,
        existingSessionExpiresAt: rep.uploadSessionExpiresAt,
        existingBytesSent: Number(rep.uploadBytesSent ?? 0),
        localBinPath: binAbs
      });
      binFileId = uploaded.fileId;
      binSize = uploaded.size;
      binRemoteMd5 = uploaded.md5Checksum;
      binLocalMd5 = uploaded.localMd5;

      // Cross-check MD5 (§J.3). If Drive's MD5 differs from what we
      // streamed, refuse — this is the honest metadata gate.
      if (
        typeof binRemoteMd5 === "string" &&
        binLocalMd5 !== null &&
        binRemoteMd5 !== binLocalMd5
      ) {
        return await recordFailure(deps, rep.id, nextAttemptCount, {
          errorCode: "REMOTE_CHECKSUM_MISMATCH",
          sanitizedMessage:
            "REMOTE_CHECKSUM_MISMATCH: Drive-reported MD5 differs from MD5 computed during upload",
          retryable: false
        });
      }
      if (binSize !== expectedBinSize) {
        return await recordFailure(deps, rep.id, nextAttemptCount, {
          errorCode: "REMOTE_SIZE_MISMATCH",
          sanitizedMessage:
            "REMOTE_SIZE_MISMATCH: Drive-reported size differs from uploaded size",
          retryable: false
        });
      }
    }

    // ── 7. Manifest upload path (reuse-or-upload) ─────────────────
    const manifestIdemp = await checkRemoteArtifact(
      deps,
      backupId,
      "manifest"
    );
    if (manifestIdemp.state === "duplicate") {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "REMOTE_VERIFICATION_FAILED",
        sanitizedMessage:
          "REMOTE_VERIFICATION_FAILED: DUPLICATE_DETECTED for manifest at destination",
        retryable: false
      });
    }
    let manifestFileId: string;
    let manifestSize: number;
    let manifestRemoteMd5: string | null;
    if (manifestIdemp.state === "found") {
      manifestFileId = manifestIdemp.fileId;
      manifestSize = manifestIdemp.size;
      manifestRemoteMd5 = manifestIdemp.md5;
    } else {
      const uploaded = await uploadManifest(deps, {
        backup: {
          id: backup.id,
          contentSha256: backup.contentSha256,
          appVersion: backup.appVersion,
          formatVersion: backup.formatVersion,
          encryptionVersion: backup.encryptionVersion,
          producedAt: attemptedAt.toISOString()
        },
        manifestPath: manifestAbs,
        manifestSize: manifestStat.size
      });
      manifestFileId = uploaded.fileId;
      manifestSize = uploaded.size;
      manifestRemoteMd5 = uploaded.md5Checksum;
      if (manifestSize !== manifestStat.size) {
        return await recordFailure(deps, rep.id, nextAttemptCount, {
          errorCode: "REMOTE_SIZE_MISMATCH",
          sanitizedMessage:
            "REMOTE_SIZE_MISMATCH: Drive-reported manifest size differs from uploaded size",
          retryable: false
        });
      }
    }

    // ── 8. Transition UPLOADING → VERIFYING (§K state machine). ────
    // Both files are uploaded; the row's remote identity is now known.
    // A distinct VERIFYING state exists so an operator inspecting a
    // long-running row can distinguish "still shipping bytes" from
    // "shipping done, checking Drive metadata". No Drive I/O in this tx.
    const uploadCompletedAt = deps.now();
    await deps.prisma.backupReplication.update({
      where: { id: rep.id },
      data: {
        status: "VERIFYING",
        uploadCompletedAt,
        remoteBinFileId: binFileId,
        remoteManifestFileId: manifestFileId,
        remoteFolderId: deps.folderId,
        remoteBinSize: BigInt(binSize),
        remoteManifestSize: BigInt(manifestSize),
        remoteBinMd5: binRemoteMd5 ?? undefined,
        remoteManifestMd5: manifestRemoteMd5 ?? undefined
      }
    });

    // ── 9. METADATA_ONLY verify (§J.1). ────────────────────────────
    // We already got a size + md5 in the completion response; the
    // fresh `files.get` is a belt-and-braces + `parents` +
    // `appProperties` check.
    const verifiedBin = await verifyRemoteMetadata(deps, {
      fileId: binFileId,
      expectedName: remoteBinFileName(backupId),
      expectedSize: expectedBinSize,
      expectedAppProps: {
        [APP_PROPERTY_BACKUP_ID]: backupId,
        [APP_PROPERTY_ARTIFACT]: "bin"
      },
      expectedMimeType: BIN_MIME_TYPE
    });
    if (verifiedBin !== "ok") {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "REMOTE_VERIFICATION_FAILED",
        sanitizedMessage: `REMOTE_VERIFICATION_FAILED: ${verifiedBin}`,
        retryable: false
      });
    }
    const verifiedManifest = await verifyRemoteMetadata(deps, {
      fileId: manifestFileId,
      expectedName: remoteManifestFileName(backupId),
      expectedSize: manifestStat.size,
      expectedAppProps: {
        [APP_PROPERTY_BACKUP_ID]: backupId,
        [APP_PROPERTY_ARTIFACT]: "manifest"
      },
      expectedMimeType: MANIFEST_MIME_TYPE
    });
    if (verifiedManifest !== "ok") {
      return await recordFailure(deps, rep.id, nextAttemptCount, {
        errorCode: "REMOTE_VERIFICATION_FAILED",
        sanitizedMessage: `REMOTE_VERIFICATION_FAILED: ${verifiedManifest}`,
        retryable: false
      });
    }

    // ── 10. VERIFYING → COMPLETED (short DB tx, no Drive I/O). ────
    const completedAt = deps.now();
    await deps.prisma.backupReplication.update({
      where: { id: rep.id },
      data: {
        status: "COMPLETED",
        // §J: METADATA_ONLY level. attestedContentSha256 stays NULL.
        lastVerifyLevel: "METADATA_ONLY",
        lastVerifiedAt: completedAt,
        // Clear resumable-session state — the row no longer holds
        // any bearer-equivalent capability.
        uploadSessionUri: null,
        uploadSessionExpiresAt: null,
        uploadBytesSent: null,
        errorCode: "NONE",
        errorMessage: null,
        nextRetryAt: null
      }
    });

    return {
      outcome: "COMPLETED",
      remoteBinFileId: binFileId,
      remoteManifestFileId: manifestFileId
    };
  } catch (err) {
    return await handleThrown(deps, rep.id, nextAttemptCount, err);
  }
}

// ─── Bin upload (resumable, with crash-safe session persistence) ───────────

type BinUploadContext = {
  backup: {
    id: string;
    contentSha256: string;
    appVersion: string;
    formatVersion: string;
    encryptionVersion: string;
    expectedSize: number;
    producedAt: string;
  };
  replicationRowId: string;
  existingSessionUri: string | null;
  existingSessionExpiresAt: Date | null;
  existingBytesSent: number;
  localBinPath: string;
};

type BinUploadResult = {
  fileId: string;
  size: number;
  md5Checksum: string | null;
  localMd5: string | null;
};

async function uploadBin(
  deps: ReplicateDeps,
  ctx: BinUploadContext
): Promise<BinUploadResult> {
  const appProps = binAppProperties(ctx.backup);

  // Determine the session URI + starting offset.
  let sessionUri: string;
  let confirmedBytes: number;
  let alreadyComplete:
    | { fileId: string; size: number; md5Checksum: string | null }
    | null = null;
  let localMd5: string | null = null;

  if (
    ctx.existingSessionUri !== null &&
    ctx.existingSessionUri.startsWith("https://") &&
    ctx.existingSessionExpiresAt !== null &&
    ctx.existingSessionExpiresAt.getTime() > deps.now().getTime()
  ) {
    // Resume path (§H.1 crash-recovery). Query the session to learn
    // the authoritative offset; Drive may already hold everything.
    const q = await queryUploadOffset({
      http: deps.http,
      sessionUri: ctx.existingSessionUri,
      totalBytes: ctx.backup.expectedSize,
      timeoutMs: deps.httpTimeoutMs
    });
    if (q.state === "session_expired") {
      sessionUri = await initFreshSession();
      confirmedBytes = 0;
    } else if (q.state === "complete") {
      // The pre-crash upload actually succeeded. Skip the loop —
      // we still need to compute a local MD5 for the cross-check, so
      // fall through with `alreadyComplete` set and a fresh local
      // MD5 computed below.
      alreadyComplete = {
        fileId: q.fileId,
        size: q.size,
        md5Checksum: q.md5Checksum
      };
      sessionUri = ctx.existingSessionUri;
      confirmedBytes = ctx.backup.expectedSize;
    } else {
      sessionUri = ctx.existingSessionUri;
      confirmedBytes = q.confirmedBytes;
    }
  } else {
    sessionUri = await initFreshSession();
    confirmedBytes = 0;
  }

  // If we didn't need to re-init, the freshly-issued session URI
  // needs to be persisted before the first byte flies (§G.2 step 1).
  // If we resumed an existing one, `existingSessionUri` was already
  // in DB — but we still refresh the expiry-in-DB timestamp when we
  // just re-obtained it.
  if (
    ctx.existingSessionUri !== sessionUri ||
    ctx.existingSessionExpiresAt === null ||
    ctx.existingSessionExpiresAt.getTime() <= deps.now().getTime()
  ) {
    await deps.prisma.backupReplication.update({
      where: { id: ctx.replicationRowId },
      data: {
        uploadSessionUri: sessionUri,
        uploadSessionExpiresAt: new Date(
          deps.now().getTime() + SESSION_URI_LIFETIME_MS
        ),
        uploadBytesSent: BigInt(confirmedBytes)
      }
    });
  }

  // Chunk loop.
  const chunkSize = alignChunkBytesDown(deps.chunkBytes);
  const localMd5Hash: Hash = createHash("md5");
  let hashedThroughByte = 0;

  // If we resumed at offset > 0, we need to feed the already-uploaded
  // bytes through the MD5 hasher (since MD5 is a streaming hash and
  // Drive will report the full-body MD5 in the completion response).
  if (confirmedBytes > 0) {
    await streamRangeIntoHash(
      deps.files,
      ctx.localBinPath,
      0,
      confirmedBytes,
      chunkSize,
      localMd5Hash
    );
    hashedThroughByte = confirmedBytes;
  }

  let completion: PutChunkResult | null = alreadyComplete
    ? {
        state: "complete",
        fileId: alreadyComplete.fileId,
        size: alreadyComplete.size,
        md5Checksum: alreadyComplete.md5Checksum
      }
    : null;

  while (completion === null || completion.state !== "complete") {
    const remaining = ctx.backup.expectedSize - confirmedBytes;
    if (remaining <= 0) {
      // We think everything's uploaded but no completion response.
      // Ask Drive for the truth.
      const q = await queryUploadOffset({
        http: deps.http,
        sessionUri,
        totalBytes: ctx.backup.expectedSize,
        timeoutMs: deps.httpTimeoutMs
      });
      if (q.state === "complete") {
        completion = {
          state: "complete",
          fileId: q.fileId,
          size: q.size,
          md5Checksum: q.md5Checksum
        };
        break;
      }
      // Otherwise we're in a weird state — surface it.
      throw new ResumableUploadHttpError(
        "session_offset_mismatch",
        { status: 500, headers: {}, body: Buffer.alloc(0) }
      );
    }
    const isFinal = remaining <= chunkSize;
    const thisChunkLen = isFinal ? remaining : chunkSize;
    const chunk = await deps.files.readChunk(
      ctx.localBinPath,
      confirmedBytes,
      thisChunkLen
    );
    if (chunk.byteLength !== thisChunkLen) {
      throw new GoogleDriveOperationError(
        "LOCAL_SOURCE_CORRUPTED",
        "LOCAL_SOURCE_CORRUPTED: short read on local .bin during resumable upload"
      );
    }
    if (hashedThroughByte < confirmedBytes + chunk.byteLength) {
      localMd5Hash.update(chunk);
      hashedThroughByte = confirmedBytes + chunk.byteLength;
    }
    let result: PutChunkResult;
    try {
      result = await putChunk({
        http: deps.http,
        sessionUri,
        chunk,
        startByte: confirmedBytes,
        totalBytes: ctx.backup.expectedSize,
        timeoutMs: deps.httpTimeoutMs
      });
    } catch (err) {
      if (err instanceof ResumableUploadHttpError) throw err;
      throw err;
    }
    if (result.state === "complete") {
      completion = result;
      break;
    }
    // Persist confirmed offset for crash-safety.
    confirmedBytes = result.confirmedBytes;
    await deps.prisma.backupReplication.update({
      where: { id: ctx.replicationRowId },
      data: { uploadBytesSent: BigInt(confirmedBytes) }
    });
    if (result.confirmedBytes === 0 && !isFinal) {
      // Drive rejected everything without an error status — refuse
      // to loop forever.
      throw new ResumableUploadHttpError(
        "no_progress",
        { status: 500, headers: {}, body: Buffer.alloc(0) }
      );
    }
  }

  localMd5 = alreadyComplete === null ? localMd5Hash.digest("hex") : null;

  // Ignore lint about unused appProps — its value was captured at
  // session init; we don't need it here again.
  void appProps;

  return {
    fileId: completion.fileId,
    size: completion.size,
    md5Checksum: completion.md5Checksum,
    localMd5
  };

  // Inline factory so the two entry conditions above share the code.
  async function initFreshSession(): Promise<string> {
    const { sessionUri: uri } = await initResumableSession({
      http: deps.http,
      accessToken: deps.accessToken,
      folderId: deps.folderId,
      fileName: remoteBinFileName(ctx.backup.id),
      mimeType: BIN_MIME_TYPE,
      totalBytes: ctx.backup.expectedSize,
      appProperties: appProps,
      timeoutMs: deps.httpTimeoutMs
    });
    return uri;
  }
}

async function streamRangeIntoHash(
  files: FileReader,
  absPath: string,
  fromByte: number,
  toByte: number,
  chunkSize: number,
  hash: Hash
): Promise<void> {
  let cursor = fromByte;
  while (cursor < toByte) {
    const len = Math.min(chunkSize, toByte - cursor);
    const buf = await files.readChunk(absPath, cursor, len);
    if (buf.byteLength === 0) break;
    hash.update(buf);
    cursor += buf.byteLength;
  }
}

// ─── Manifest upload (resumable, uniform code path) ───────────────────────

type ManifestUploadContext = {
  backup: {
    id: string;
    contentSha256: string;
    appVersion: string;
    formatVersion: string;
    encryptionVersion: string;
    producedAt: string;
  };
  manifestPath: string;
  manifestSize: number;
};

async function uploadManifest(
  deps: ReplicateDeps,
  ctx: ManifestUploadContext
): Promise<{ fileId: string; size: number; md5Checksum: string | null }> {
  const appProps = manifestAppProperties(ctx.backup, ctx.manifestSize);
  const { sessionUri } = await initResumableSession({
    http: deps.http,
    accessToken: deps.accessToken,
    folderId: deps.folderId,
    fileName: remoteManifestFileName(ctx.backup.id),
    mimeType: MANIFEST_MIME_TYPE,
    totalBytes: ctx.manifestSize,
    appProperties: appProps,
    timeoutMs: deps.httpTimeoutMs
  });
  const body = await deps.files.readAll(ctx.manifestPath);
  if (body.byteLength !== ctx.manifestSize) {
    throw new GoogleDriveOperationError(
      "LOCAL_SOURCE_CORRUPTED",
      "LOCAL_SOURCE_CORRUPTED: manifest read length does not match stat size"
    );
  }
  const put = await putChunk({
    http: deps.http,
    sessionUri,
    chunk: body,
    startByte: 0,
    totalBytes: ctx.manifestSize,
    timeoutMs: deps.httpTimeoutMs
  });
  if (put.state !== "complete") {
    throw new ResumableUploadHttpError(
      "manifest_upload_incomplete",
      { status: 500, headers: {}, body: Buffer.alloc(0) }
    );
  }
  return { fileId: put.fileId, size: put.size, md5Checksum: put.md5Checksum };
}

// ─── Idempotency check (§F.3) ─────────────────────────────────────────────

type IdempotencyResult =
  | { state: "none" }
  | {
      state: "found";
      fileId: string;
      size: number;
      md5: string | null;
      metaMatches: "match" | "mismatch";
    }
  | { state: "duplicate" };

async function checkRemoteArtifact(
  deps: ReplicateDeps,
  backupId: string,
  artifact: "bin" | "manifest"
): Promise<IdempotencyResult> {
  // G4-LOW #1: validate defensively at the Drive `q=` splicing boundary.
  // If either value ever contained a `'`, `\`, or brace it could subvert
  // the query grammar. Both values are server-generated in the current
  // code path; the guard is belt-and-braces.
  assertSafeId("folderId", deps.folderId);
  assertSafeId("backupId", backupId);
  const q =
    `'${deps.folderId}' in parents ` +
    `and trashed=false ` +
    `and appProperties has { key='${APP_PROPERTY_BACKUP_ID}' and value='${backupId}' } ` +
    `and appProperties has { key='${APP_PROPERTY_ARTIFACT}' and value='${artifact}' }`;
  const resp = await deps.drive.files.list({
    q,
    fields:
      "files(id,name,mimeType,trashed,size,md5Checksum,appProperties,parents)",
    pageSize: 10,
    spaces: "drive"
  });
  const files = resp.data.files ?? [];
  if (files.length === 0) return { state: "none" };
  if (files.length > 1) return { state: "duplicate" };
  const only = files[0]!;
  const id = only.id;
  if (typeof id !== "string" || id.length === 0) {
    return { state: "duplicate" };
  }
  // Read what we can from the response — no PII field is requested.
  const anyFile = only as DriveFileMeta & {
    size?: string | null;
    md5Checksum?: string | null;
    parents?: string[] | null;
  };
  const sizeStr = anyFile.size;
  const parsedSize =
    typeof sizeStr === "string" && /^\d+$/.test(sizeStr)
      ? Number.parseInt(sizeStr, 10)
      : 0;
  const md5 =
    typeof anyFile.md5Checksum === "string" && anyFile.md5Checksum.length > 0
      ? anyFile.md5Checksum
      : null;
  // Match check: appProperties.backupId + artifact + parents must
  // contain deps.folderId (defence-in-depth even though `q` already
  // filtered).
  const props = only.appProperties ?? {};
  const backupIdOk = props[APP_PROPERTY_BACKUP_ID] === backupId;
  const artifactOk = props[APP_PROPERTY_ARTIFACT] === artifact;
  const parents = anyFile.parents ?? [];
  const parentsOk = Array.isArray(parents) && parents.includes(deps.folderId);
  const trashedOk = only.trashed !== true;
  const mimeOk =
    (artifact === "bin" && only.mimeType === BIN_MIME_TYPE) ||
    (artifact === "manifest" && only.mimeType === MANIFEST_MIME_TYPE);
  const nameOk =
    (artifact === "bin" && only.name === remoteBinFileName(backupId)) ||
    (artifact === "manifest" &&
      only.name === remoteManifestFileName(backupId));
  const metaMatches: "match" | "mismatch" =
    backupIdOk && artifactOk && parentsOk && trashedOk && mimeOk && nameOk
      ? "match"
      : "mismatch";
  return {
    state: "found",
    fileId: id,
    size: parsedSize,
    md5,
    metaMatches
  };
}

// ─── METADATA_ONLY verify (§F.3 / §J.1) ───────────────────────────────────

async function verifyRemoteMetadata(
  deps: ReplicateDeps,
  input: {
    fileId: string;
    expectedName: string;
    expectedSize: number;
    expectedAppProps: Record<string, string>;
    expectedMimeType: string;
  }
): Promise<
  | "ok"
  | "name_mismatch"
  | "size_mismatch"
  | "mimeType_mismatch"
  | "trashed"
  | "parents_mismatch"
  | "appProperties_mismatch"
> {
  const resp = await deps.drive.files.get({
    fileId: input.fileId,
    fields:
      "id,name,mimeType,trashed,size,md5Checksum,appProperties,parents"
  });
  const data = resp.data as DriveFileMeta & {
    size?: string | null;
    parents?: string[] | null;
  };
  if (data.name !== input.expectedName) return "name_mismatch";
  if (data.mimeType !== input.expectedMimeType) return "mimeType_mismatch";
  if (data.trashed === true) return "trashed";
  const parents = data.parents ?? [];
  if (!Array.isArray(parents) || !parents.includes(deps.folderId)) {
    return "parents_mismatch";
  }
  const sizeStr = data.size;
  const parsedSize =
    typeof sizeStr === "string" && /^\d+$/.test(sizeStr)
      ? Number.parseInt(sizeStr, 10)
      : null;
  if (parsedSize !== input.expectedSize) return "size_mismatch";
  const props = data.appProperties ?? {};
  for (const [k, v] of Object.entries(input.expectedAppProps)) {
    if (props[k] !== v) return "appProperties_mismatch";
  }
  return "ok";
}

// ─── appProperties builders ────────────────────────────────────────────────

function binAppProperties(b: {
  id: string;
  contentSha256: string;
  appVersion: string;
  formatVersion: string;
  encryptionVersion: string;
  expectedSize: number;
  producedAt: string;
}): Record<string, string> {
  return {
    [APP_PROPERTY_BACKUP_ID]: b.id,
    [APP_PROPERTY_ARTIFACT]: "bin",
    [APP_PROPERTY_CONTENT_SHA256]: b.contentSha256,
    [APP_PROPERTY_SIZE_BYTES]: String(b.expectedSize),
    [APP_PROPERTY_APP_VERSION]: b.appVersion,
    [APP_PROPERTY_FORMAT_VERSION]: b.formatVersion,
    [APP_PROPERTY_ENCRYPTION_VERSION]: b.encryptionVersion,
    [APP_PROPERTY_PRODUCED_AT]: b.producedAt
  };
}

function manifestAppProperties(
  b: {
    id: string;
    contentSha256: string;
    appVersion: string;
    formatVersion: string;
    encryptionVersion: string;
    producedAt: string;
  },
  size: number
): Record<string, string> {
  return {
    [APP_PROPERTY_BACKUP_ID]: b.id,
    [APP_PROPERTY_ARTIFACT]: "manifest",
    [APP_PROPERTY_CONTENT_SHA256]: b.contentSha256,
    [APP_PROPERTY_SIZE_BYTES]: String(size),
    [APP_PROPERTY_APP_VERSION]: b.appVersion,
    [APP_PROPERTY_FORMAT_VERSION]: b.formatVersion,
    [APP_PROPERTY_ENCRYPTION_VERSION]: b.encryptionVersion,
    [APP_PROPERTY_PRODUCED_AT]: b.producedAt
  };
}

// ─── Failure recording ────────────────────────────────────────────────────

async function recordFailure(
  deps: ReplicateDeps,
  replicationRowId: string,
  attemptCount: number,
  input: {
    errorCode: BackupReplicationErrorCode;
    sanitizedMessage: string;
    retryable: boolean;
    retryAfterSeconds?: number | null;
  }
): Promise<ReplicateResult> {
  if (!input.retryable || isAttemptCapReached(attemptCount)) {
    await deps.prisma.backupReplication.update({
      where: { id: replicationRowId },
      data: {
        status: "FAILED",
        errorCode: input.errorCode,
        errorMessage: input.sanitizedMessage.slice(0, 512),
        nextRetryAt: null,
        // Do NOT clear uploadSessionUri here: a future admin retry
        // may want to resume. It stays sensitive; the browser
        // serializer keeps it hidden regardless of status.
        lastAttemptAt: deps.now()
      }
    });
    return {
      outcome: "FAILED",
      errorCode: input.errorCode,
      sanitizedMessage: input.sanitizedMessage,
      attemptCount
    };
  }
  const nextRetryAt = computeNextRetryAt({
    attemptCount,
    now: deps.now(),
    retryAfterSeconds: input.retryAfterSeconds ?? null,
    rand: deps.rand
  });
  await deps.prisma.backupReplication.update({
    where: { id: replicationRowId },
    data: {
      status: "RETRYABLE_FAILURE",
      errorCode: input.errorCode,
      errorMessage: input.sanitizedMessage.slice(0, 512),
      nextRetryAt,
      lastAttemptAt: deps.now()
    }
  });
  return {
    outcome: "RETRYABLE",
    errorCode: input.errorCode,
    sanitizedMessage: input.sanitizedMessage,
    nextRetryAt,
    attemptCount
  };
}

async function handleThrown(
  deps: ReplicateDeps,
  replicationRowId: string,
  attemptCount: number,
  err: unknown
): Promise<ReplicateResult> {
  // 1. Already-classified errors from Layer B/D/E use their fields.
  if (err instanceof GoogleDriveOperationError) {
    return await recordFailure(deps, replicationRowId, attemptCount, {
      errorCode: err.code,
      sanitizedMessage: err.message,
      retryable: err.retryable
    });
  }
  // 2. Resumable-upload HTTP failures — thread through the classifier.
  if (err instanceof ResumableUploadHttpError) {
    // Build a synthetic error shape the classifier understands so we
    // do NOT depend on the raw response body here.
    const synthetic = {
      status: err.status,
      response: { status: err.status, data: {} }
    };
    const c = classifyGoogleError(synthetic);
    return await recordFailure(deps, replicationRowId, attemptCount, {
      errorCode: c.code,
      sanitizedMessage:
        c.sanitizedMessage +
        (err.reason.length > 0 ? ` (${err.reason})` : ""),
      retryable: c.retryable,
      retryAfterSeconds: err.retryAfterSeconds
    });
  }
  // 3. Node fs error?
  if (isFsMissingError(err)) {
    return await recordFailure(deps, replicationRowId, attemptCount, {
      errorCode: "LOCAL_SOURCE_MISSING",
      sanitizedMessage: "LOCAL_SOURCE_MISSING: filesystem error opening artifact",
      retryable: false
    });
  }
  // 4. Fallback — treat unknown as retryable UNKNOWN to be conservative.
  return await recordFailure(deps, replicationRowId, attemptCount, {
    errorCode: "UNKNOWN",
    sanitizedMessage: "UNKNOWN: unclassified error during replication",
    retryable: true
  });
}

function isFsMissingError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

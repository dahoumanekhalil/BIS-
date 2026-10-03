import "server-only";

// Layer H — remote verification services (§J).
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §J.
//
// Two verify levels, both operating ONLY on a row that has already
// reached `status = COMPLETED`:
//
//   1. `verifyRemoteMetadata(replicationId)` — re-runs a
//      `files.get(id, fields=size|md5Checksum|appProperties|parents|
//      trashed|mimeType|name)` on BOTH the bin and the manifest, and
//      compares every field against the local expectation.
//        On pass: sets `lastVerifyLevel=METADATA_ONLY`, `lastVerifiedAt`,
//        `errorCode=NONE`. Does NOT touch `attestedContentSha256`.
//        On fail: sets `errorCode=REMOTE_VERIFICATION_FAILED` and a
//        sanitized message. Does NOT change `status`. Does NOT touch
//        `attestedContentSha256`.
//
//   2. `verifyRemoteFullSha256(replicationId)` — downloads the .bin to
//      an isolated per-verify staging directory, computes SHA-256,
//      compares against `Backup.contentSha256`, and deletes the
//      staged file.
//        On pass: sets `lastVerifyLevel=FULL_SHA256`, `lastVerifiedAt`,
//        `attestedContentSha256 = <hex>`, `errorCode=NONE`.
//        On fail: sets `errorCode=REMOTE_CHECKSUM_MISMATCH` and a
//        sanitized message. Does NOT change `status`. Does NOT touch
//        `attestedContentSha256` on failure.
//
// Absolute rules (§M + §K restated):
//   * NEVER writes to `Backup.status` or `Backup.errorMessage`.
//   * NEVER flips the replication row's `status` back from COMPLETED
//     to FAILED. §K explicitly forbids state regression once a fact
//     (upload+metadata verify) has been established.
//   * NEVER logs the access token, session URI, or refresh token.
//   * Only operates on rows whose `status = COMPLETED`. Every other
//     status returns `SKIPPED_NOT_COMPLETED` — deep-verifying an
//     in-flight or failed row is nonsense.

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import type {
  BackupReplication,
  BackupReplicationErrorCode,
  PrismaClient
} from "@prisma/client";

import { classifyGoogleError } from "./classifier";
import { GoogleDriveOperationError } from "./errors";
import type { DriveFolderApi } from "./folder";
import type { HttpClient } from "./http";
import {
  MAX_BIN_BYTES,
  MAX_MANIFEST_BYTES,
  assertSafeFileId,
  deleteStagedFile,
  downloadDriveFile
} from "./download";
import {
  APP_PROPERTY_ARTIFACT,
  APP_PROPERTY_BACKUP_ID,
  BIN_MIME_TYPE,
  MANIFEST_MIME_TYPE,
  REPLICATION_DESTINATION,
  assertSafeId,
  remoteBinFileName,
  remoteManifestFileName
} from "./uploader";

// ─── Public types ─────────────────────────────────────────────────────────

export type VerifyRemoteDeps = {
  prisma: PrismaClient;
  /** Narrow Drive API — same shape used by folder/uploader. */
  drive: DriveFolderApi;
  http: HttpClient;
  /** Bearer token for the raw HTTP download (§J.1 FULL_SHA256 only). */
  accessToken: string;
  /** Layer-E-resolved folder id. */
  folderId: string;
  /**
   * Absolute staging root under which per-verify subdirectories are
   * created. The verify service is responsible for creating and
   * cleaning up its own subdirectory — it never writes directly here.
   */
  stagingRoot: string;
  now: () => Date;
  httpTimeoutMs: number;
};

export type VerifyRemoteResult =
  | {
      outcome: "OK";
      level: "METADATA_ONLY" | "FULL_SHA256";
      /** Present only when `level === "FULL_SHA256"`. */
      attestedContentSha256?: string;
    }
  | {
      outcome: "MISMATCH";
      errorCode: BackupReplicationErrorCode;
      sanitizedMessage: string;
    }
  | {
      outcome: "SKIPPED_NOT_COMPLETED";
      status: BackupReplication["status"];
    }
  | {
      outcome: "SKIPPED_NOT_REPLICATED";
    };

// ─── METADATA_ONLY verify ────────────────────────────────────────────────

export async function verifyRemoteMetadata(
  replicationId: string,
  deps: VerifyRemoteDeps
): Promise<VerifyRemoteResult> {
  const { rep, backup, guard } = await loadPreconditions(deps.prisma, replicationId);
  if (guard) return guard;
  assertSafeId("folderId", deps.folderId);

  try {
    const binOk = await checkRemoteObject(deps, {
      fileId: rep.remoteBinFileId!,
      expectedName: remoteBinFileName(rep.backupId),
      expectedSize: rep.remoteBinSize,
      expectedMd5: rep.remoteBinMd5,
      expectedMimeType: BIN_MIME_TYPE,
      artifact: "bin",
      backupId: rep.backupId
    });
    if (binOk !== "ok") {
      return await recordFailure(
        deps,
        replicationId,
        "REMOTE_VERIFICATION_FAILED",
        `REMOTE_VERIFICATION_FAILED: ${binOk} (.bin)`
      );
    }
    const manifestOk = await checkRemoteObject(deps, {
      fileId: rep.remoteManifestFileId!,
      expectedName: remoteManifestFileName(rep.backupId),
      expectedSize: rep.remoteManifestSize,
      expectedMd5: rep.remoteManifestMd5,
      expectedMimeType: MANIFEST_MIME_TYPE,
      artifact: "manifest",
      backupId: rep.backupId
    });
    if (manifestOk !== "ok") {
      return await recordFailure(
        deps,
        replicationId,
        "REMOTE_VERIFICATION_FAILED",
        `REMOTE_VERIFICATION_FAILED: ${manifestOk} (manifest)`
      );
    }
  } catch (err) {
    return await handleThrown(deps, replicationId, err);
  }

  const verifiedAt = deps.now();
  await deps.prisma.backupReplication.update({
    where: { id: replicationId },
    data: {
      lastVerifyLevel: "METADATA_ONLY",
      lastVerifiedAt: verifiedAt,
      errorCode: "NONE",
      errorMessage: null
    }
  });
  // Silence unused-lint: backup is read for the guard only.
  void backup;
  return { outcome: "OK", level: "METADATA_ONLY" };
}

// ─── FULL_SHA256 deep verify ─────────────────────────────────────────────

export async function verifyRemoteFullSha256(
  replicationId: string,
  deps: VerifyRemoteDeps
): Promise<VerifyRemoteResult> {
  const { rep, backup, guard } = await loadPreconditions(deps.prisma, replicationId);
  if (guard) return guard;
  assertSafeId("backupId", rep.backupId);

  const stagingDir = await mkdtemp(
    path.join(deps.stagingRoot, "drive-verify-")
  );
  let downloadedPath: string | null = null;
  try {
    assertSafeFileId(rep.remoteBinFileId!);
    const dl = await downloadDriveFile({
      http: deps.http,
      accessToken: deps.accessToken,
      fileId: rep.remoteBinFileId!,
      stagingRoot: stagingDir,
      fileName: remoteBinFileName(rep.backupId),
      maxBytes: MAX_BIN_BYTES,
      computeSha256: true,
      timeoutMs: deps.httpTimeoutMs
    });
    downloadedPath = dl.absolutePath;

    const expectedSha = backup.contentSha256;
    if (typeof expectedSha !== "string" || expectedSha.length !== 64) {
      return await recordFailure(
        deps,
        replicationId,
        "CONFIGURATION_ERROR",
        "CONFIGURATION_ERROR: local Backup.contentSha256 missing or malformed"
      );
    }
    if (dl.sha256Hex !== expectedSha) {
      return await recordFailure(
        deps,
        replicationId,
        "REMOTE_CHECKSUM_MISMATCH",
        "REMOTE_CHECKSUM_MISMATCH: downloaded .bin SHA-256 does not match Backup.contentSha256"
      );
    }

    const verifiedAt = deps.now();
    await deps.prisma.backupReplication.update({
      where: { id: replicationId },
      data: {
        lastVerifyLevel: "FULL_SHA256",
        lastVerifiedAt: verifiedAt,
        attestedContentSha256: dl.sha256Hex,
        errorCode: "NONE",
        errorMessage: null
      }
    });
    return {
      outcome: "OK",
      level: "FULL_SHA256",
      attestedContentSha256: dl.sha256Hex
    };
  } catch (err) {
    return await handleThrown(deps, replicationId, err);
  } finally {
    if (downloadedPath !== null) {
      await deleteStagedFile(downloadedPath).catch(() => undefined);
    }
    // Always tear down the per-verify staging subdirectory. `rm -rf`
    // semantics via node:fs/promises.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────

type Preconditions =
  | {
      rep: BackupReplication;
      backup: { id: string; contentSha256: string | null };
      guard: null;
    }
  | {
      rep: BackupReplication;
      backup: { id: string; contentSha256: string | null } | null;
      guard: VerifyRemoteResult;
    };

async function loadPreconditions(
  prisma: PrismaClient,
  replicationId: string
): Promise<Preconditions> {
  const rep = await prisma.backupReplication.findUnique({
    where: { id: replicationId }
  });
  if (rep === null) {
    // A caller passed a replication id that no longer exists — treat
    // as SKIPPED_NOT_REPLICATED (idempotent).
    return {
      rep: {} as BackupReplication,
      backup: null,
      guard: { outcome: "SKIPPED_NOT_REPLICATED" }
    };
  }
  if (rep.destination !== REPLICATION_DESTINATION) {
    return {
      rep,
      backup: null,
      guard: { outcome: "SKIPPED_NOT_REPLICATED" }
    };
  }
  if (rep.status !== "COMPLETED") {
    // Deep-verifying an in-flight or failed row is nonsense — the
    // remote object may not exist yet or may have never landed.
    return {
      rep,
      backup: null,
      guard: { outcome: "SKIPPED_NOT_COMPLETED", status: rep.status }
    };
  }
  if (
    typeof rep.remoteBinFileId !== "string" ||
    typeof rep.remoteManifestFileId !== "string" ||
    rep.remoteBinFileId.length === 0 ||
    rep.remoteManifestFileId.length === 0
  ) {
    return {
      rep,
      backup: null,
      guard: {
        outcome: "MISMATCH",
        errorCode: "REMOTE_VERIFICATION_FAILED",
        sanitizedMessage:
          "REMOTE_VERIFICATION_FAILED: replication row is COMPLETED but remote file ids are absent"
      }
    };
  }
  // READ-ONLY load of the Backup. This module MUST NOT write to
  // Backup.status (§M).
  const backup = await prisma.backup.findUnique({
    where: { id: rep.backupId },
    select: { id: true, contentSha256: true }
  });
  if (backup === null) {
    return {
      rep,
      backup: null,
      guard: { outcome: "SKIPPED_NOT_REPLICATED" }
    };
  }
  return { rep, backup, guard: null };
}

type MetadataCheck =
  | "ok"
  | "name_mismatch"
  | "size_mismatch"
  | "md5_mismatch"
  | "mimeType_mismatch"
  | "trashed"
  | "parents_mismatch"
  | "appProperties_mismatch";

async function checkRemoteObject(
  deps: VerifyRemoteDeps,
  input: {
    fileId: string;
    expectedName: string;
    expectedSize: bigint | null;
    expectedMd5: string | null;
    expectedMimeType: string;
    artifact: "bin" | "manifest";
    backupId: string;
  }
): Promise<MetadataCheck> {
  assertSafeFileId(input.fileId);
  const resp = await deps.drive.files.get({
    fileId: input.fileId,
    fields:
      "id,name,mimeType,trashed,size,md5Checksum,appProperties,parents"
  });
  const data = resp.data as {
    id?: string | null;
    name?: string | null;
    mimeType?: string | null;
    trashed?: boolean | null;
    size?: string | null;
    md5Checksum?: string | null;
    appProperties?: Record<string, string> | null;
    parents?: string[] | null;
  };
  if (data.name !== input.expectedName) return "name_mismatch";
  if (data.mimeType !== input.expectedMimeType) return "mimeType_mismatch";
  if (data.trashed === true) return "trashed";
  const parents = data.parents ?? [];
  if (!Array.isArray(parents) || !parents.includes(deps.folderId)) {
    return "parents_mismatch";
  }
  if (input.expectedSize !== null) {
    const sizeStr = data.size;
    const parsedSize =
      typeof sizeStr === "string" && /^\d+$/.test(sizeStr)
        ? BigInt(sizeStr)
        : null;
    if (parsedSize !== input.expectedSize) return "size_mismatch";
  }
  if (input.expectedMd5 !== null) {
    if (data.md5Checksum !== input.expectedMd5) return "md5_mismatch";
  }
  const props = data.appProperties ?? {};
  if (props[APP_PROPERTY_BACKUP_ID] !== input.backupId) {
    return "appProperties_mismatch";
  }
  if (props[APP_PROPERTY_ARTIFACT] !== input.artifact) {
    return "appProperties_mismatch";
  }
  return "ok";
}

async function recordFailure(
  deps: VerifyRemoteDeps,
  replicationId: string,
  errorCode: BackupReplicationErrorCode,
  sanitizedMessage: string
): Promise<VerifyRemoteResult> {
  // §K.10: deep-verify failure keeps the row COMPLETED so the row's
  // status still reflects "upload + metadata verify passed at some
  // point". The mismatch surfaces as errorCode + errorMessage; the
  // UI reads that via the label helper. NEVER change status here.
  await deps.prisma.backupReplication.update({
    where: { id: replicationId },
    data: {
      errorCode,
      errorMessage: truncateSanitizedMessage(sanitizedMessage, 512),
      // lastVerifiedAt is bumped so an operator can see WHEN the
      // failure was observed. lastVerifyLevel is UNCHANGED — a prior
      // successful METADATA_ONLY / FULL_SHA256 remains the last
      // known-good level.
      lastVerifiedAt: deps.now()
    }
  });
  return {
    outcome: "MISMATCH",
    errorCode,
    sanitizedMessage
  };
}

/**
 * Truncate a sanitized message to `byteLimit` UTF-8 bytes without
 * splitting a multi-byte code point. Current classifier messages are
 * ASCII-only, but this helper future-proofs the field against a
 * message that ever includes non-BMP characters — a naive
 * `String.prototype.slice` would risk landing a lone surrogate in
 * the DB (G6 LOW-1).
 */
function truncateSanitizedMessage(msg: string, byteLimit: number): string {
  const buf = Buffer.from(msg, "utf8");
  if (buf.byteLength <= byteLimit) return msg;
  // Walk backwards from `byteLimit` to a UTF-8 boundary (a byte whose
  // top two bits are not `10`, i.e. not a continuation byte).
  let end = byteLimit;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

async function handleThrown(
  deps: VerifyRemoteDeps,
  replicationId: string,
  err: unknown
): Promise<VerifyRemoteResult> {
  if (err instanceof GoogleDriveOperationError) {
    return await recordFailure(deps, replicationId, err.code, err.message);
  }
  const c = classifyGoogleError(err);
  return await recordFailure(deps, replicationId, c.code, c.sanitizedMessage);
}

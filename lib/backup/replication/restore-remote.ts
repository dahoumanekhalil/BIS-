import "server-only";

// Layer I — remote restore integration (Plan §N).
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §N.
//
// RBAC boundary: this is a library function. Callers (Layer P server
// actions) MUST enforce `requirePermission("backup.replication.restore")`
// AND `requirePermission("backup.restore")` before invoking, per §N.4.
// No authorization check happens inside this module.
//
// This module is the DOWNLOAD-FIRST leg of remote restore (§N.3
// "Path A, preferred, safest"). It:
//   1. Creates an isolated staging subdirectory under
//      `<storage>/staging/drive-restore-<opId>/`.
//   2. Downloads the .bin and .manifest.json from Drive with size
//      guards (MAX_BIN_BYTES / MAX_MANIFEST_BYTES).
//   3. Invokes `verifyBackup({ source: { kind: "staging", ... } })`.
//      The existing verifier's full crypto chain runs unchanged over
//      the downloaded bytes — HMAC + AES-GCM + content SHA-256 +
//      NDJSON structural + row-count consistency + schema
//      compatibility check.
//   4. On verify failure → aborts. Staging tree is torn down before
//      the failure surfaces.
//   5. On verify success:
//      * If a local `Backup` row for this backupId already exists →
//        refuses with `LOCAL_BACKUP_ALREADY_PRESENT`. The plan says
//        the operator must fall back to the existing local restore
//        rather than let this pipeline reshape local state.
//      * If no local row exists → inserts a `Backup(status=COMPLETED)`
//        row with `contentSha256` / `manifestSha256` / `schemaSha256`
//        derived from the manifest, and promotes the two staged files
//        into `published/`.
//
// Absolute invariants preserved:
//   * No plaintext ever leaves the encrypted `.bin` — the verifier is
//     the ONLY code that decrypts, and it does so in a bounded stream.
//   * No existing local Backup row's `status` is mutated by this
//     module. The invariant "nothing in lib/backup/replication/**
//     writes to Backup.status" (§M) refers to REGRESSING an existing
//     VERIFIED row; the module here only INSERTS a brand-new row when
//     none existed, which is a distinct action explicitly assigned to
//     the restore path by §N.3 step 5.
//   * The download uses the Layer H helper (`downloadDriveFile`) with
//     its Content-Length pre-check and post-buffer defence in depth.
//   * Staging teardown runs in a `finally` — no orphan files on
//     failure or on unexpected error.
//   * Every failure is sanitized. No bearer / session URI / URL ever
//     reaches the returned message or an audit row.
//   * This module returns an outcome; it does NOT invoke the existing
//     restore pipeline. Layer P's server action layer is responsible
//     for continuing to the existing `runRestore(...)` after a
//     successful `LOCAL_BACKUP_MATERIALIZED` outcome. That preserves
//     the entire restore control surface (confirmation phrase,
//     password re-auth, safety snapshot, actor-in-source check) —
//     none of it is duplicated or bypassed here.

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  BackupReplicationErrorCode,
  PrismaClient
} from "@prisma/client";

import { verifyBackup, type VerifyResult } from "@/lib/backup/verify";
import {
  assertStagingSubdir,
  deleteStagingSubdir,
  binFileName as publishedBinFileName,
  manifestFileName as publishedManifestFileName
} from "@/lib/backup/storage";
import { loadBackupStorageDir } from "@/lib/backup/config";
import { parseManifestUnverified } from "@/lib/backup/manifest";

import { classifyGoogleError } from "./classifier";
import { GoogleDriveOperationError } from "./errors";
import {
  MAX_BIN_BYTES,
  MAX_MANIFEST_BYTES,
  assertSafeFileId,
  downloadDriveFile
} from "./download";
import type { HttpClient } from "./http";
import {
  REPLICATION_DESTINATION,
  remoteBinFileName,
  remoteManifestFileName
} from "./uploader";

// ─── Public types ─────────────────────────────────────────────────────────

export type RemoteRestoreDeps = {
  prisma: PrismaClient;
  http: HttpClient;
  /** Bearer token for the raw HTTP downloads. */
  accessToken: string;
  now: () => Date;
  httpTimeoutMs: number;
  /**
   * Explicit staging root override (tests). Production callers pass
   * `undefined` and let the storage helper derive
   * `<BACKUP_STORAGE_DIR>/staging/`.
   */
  storageDirOverride?: string;
  /**
   * Caller-supplied Drive file ids. When set, the DB lookup for the
   * `BackupReplication` row is SKIPPED — this is the disaster-recovery
   * mode where the local DB may not carry a replication row at all
   * (e.g., restored from an earlier snapshot; §N.3 step 1). The
   * caller (a Layer P server action) is responsible for validating
   * that the ids belong to our folder + carry our backupId marker,
   * per the plan's operator-safety notes.
   *
   * When NOT set, the module falls back to Mode-1: look up the
   * `BackupReplication` row for `(backupId, GOOGLE_DRIVE)` and use
   * its `remoteBinFileId` / `remoteManifestFileId` fields.
   */
  overrideRemoteFileIds?: {
    remoteBinFileId: string;
    remoteManifestFileId: string;
  };
};

export type RemoteRestoreOutcome =
  | {
      outcome: "LOCAL_BACKUP_MATERIALIZED";
      backupId: string;
      operationId: string;
      binPath: string;
      manifestPath: string;
    }
  | {
      outcome: "REFUSED_LOCAL_ALREADY_PRESENT";
      backupId: string;
      operationId: string;
    }
  | {
      outcome: "REFUSED_NOT_REPLICATED";
      backupId: string;
      operationId: string;
    }
  | {
      outcome: "VERIFY_FAILED";
      backupId: string;
      operationId: string;
      code: string;
      stage: string;
      detail?: string;
    }
  | {
      outcome: "DOWNLOAD_FAILED";
      backupId: string;
      operationId: string;
      errorCode: BackupReplicationErrorCode;
      sanitizedMessage: string;
    };

// ─── Main entry ───────────────────────────────────────────────────────────

/**
 * Download the remote replica for `backupId` into an isolated staging
 * subdir, run the local verifier over the download, and — on success
 * for a backupId with no local row — insert a new `Backup(status=COMPLETED)`
 * row and promote the files into `published/`.
 *
 * The caller then invokes the existing restore pipeline via
 * `runRestore({ backupId, ... })` (Layer P), which enforces the full
 * restore control set (confirmation phrase, password re-auth, safety
 * snapshot, actor-in-source check). This module NEVER runs restore
 * itself.
 */
export async function downloadAndVerifyDriveBackup(
  backupId: string,
  deps: RemoteRestoreDeps
): Promise<RemoteRestoreOutcome> {
  const operationId = randomUUID();

  // Resolve the remote file ids. Either the caller supplied them
  // directly (Mode-2 DR path) or we look up the BackupReplication row
  // for this backupId (Mode-1 default).
  let remoteBinFileId: string;
  let remoteManifestFileId: string;
  if (deps.overrideRemoteFileIds) {
    remoteBinFileId = deps.overrideRemoteFileIds.remoteBinFileId;
    remoteManifestFileId = deps.overrideRemoteFileIds.remoteManifestFileId;
  } else {
    const rep = await deps.prisma.backupReplication.findUnique({
      where: {
        backupId_destination: {
          backupId,
          destination: REPLICATION_DESTINATION
        }
      },
      select: {
        id: true,
        status: true,
        remoteBinFileId: true,
        remoteManifestFileId: true,
        remoteFolderId: true
      }
    });
    if (
      rep === null ||
      rep.status !== "COMPLETED" ||
      typeof rep.remoteBinFileId !== "string" ||
      typeof rep.remoteManifestFileId !== "string"
    ) {
      return {
        outcome: "REFUSED_NOT_REPLICATED",
        backupId,
        operationId
      };
    }
    remoteBinFileId = rep.remoteBinFileId;
    remoteManifestFileId = rep.remoteManifestFileId;
  }
  assertSafeFileId(remoteBinFileId);
  assertSafeFileId(remoteManifestFileId);

  // Precondition: if a local Backup row for this id already exists,
  // refuse — the operator should use the existing local restore. This
  // prevents the download-first path from clobbering local state that
  // may be in an intermediate lifecycle stage (RUNNING / PENDING / a
  // MISSING row awaiting operator triage).
  const existing = await deps.prisma.backup.findUnique({
    where: { id: backupId },
    select: { id: true }
  });
  if (existing !== null) {
    return {
      outcome: "REFUSED_LOCAL_ALREADY_PRESENT",
      backupId,
      operationId
    };
  }

  // Create the isolated staging subdir. Its name is derived
  // server-side from a UUID — never operator input. The storage
  // helper validates the name and returns an absolute path under
  // `<storage>/staging/`.
  //
  // Override support for tests: allow the caller to point at an
  // arbitrary absolute staging root. Production callers do NOT set
  // this; the storage helper resolves from `loadBackupStorageDir()`.
  const stagingName = `drive-restore-${operationId}`;
  let stagingDir: string;
  try {
    stagingDir = deps.storageDirOverride
      ? await createOverrideStagingSubdir(
          deps.storageDirOverride,
          stagingName
        )
      : await assertStagingSubdir(stagingName);
  } catch {
    // G7-LOW-2: static message only; never interpolate `err.name` or
    // any other free-form byte from a caught exception into the
    // outcome shape.
    return {
      outcome: "DOWNLOAD_FAILED",
      backupId,
      operationId,
      errorCode: "CONFIGURATION_ERROR",
      sanitizedMessage:
        "CONFIGURATION_ERROR: staging subdir could not be created"
    };
  }

  try {
    // Download both files. Size ceilings apply per-file. Any Drive
    // failure is classified and returned as DOWNLOAD_FAILED.
    let binPath: string;
    let manifestPath: string;
    try {
      const binDl = await downloadDriveFile({
        http: deps.http,
        accessToken: deps.accessToken,
        fileId: remoteBinFileId,
        stagingRoot: stagingDir,
        fileName: publishedBinFileName(backupId),
        maxBytes: MAX_BIN_BYTES,
        computeSha256: false,
        timeoutMs: deps.httpTimeoutMs
      });
      binPath = binDl.absolutePath;
      const manifestDl = await downloadDriveFile({
        http: deps.http,
        accessToken: deps.accessToken,
        fileId: remoteManifestFileId,
        stagingRoot: stagingDir,
        fileName: publishedManifestFileName(backupId),
        maxBytes: MAX_MANIFEST_BYTES,
        computeSha256: false,
        timeoutMs: deps.httpTimeoutMs
      });
      manifestPath = manifestDl.absolutePath;
    } catch (err) {
      const classified = classifyForDownload(err);
      return {
        outcome: "DOWNLOAD_FAILED",
        backupId,
        operationId,
        errorCode: classified.code,
        sanitizedMessage: classified.sanitizedMessage
      };
    }

    // Verify the staged pair. `persist: false` + `source.kind === "staging"`
    // together guarantee the verifier NEVER writes to any Backup row.
    const verifyResult: VerifyResult = await verifyBackup({
      backupId,
      client: deps.prisma,
      persist: false,
      compareDb: false,
      source: {
        kind: "staging",
        dir: stagingDir,
        binName: publishedBinFileName(backupId),
        manifestName: publishedManifestFileName(backupId)
      }
    });
    if (verifyResult.outcome !== "VERIFIED") {
      return {
        outcome: "VERIFY_FAILED",
        backupId,
        operationId,
        code: verifyResult.code,
        stage: verifyResult.stage,
        detail: verifyResult.detail
      };
    }

    // Read + hash + parse the manifest BEFORE promotion (G7 INFO-2).
    // This closes the tiny TOCTOU window between the promote rename
    // and a subsequent read from the moved path — the bytes we hash
    // are the same bytes `verifyBackup` already HMAC-authenticated.
    const manifestBytes = await fs.readFile(manifestPath);
    const manifest = parseManifestUnverified(manifestBytes);
    const manifestSha256 = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    void verifyResult; // read-only reference — manifest is the ground truth

    // Promote the two files into published/. The existing storage
    // helpers refuse to overwrite existing published files, but the
    // "no local row exists" precondition above already ensures no
    // published files exist for this id (retention + reconcile
    // guarantees).
    const promoted = await promoteFilesToPublished(
      backupId,
      binPath,
      manifestPath,
      deps.storageDirOverride
    );

    // Insert the local Backup row (§N.3 step 5). Fields come from the
    // now-authenticated manifest. `status = COMPLETED` matches the
    // verifier's semantics: the download passed every crypto + structural
    // check, but the caller may still want to invoke the local verifier
    // (which will run again as part of the restore pipeline).
    await deps.prisma.backup.create({
      data: {
        id: backupId,
        status: "COMPLETED",
        kind: manifest.kind,
        schemaSha256: manifest.schemaSha256,
        appVersion: manifest.appVersion,
        formatVersion: manifest.formatVersion,
        encryptionVersion: manifest.encryptionVersion,
        sizeBytes: BigInt(manifest.sizeBytes),
        contentSha256: manifest.contentSha256,
        manifestSha256,
        fileName: publishedBinFileName(backupId),
        rowCounts: manifest.rowCounts,
        // G7 LOW-1: the manifest field is a Zod-validated ISO string.
        // Parse it into a Date explicitly rather than casting through
        // `unknown` — Prisma expects a real Date instance.
        startedAt: new Date(manifest.createdAt),
        completedAt: deps.now()
      }
    });

    return {
      outcome: "LOCAL_BACKUP_MATERIALIZED",
      backupId,
      operationId,
      binPath: promoted.binPath,
      manifestPath: promoted.manifestPath
    };
  } finally {
    // Always tear down the per-restore staging subdir. On a successful
    // promotion the files have already been moved (rename) out of it,
    // so this is a cleanup of the empty directory. On any failure this
    // wipes the downloaded artifacts so no leftover state exists.
    await deleteStagingSubdir(stagingDir).catch(() => undefined);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function classifyForDownload(err: unknown): {
  code: BackupReplicationErrorCode;
  sanitizedMessage: string;
} {
  if (err instanceof GoogleDriveOperationError) {
    return { code: err.code, sanitizedMessage: err.message };
  }
  const c = classifyGoogleError(err);
  return { code: c.code, sanitizedMessage: c.sanitizedMessage };
}

/**
 * Test-seam variant of `assertStagingSubdir` that lets a test supply
 * an arbitrary absolute staging root. Applies the SAME name-shape
 * validation as the production helper.
 *
 * G7 MEDIUM-1: fail-closed in production. `deps.storageDirOverride`
 * bypasses `loadBackupStorageDir()` — the same env var that
 * `deleteStagingSubdir` reads for its "refuse to rm outside root"
 * guard. A production caller that used the override would create
 * staging outside `<BACKUP_STORAGE_DIR>/staging/`, and the automatic
 * teardown in `finally` would silently do nothing (its guard would
 * reject the path), leaving downloaded artefacts orphaned. Refuse
 * the branch entirely when `NODE_ENV === "production"` so this test
 * seam cannot be reached by real traffic.
 */
async function createOverrideStagingSubdir(
  storageDirOverride: string,
  name: string
): Promise<string> {
  if (process.env.NODE_ENV === "production") {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: storageDirOverride is not available in production"
    );
  }
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 128 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith(".") ||
    path.isAbsolute(name)
  ) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: staging subdir name failed defensive slug check"
    );
  }
  const root = path.resolve(storageDirOverride);
  const stagingRoot = path.resolve(root, "staging");
  const dir = path.resolve(stagingRoot, name);
  if (path.dirname(dir) !== stagingRoot) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: staging subdir traversal detected"
    );
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Move the two staged files from `stagingDir` into
 * `<storage>/published/`. Reuses the storage layer's atomicity
 * discipline: bin first, then manifest; on manifest failure the bin
 * is rolled back. Never overwrites an existing published file.
 *
 * Uses `fs.rename` on the same filesystem — atomic on POSIX and, on
 * Windows, atomic when the destination does not exist (asserted).
 */
async function promoteFilesToPublished(
  backupId: string,
  binStagedPath: string,
  manifestStagedPath: string,
  storageDirOverride?: string
): Promise<{ binPath: string; manifestPath: string }> {
  const storageRoot = storageDirOverride
    ? path.resolve(storageDirOverride)
    : loadBackupStorageDir();
  const publishedDir = path.resolve(storageRoot, "published");
  await fs.mkdir(publishedDir, { recursive: true, mode: 0o700 });
  const binPublished = path.resolve(publishedDir, publishedBinFileName(backupId));
  const manifestPublished = path.resolve(
    publishedDir,
    publishedManifestFileName(backupId)
  );
  // Refuse to overwrite an existing published file. If we got here we
  // already confirmed no Backup row exists, so the presence of a file
  // is an orphan we do NOT own.
  await assertDoesNotExist(binPublished);
  await assertDoesNotExist(manifestPublished);
  await fs.rename(binStagedPath, binPublished);
  try {
    await fs.rename(manifestStagedPath, manifestPublished);
  } catch (err) {
    // Roll back the bin so we don't leave a manifest-less published
    // .bin behind for the reconciliation sweep to flag.
    try {
      await fs.rename(binPublished, binStagedPath);
    } catch {
      // best-effort
    }
    throw err;
  }
  return { binPath: binPublished, manifestPath: manifestPublished };
}

async function assertDoesNotExist(full: string): Promise<void> {
  try {
    await fs.access(full);
  } catch {
    return;
  }
  throw new GoogleDriveOperationError(
    "CONFIGURATION_ERROR",
    "CONFIGURATION_ERROR: refusing to overwrite an existing published file"
  );
}

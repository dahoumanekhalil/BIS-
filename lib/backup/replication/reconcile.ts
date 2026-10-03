import "server-only";

// Layer J — remote reconcile service (Plan §O).
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §O.
//
// One operation: given a `BackupReplication` row currently in COMPLETED
// status, run `files.get(remoteBinFileId)` and `files.get(remoteManifestFileId)`
// and record the outcome:
//   * Both present + non-trashed → clear any stale `REMOTE_MISSING`
//     errorCode. `lastVerifyLevel` and `attestedContentSha256` are
//     UNCHANGED (the caller can chain `verifyRemoteMetadata` /
//     `verifyRemoteFullSha256` for those).
//   * Either 404 or `trashed=true` → set `errorCode = REMOTE_MISSING`
//     with a sanitized message. `status` STAYS `COMPLETED` — §K.10:
//     no state regression once a fact (upload+metadata verify at some
//     historical point) has been established.
//   * Non-404 Drive failure → surface classified errorCode (rate limit,
//     network, etc.). Row stays COMPLETED.
//
// Absolute invariants (Layer J approval message):
//   * NEVER writes to `Backup.status` or `Backup.errorMessage`.
//   * NEVER flips the replication row's `status` — deep-verify /
//     reconcile failures are surfaced via `errorCode` only.
//   * NEVER logs the access token, session URI, or refresh token.
//   * Only operates on rows whose `status = COMPLETED`. Every other
//     status returns `SKIPPED_NOT_COMPLETED` — reconciling an
//     in-flight or failed row is nonsense.
//   * No `$transaction`. Drive I/O outside any Prisma tx.
//   * RBAC boundary: this is a library function. Callers (Layer P
//     server actions) MUST enforce `requirePermission(
//     "backup.replication.reconcile")` before invoking. No
//     authorization check happens inside this module.

import type {
  BackupReplication,
  BackupReplicationErrorCode,
  PrismaClient
} from "@prisma/client";

import { classifyGoogleError } from "./classifier";
import { GoogleDriveOperationError } from "./errors";
import type { DriveFolderApi } from "./folder";
import { assertSafeFileId } from "./download";
import { REPLICATION_DESTINATION } from "./uploader";

// ─── Public types ─────────────────────────────────────────────────────────

export type ReconcileReplicationDeps = {
  prisma: PrismaClient;
  drive: DriveFolderApi;
  now: () => Date;
};

export type ReconcileReplicationResult =
  | {
      outcome: "OK";
      binPresent: true;
      manifestPresent: true;
    }
  | {
      outcome: "REMOTE_MISSING";
      binPresent: boolean;
      manifestPresent: boolean;
    }
  | {
      outcome: "DRIVE_ERROR";
      errorCode: BackupReplicationErrorCode;
      sanitizedMessage: string;
    }
  | {
      outcome: "SKIPPED_NOT_COMPLETED";
      status: BackupReplication["status"];
    }
  | { outcome: "SKIPPED_NOT_REPLICATED" };

// ─── Main entry ───────────────────────────────────────────────────────────

/**
 * Reconcile the remote-file existence for a `BackupReplication` row.
 *
 * The `errorCode` field is the single durable output of this service.
 * `status`, `attestedContentSha256`, and `lastVerifyLevel` are NEVER
 * touched. A caller that wants to re-verify metadata / SHA-256 must
 * chain the Layer H `verifyRemote*` services after a successful
 * reconcile.
 */
export async function reconcileReplicationRemote(
  replicationId: string,
  deps: ReconcileReplicationDeps
): Promise<ReconcileReplicationResult> {
  const rep = await deps.prisma.backupReplication.findUnique({
    where: { id: replicationId }
  });
  if (rep === null) return { outcome: "SKIPPED_NOT_REPLICATED" };
  if (rep.destination !== REPLICATION_DESTINATION) {
    return { outcome: "SKIPPED_NOT_REPLICATED" };
  }
  if (rep.status !== "COMPLETED") {
    return { outcome: "SKIPPED_NOT_COMPLETED", status: rep.status };
  }
  if (
    typeof rep.remoteBinFileId !== "string" ||
    typeof rep.remoteManifestFileId !== "string"
  ) {
    // A COMPLETED row missing its file ids is a schema-invariant
    // break. Refuse to touch it — but do NOT try to invent state.
    return await recordDriveError(
      deps,
      replicationId,
      "REMOTE_VERIFICATION_FAILED",
      "REMOTE_VERIFICATION_FAILED: row is COMPLETED but remote file ids are absent"
    );
  }
  assertSafeFileId(rep.remoteBinFileId);
  assertSafeFileId(rep.remoteManifestFileId);

  // Check each file. `files.get` with 404 → present:false. Any other
  // failure is a Drive error that we do NOT translate to REMOTE_MISSING —
  // that would be wrong, because the file may still exist and Drive is
  // just having a bad day.
  const binResult = await probeFile(deps, rep.remoteBinFileId);
  if (binResult.state === "error") {
    return await recordDriveError(
      deps,
      replicationId,
      binResult.code,
      binResult.sanitizedMessage
    );
  }
  const manifestResult = await probeFile(deps, rep.remoteManifestFileId);
  if (manifestResult.state === "error") {
    return await recordDriveError(
      deps,
      replicationId,
      manifestResult.code,
      manifestResult.sanitizedMessage
    );
  }

  const binPresent =
    binResult.state === "present" && binResult.trashed !== true;
  const manifestPresent =
    manifestResult.state === "present" && manifestResult.trashed !== true;

  if (!binPresent || !manifestPresent) {
    const which =
      !binPresent && !manifestPresent
        ? "bin and manifest"
        : !binPresent
        ? "bin"
        : "manifest";
    // SANITIZATION LOCK: `which` is drawn from a fixed 3-element
    // alphabet above. Do NOT interpolate remote file ids, Drive
    // response bytes, exception messages, or any user-supplied
    // value into this errorMessage. Every other errorMessage in
    // the replication tree originates from `classifyGoogleError` —
    // this branch is the sole place a message is composed inline,
    // and that inline-safety property is what makes it safe.
    await deps.prisma.backupReplication.update({
      where: { id: replicationId },
      data: {
        errorCode: "REMOTE_MISSING",
        errorMessage: `REMOTE_MISSING: ${which} absent or trashed on Drive`.slice(0, 512),
        lastVerifiedAt: deps.now()
      }
    });
    return {
      outcome: "REMOTE_MISSING",
      binPresent,
      manifestPresent
    };
  }

  // Both present. Clear a stale REMOTE_MISSING if any. Do NOT touch
  // lastVerifyLevel / attestedContentSha256 — those are the province
  // of the Layer H verify services.
  if (rep.errorCode === "REMOTE_MISSING") {
    await deps.prisma.backupReplication.update({
      where: { id: replicationId },
      data: {
        errorCode: "NONE",
        errorMessage: null,
        lastVerifiedAt: deps.now()
      }
    });
  } else {
    // Even without a state change, bump `lastVerifiedAt` so an operator
    // can see that a reconcile ran.
    await deps.prisma.backupReplication.update({
      where: { id: replicationId },
      data: { lastVerifiedAt: deps.now() }
    });
  }
  return {
    outcome: "OK",
    binPresent: true,
    manifestPresent: true
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

type ProbeResult =
  | { state: "present"; trashed?: boolean }
  | { state: "missing" }
  | {
      state: "error";
      code: BackupReplicationErrorCode;
      sanitizedMessage: string;
    };

async function probeFile(
  deps: ReconcileReplicationDeps,
  fileId: string
): Promise<ProbeResult> {
  try {
    const resp = await deps.drive.files.get({
      fileId,
      fields: "id,trashed"
    });
    const data = resp.data as { id?: string | null; trashed?: boolean | null };
    if (typeof data.id !== "string" || data.id.length === 0) {
      return {
        state: "error",
        code: "REMOTE_VERIFICATION_FAILED",
        sanitizedMessage:
          "REMOTE_VERIFICATION_FAILED: files.get returned no id for the requested resource"
      };
    }
    return { state: "present", trashed: data.trashed === true };
  } catch (err) {
    if (err instanceof GoogleDriveOperationError) {
      // A folder/file-level 404 is our REMOTE_MISSING signal (§O.2).
      if (err.code === "DESTINATION_NOT_FOUND") return { state: "missing" };
      return {
        state: "error",
        code: err.code,
        sanitizedMessage: err.message
      };
    }
    const c = classifyGoogleError(err);
    if (c.code === "DESTINATION_NOT_FOUND") return { state: "missing" };
    return {
      state: "error",
      code: c.code,
      sanitizedMessage: c.sanitizedMessage
    };
  }
}

async function recordDriveError(
  deps: ReconcileReplicationDeps,
  replicationId: string,
  code: BackupReplicationErrorCode,
  sanitizedMessage: string
): Promise<ReconcileReplicationResult> {
  await deps.prisma.backupReplication.update({
    where: { id: replicationId },
    data: {
      errorCode: code,
      errorMessage: sanitizedMessage.slice(0, 512),
      lastVerifiedAt: deps.now()
    }
  });
  return {
    outcome: "DRIVE_ERROR",
    errorCode: code,
    sanitizedMessage
  };
}

import "server-only";

// Browser-safe projection of a `BackupReplication` row.
//
// Layer F rule (Layer approval message #12):
//   > Persist upload-session state only as specified; treat
//   > uploadSessionUri as sensitive and never expose it to browser/UI.
//
// `uploadSessionUri` and `uploadSessionExpiresAt` are the two fields
// that MUST never cross the client/server boundary. `uploadBytesSent`
// is also excluded — it is progress state useful to a worker
// reconciler, not to an admin dashboard, and its presence in a
// browser payload would leak upload progress that we would rather
// classify only via `status` (UPLOADING / RETRYABLE_FAILURE / …).
//
// A future admin UI (Layer P) MUST call `serializeReplicationForBrowser`
// on every row before returning it to a server-action response body.
// The regression test `backup-drive-serializer.test.ts` asserts that
// none of the forbidden fields ever appear in the projection, using a
// hand-crafted BackupReplication row that includes deliberately
// sensitive-looking data in every hidden field.

import type { BackupReplication } from "@prisma/client";

export type PublicReplicationView = {
  id: string;
  backupId: string;
  destination: string;
  status: string;
  errorCode: string;
  errorMessage: string | null;
  lastVerifyLevel: string;
  attestedContentSha256: string | null;
  lastVerifiedAt: string | null;
  uploadStartedAt: string | null;
  uploadCompletedAt: string | null;
  lastAttemptAt: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  remoteFolderId: string | null;
  remoteBinFileId: string | null;
  remoteManifestFileId: string | null;
  remoteBinSize: string | null; // BigInt → decimal string
  remoteManifestSize: string | null;
  remoteBinMd5: string | null;
  remoteManifestMd5: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Whitelist of fields exposed to the browser. Explicitly enumerated
 * so a schema addition (a new sensitive column) does NOT silently
 * ship to the client. If a future migration adds a bearer-equivalent
 * field, this list stays the same until an author consciously extends
 * it (and the reviewer says so).
 *
 * NEVER included: uploadSessionUri, uploadSessionExpiresAt, uploadBytesSent.
 */
export function serializeReplicationForBrowser(
  row: BackupReplication
): PublicReplicationView {
  return {
    id: row.id,
    backupId: row.backupId,
    destination: row.destination,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    lastVerifyLevel: row.lastVerifyLevel,
    attestedContentSha256: row.attestedContentSha256,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    uploadStartedAt: row.uploadStartedAt?.toISOString() ?? null,
    uploadCompletedAt: row.uploadCompletedAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    attemptCount: row.attemptCount,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    remoteFolderId: row.remoteFolderId,
    remoteBinFileId: row.remoteBinFileId,
    remoteManifestFileId: row.remoteManifestFileId,
    remoteBinSize: row.remoteBinSize === null ? null : row.remoteBinSize.toString(),
    remoteManifestSize:
      row.remoteManifestSize === null ? null : row.remoteManifestSize.toString(),
    remoteBinMd5: row.remoteBinMd5,
    remoteManifestMd5: row.remoteManifestMd5,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/**
 * Compile-time enumeration of the columns that MUST NEVER be in the
 * public view. Referenced by the test suite as a keys array to prove
 * the projection is missing each of them.
 *
 * This is not consumed by production code; it is a review artefact
 * kept in-source so a schema author cannot ignore it.
 */
export const REPLICATION_FIELDS_NEVER_PUBLIC = [
  "uploadSessionUri",
  "uploadSessionExpiresAt",
  "uploadBytesSent"
] as const;

export type ReplicationForbiddenField =
  (typeof REPLICATION_FIELDS_NEVER_PUBLIC)[number];

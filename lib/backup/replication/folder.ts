import "server-only";

// Runtime folder discovery for the Google Drive off-site backup
// replication subsystem (Layer E — docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md).
//
// Layer E scope (deliberately narrow — do NOT let this file grow into
// upload / verify / worker code):
//   * Resolve the Drive folder id we will replicate into.
//   * NEVER adopt a folder that lacks our `appProperties.marker`.
//   * NEVER auto-bootstrap. The operator initiates bootstrap via
//     `scripts/backup-drive-bootstrap.ts` — every deployment
//     side-effect stays visible + audited.
//
// Discovery order (§E.3, in strict priority):
//   1. `GOOGLE_DRIVE_FOLDER_ID` env override, if set.
//        → `files.get(fileId, fields=id,mimeType,appProperties,trashed)`
//        → adopt only if it looks like our folder (marker matches).
//   2. `BackupReplicationConfig.folderId` from DB, if non-null.
//        → same `files.get` + marker recheck.
//   3. Marker-based discovery via `files.list` filtered on
//        `appProperties.marker == <folderMarker>` and folder mime type.
//        → expect exactly one result. 0 → NOT_BOOTSTRAPPED refusal.
//          ≥2 → CONFIGURATION_ERROR / DUPLICATE_FOLDER_DETECTED.
//
// Absolute rules (Layer R restated):
//   * The folder id itself is NOT a secret (it appears in Drive URLs).
//     Emitting it in a log is fine. Emitting a Google response body,
//     header, or URL is not.
//   * Every Google failure flows through `classifyGoogleError` — the
//     `sanitizedMessage` is the ONLY string a caller may attach to
//     `BackupReplication.errorMessage`, an audit row, or an admin UI.

import type { drive_v3 } from "googleapis";

import { classifyGoogleError } from "./classifier";
import { GoogleDriveOperationError } from "./errors";

// ─── Constants (must match scripts/backup-drive-bootstrap.ts) ──────────────

export const APP_PROPERTY_MARKER_KEY = "marker";
export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/**
 * The marker is interpolated into a Drive `q=` quoted-string. The
 * Drive query grammar allows `\\` and `\'` as escapes, but the safer
 * defence is to refuse anything outside a conservative alphabet.
 * `bis2027-backup-folder-v1` (the seed default) satisfies this;
 * anything else is treated as a configuration error before it can
 * reach Drive.
 */
export const SAFE_MARKER_RE = /^[A-Za-z0-9._-]+$/;

export function assertSafeFolderMarker(marker: string): void {
  if (typeof marker !== "string" || marker.length === 0 || marker.length > 64) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: folder marker has unsafe length"
    );
  }
  if (!SAFE_MARKER_RE.test(marker)) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: folder marker contains unsafe characters"
    );
  }
}

// ─── Narrow Drive-facing interface ─────────────────────────────────────────
//
// The full `drive_v3.Drive` type is enormous. Layer E only touches
// `files.get` + `files.list`; expressing that as a narrow structural
// interface (a) makes tests trivial to write (no `google.drive`
// interceptor plumbing to fake), (b) keeps this module unaware of the
// wider googleapis surface, (c) means a future major-version bump of
// googleapis that reshapes `drive_v3` only needs a compile check on
// the two methods we consume.

export type DriveFileMeta = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  trashed?: boolean | null;
  appProperties?: { [key: string]: string } | null;
};

export type DriveFolderApi = {
  files: {
    get(params: {
      fileId: string;
      fields: string;
      supportsAllDrives?: boolean;
    }): Promise<{ data: DriveFileMeta }>;
    list(params: {
      q: string;
      fields: string;
      pageSize: number;
      spaces?: string;
      supportsAllDrives?: boolean;
    }): Promise<{ data: { files?: DriveFileMeta[] | null } }>;
  };
};

// Compile-time proof that the real `drive_v3.Drive` implements our
// narrow shape. If a future googleapis bump changes the method
// signatures we consume, this will fail typecheck instead of ambushing
// production at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _driveShapeCheck: (d: drive_v3.Drive) => DriveFolderApi = (d) => d;

// ─── Public types ──────────────────────────────────────────────────────────

export type FolderResolutionSource = "env" | "db" | "marker";

export type ResolvedFolder = {
  folderId: string;
  source: FolderResolutionSource;
};

export type FolderResolutionInput = {
  drive: DriveFolderApi;
  /**
   * The value of the `GOOGLE_DRIVE_FOLDER_ID` env var, already
   * validated + trimmed by `loadGoogleDriveConfig()`. `null` when
   * unset.
   */
  folderIdFromEnv: string | null;
  /**
   * The `BackupReplicationConfig.folderId` singleton row value. `null`
   * when the row has not been bootstrapped yet.
   */
  dbFolderId: string | null;
  /**
   * The `BackupReplicationConfig.folderMarker` singleton row value.
   * MUST match `SAFE_MARKER_RE`.
   */
  folderMarker: string;
};

// ─── Discovery ─────────────────────────────────────────────────────────────

/**
 * Resolve the Drive folder id following the §E.3 discovery order.
 * Pure — never writes to the DB. Persistence of a marker-discovered
 * folder id is a separate step owned by the worker (Layer L).
 *
 * Throws `GoogleDriveOperationError` on:
 *   * `DESTINATION_NOT_FOUND` — env or DB pointed at a folder that
 *     Drive returned 404 for.
 *   * `CONFIGURATION_ERROR`   — env or DB pointed at a folder whose
 *     `appProperties.marker` does not match ours (adoption refusal),
 *     or marker discovery hit zero or ≥ 2 results, or the marker is
 *     unsafe.
 *   * Any other classified Google error (rate limit, network, …).
 *
 * Every branch produces a sanitized message — no URL, no header, no
 * body byte can bubble up.
 */
export async function resolveGoogleDriveFolder(
  input: FolderResolutionInput
): Promise<ResolvedFolder> {
  assertSafeFolderMarker(input.folderMarker);

  // ── Path 1: env override ────────────────────────────────────────────
  if (input.folderIdFromEnv !== null && input.folderIdFromEnv.length > 0) {
    const meta = await safeFilesGet(input.drive, input.folderIdFromEnv);
    if (meta === "not_found") {
      // The operator set the env override to a folder id Drive does
      // not know about — either the id is wrong or the folder was
      // deleted. Fail closed.
      throw new GoogleDriveOperationError(
        "DESTINATION_NOT_FOUND",
        "DESTINATION_NOT_FOUND: GOOGLE_DRIVE_FOLDER_ID env override points at a folder Drive returned 404 for"
      );
    }
    assertLooksLikeOurFolder(meta, input.folderMarker, "env override");
    return { folderId: input.folderIdFromEnv, source: "env" };
  }

  // ── Path 2: DB canonical ────────────────────────────────────────────
  if (input.dbFolderId !== null && input.dbFolderId.length > 0) {
    const meta = await safeFilesGet(input.drive, input.dbFolderId);
    if (meta === "not_found") {
      throw new GoogleDriveOperationError(
        "DESTINATION_NOT_FOUND",
        "DESTINATION_NOT_FOUND: BackupReplicationConfig.folderId points at a folder Drive returned 404 for"
      );
    }
    assertLooksLikeOurFolder(meta, input.folderMarker, "DB config row");
    return { folderId: input.dbFolderId, source: "db" };
  }

  // ── Path 3: marker discovery (self-heal after DB restore) ───────────
  const q =
    `appProperties has { key='${APP_PROPERTY_MARKER_KEY}' and value='${input.folderMarker}' } ` +
    `and mimeType='${FOLDER_MIME_TYPE}' ` +
    `and trashed=false`;
  let listData: { files?: DriveFileMeta[] | null };
  try {
    const resp = await input.drive.files.list({
      q,
      fields: "files(id,name,mimeType,trashed,appProperties)",
      pageSize: 10,
      spaces: "drive"
    });
    listData = resp.data;
  } catch (err) {
    const c = classifyGoogleError(err);
    throw new GoogleDriveOperationError(
      c.code,
      c.sanitizedMessage,
      c.httpStatus,
      c.retryable
    );
  }

  const files = listData.files ?? [];
  if (files.length === 0) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: NOT_BOOTSTRAPPED — no folder found for the app marker; run scripts/backup-drive-bootstrap.ts"
    );
  }
  if (files.length > 1) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: DUPLICATE_FOLDER_DETECTED — multiple folders carry the app marker"
    );
  }

  const only = files[0]!;
  // Defence-in-depth: even though the `q=` filter is authoritative,
  // recheck marker + mime + trashed on the returned metadata. A future
  // Drive API change that returned an extra folder without the marker
  // (unlikely) would still fail closed.
  assertLooksLikeOurFolder(only, input.folderMarker, "marker discovery");
  const id = only.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: marker discovery returned a folder without an id"
    );
  }
  return { folderId: id, source: "marker" };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * `files.get` with 404 → `"not_found"` and every other failure routed
 * through the classifier. The `fields` list is fixed and minimal — no
 * PII, no user identifier, no owner info.
 */
async function safeFilesGet(
  drive: DriveFolderApi,
  fileId: string
): Promise<DriveFileMeta | "not_found"> {
  try {
    const resp = await drive.files.get({
      fileId,
      fields: "id,mimeType,trashed,appProperties"
    });
    return resp.data;
  } catch (err) {
    const c = classifyGoogleError(err);
    if (c.code === "DESTINATION_NOT_FOUND") return "not_found";
    throw new GoogleDriveOperationError(
      c.code,
      c.sanitizedMessage,
      c.httpStatus,
      c.retryable
    );
  }
}

/**
 * The single choke point that decides "is this folder OURS?".
 *
 * Refuses to adopt if the returned metadata does not present as a
 * live, non-trashed folder carrying our exact marker in
 * `appProperties`. Under `drive.file` scope Drive would 404 a folder
 * the app never touched, so reaching this predicate with a matching
 * marker is strong evidence the folder was created by this app; the
 * marker check adds a belt-and-braces guard against a mispasted env
 * override that happens to point at another `drive.file` folder from
 * a different bootstrap.
 *
 * `sourceLabel` is a fixed enum string — never a URL, never a value.
 */
function assertLooksLikeOurFolder(
  meta: DriveFileMeta,
  expectedMarker: string,
  sourceLabel: "env override" | "DB config row" | "marker discovery"
): void {
  if (meta.trashed === true) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      `CONFIGURATION_ERROR: ${sourceLabel} pointed at a trashed folder`
    );
  }
  if (meta.mimeType !== FOLDER_MIME_TYPE) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      `CONFIGURATION_ERROR: ${sourceLabel} pointed at a non-folder id`
    );
  }
  const props = meta.appProperties ?? {};
  const markerOnObject = props[APP_PROPERTY_MARKER_KEY];
  if (typeof markerOnObject !== "string" || markerOnObject !== expectedMarker) {
    // Deliberate no-adopt refusal — this is the invariant that keeps
    // a stray folder id (from another app, another environment, or a
    // typo) from being replicated into.
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      `CONFIGURATION_ERROR: ${sourceLabel} pointed at a folder that does not carry the app marker (adoption refused)`
    );
  }
}

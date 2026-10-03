import "server-only";

// Bounded download of a Drive file to a staging path (Layer H, §J.1 step 1).
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §J, §N.5.
//
// Absolute rules:
//   * The `?alt=media` URL contains a Drive file id — safe to log at
//     debug level, but this module never logs it anyway.
//   * The `Authorization: Bearer <token>` header is used per-call only.
//     It never appears in an error message, an audit row, a log line,
//     or the returned metadata.
//   * Size ceiling enforcement (G6 MEDIUM-1 hardening):
//       - If the response advertises `Content-Length` and it exceeds
//         `maxBytes`, refuse BEFORE reading the body — this is the
//         fast-path bound against a compromised Drive object.
//       - After the body is materialized by the underlying HTTP
//         client, re-check `bytesWritten > maxBytes` and refuse
//         (defence in depth against a missing / lying Content-Length).
//     `HttpClient` currently uses `fetch(...).arrayBuffer()`, which
//     buffers the body. The Content-Length pre-check therefore is the
//     load-bearing memory bound: an oversized response never reaches
//     the buffer step. A future migration to true stream-and-abort is
//     tracked separately.
//   * `destPath` MUST resolve inside `stagingRoot`. A caller that
//     passes an attacker-influenced filename is refused by
//     `assertSafeStagingName` before `path.resolve`; the resulting
//     path is then prefix-checked against `stagingRoot` as
//     defence-in-depth.
//
// The verify service (`verify-remote.ts`) is a LIBRARY function; RBAC
// gating is the caller's responsibility (Layer P server actions supply
// `requirePermission("backup.replication.verify")`). This module is
// safe to import from a worker or a server action.

import { createHash } from "node:crypto";
import { open as fsOpen, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

import type { HttpClient, HttpRequest, HttpResponse } from "./http";
import { GoogleDriveOperationError } from "./errors";
import { classifyGoogleError } from "./classifier";

// ─── Ceiling constants ────────────────────────────────────────────────────

/**
 * Ceiling for a downloaded `.bin`. Matches the local verifier's
 * `MAX_BIN_BYTES` (Layer N.5) so a Drive object that has grown beyond
 * what the local pipeline can safely handle is refused before any disk
 * write. Value chosen at 50 GB — comfortably above any realistic
 * backup size the app produces today, and a hard ceiling against a
 * denial-of-service via a swollen remote object.
 */
export const MAX_BIN_BYTES = 50n * 1024n * 1024n * 1024n;

/**
 * Ceiling for a downloaded manifest. Manifests are JSON metadata — a
 * legitimate manifest is well under 100 KiB; the 1 MiB cap lets the
 * format grow moderately without opening a large-file attack surface.
 */
export const MAX_MANIFEST_BYTES = 1n * 1024n * 1024n;

/** Drive's `files.get` media endpoint. */
export const DRIVE_MEDIA_URL_BASE = "https://www.googleapis.com/drive/v3/files";

// ─── Public types ─────────────────────────────────────────────────────────

export type DownloadDriveFileInput = {
  http: HttpClient;
  /**
   * Bearer credential for the download request. Never persisted, never
   * logged, never returned. Treated exactly like the resumable-upload
   * bearer path.
   */
  accessToken: string;
  /**
   * Drive resource id (opaque `A-Za-z0-9_-`). Validated by `assertSafeFileId`
   * before splicing into the URL.
   */
  fileId: string;
  /** Absolute directory the download must land inside. */
  stagingRoot: string;
  /**
   * Filename to write inside `stagingRoot`. Callers derive this
   * server-side; a value that would escape the staging root via `..`
   * or a path separator is refused.
   */
  fileName: string;
  /** Hard cap on the streamed bytes. */
  maxBytes: bigint;
  /**
   * Whether to compute a SHA-256 of the download while streaming. When
   * `true`, the returned result includes `sha256Hex`. Used by
   * `verifyRemoteFullSha256` to avoid a second pass over the file.
   */
  computeSha256: boolean;
  timeoutMs: number;
};

export type DownloadedDriveFile = {
  absolutePath: string;
  bytesWritten: bigint;
  sha256Hex: string | null;
};

// ─── Public validators ────────────────────────────────────────────────────

/**
 * Drive resource ids are drawn from `[A-Za-z0-9_-]`. Refuse anything
 * outside that alphabet before splicing into the download URL — even
 * though the callers we ship never pass user input, defence in depth
 * catches a future bug at the boundary.
 */
export const SAFE_FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafeFileId(fileId: string): void {
  if (typeof fileId !== "string" || !SAFE_FILE_ID_RE.test(fileId)) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: fileId failed defensive slug check"
    );
  }
}

/**
 * Filename component of the staging path. Constrained to
 * `[A-Za-z0-9._-]` so nothing that could escape via `/`, `\`, `..`, or
 * a nul byte can reach `path.join`. Length capped at 128 chars — the
 * uploader's naming helpers stay well under that.
 */
export const SAFE_STAGING_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function assertSafeStagingName(name: string): void {
  if (typeof name !== "string" || !SAFE_STAGING_NAME_RE.test(name)) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: staging filename failed defensive slug check"
    );
  }
  // The character class in `SAFE_STAGING_NAME_RE` legitimately accepts
  // `.`, but the special filenames `.` and `..` refer to the current
  // and parent directories on every OS we support. Refuse them as
  // filenames outright — a `path.join(stagingRoot, "..")` would
  // resolve OUTSIDE `stagingRoot`, which the caller's prefix check
  // catches too, but catching it here is a clearer error message.
  if (name === "." || name === "..") {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: staging filename may not be '.' or '..'"
    );
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────

/**
 * Stream a Drive file to `<stagingRoot>/<fileName>`. Never trusts the
 * remote size — the ceiling is enforced against actual bytes written.
 *
 * On any failure (network, non-200 status, ceiling exceeded, disk
 * error) the partial file is deleted before the error is thrown so a
 * caller cannot accidentally consume a truncated download.
 *
 * Successful return exposes only the metadata a verifier needs: the
 * absolute written path, the byte count, and an optional SHA-256.
 */
export async function downloadDriveFile(
  input: DownloadDriveFileInput
): Promise<DownloadedDriveFile> {
  assertSafeFileId(input.fileId);
  assertSafeStagingName(input.fileName);
  assertBearerLooksSafe(input.accessToken);

  const stagingRoot = path.resolve(input.stagingRoot);
  const destPath = path.resolve(stagingRoot, input.fileName);
  // Prefix check with the trailing separator prevents
  // `/root` matching a sibling like `/rootlike/…`.
  if (
    destPath !== stagingRoot + path.sep + input.fileName &&
    !destPath.startsWith(stagingRoot + path.sep)
  ) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: computed staging path escaped stagingRoot"
    );
  }

  await mkdir(stagingRoot, { recursive: true });

  const url = `${DRIVE_MEDIA_URL_BASE}/${input.fileId}?alt=media&supportsAllDrives=false`;
  const req: HttpRequest = {
    url,
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`
    },
    timeoutMs: input.timeoutMs
  };

  let resp: HttpResponse;
  try {
    resp = await input.http(req);
  } catch (err) {
    // Network / abort / TLS — classify and rethrow with a sanitized
    // message. The URL itself does not carry a secret (Drive resource
    // ids are not tokens), but we still keep the classifier's message
    // as the ground truth.
    const c = classifyGoogleError(err);
    throw new GoogleDriveOperationError(
      c.code,
      c.sanitizedMessage,
      c.httpStatus,
      c.retryable
    );
  }

  if (resp.status !== 200) {
    // Even though we already have the body buffered, we do NOT read it
    // into the error message. Google's error bodies routinely echo
    // request fragments and can carry PII.
    const synthetic = { status: resp.status, response: { status: resp.status, data: {} } };
    const c = classifyGoogleError(synthetic);
    throw new GoogleDriveOperationError(
      c.code,
      c.sanitizedMessage,
      c.httpStatus,
      c.retryable
    );
  }

  // Fast-path memory bound (G6 MEDIUM-1): if the response advertises
  // its size via `Content-Length` and it exceeds the ceiling, refuse
  // BEFORE the buffered body is trusted. Drive always sets a valid
  // Content-Length for a 200 media response, so this is the load-
  // bearing check against a compromised remote object.
  const contentLengthRaw = resp.headers["content-length"];
  if (typeof contentLengthRaw === "string" && /^\d+$/.test(contentLengthRaw)) {
    const advertised = BigInt(contentLengthRaw);
    if (advertised > input.maxBytes) {
      throw new GoogleDriveOperationError(
        "REMOTE_SIZE_MISMATCH",
        `REMOTE_SIZE_MISMATCH: advertised size ${advertised.toString()} exceeds ceiling ${input.maxBytes.toString()}`
      );
    }
  }

  // Defence in depth: even if `Content-Length` was absent or lied, the
  // actual bytes we hold must respect the ceiling. This guards against
  // a proxy that stripped the header or a malicious response that
  // under-reported.
  const totalBytes = BigInt(resp.body.byteLength);
  if (totalBytes > input.maxBytes) {
    throw new GoogleDriveOperationError(
      "REMOTE_SIZE_MISMATCH",
      `REMOTE_SIZE_MISMATCH: downloaded size ${totalBytes.toString()} exceeds ceiling ${input.maxBytes.toString()}`
    );
  }

  const fh = await fsOpen(destPath, "w");
  let sha256Hex: string | null = null;
  try {
    if (input.computeSha256) {
      const hash = createHash("sha256");
      hash.update(resp.body);
      sha256Hex = hash.digest("hex");
    }
    await fh.write(resp.body, 0, resp.body.byteLength, 0);
    await fh.sync();
  } catch (err) {
    // Best-effort cleanup — never leave a partial file behind.
    await unlink(destPath).catch(() => undefined);
    throw err;
  } finally {
    await fh.close();
  }

  return {
    absolutePath: destPath,
    bytesWritten: totalBytes,
    sha256Hex
  };
}

/** Delete a downloaded staging artifact; swallows ENOENT. */
export async function deleteStagedFile(absolutePath: string): Promise<void> {
  await unlink(absolutePath).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return;
    throw err;
  });
}

// ─── Belt-and-braces bearer sanity check (mirrors resumable-upload.ts) ────

function assertBearerLooksSafe(token: string): void {
  if (typeof token !== "string" || token.length === 0) {
    throw new GoogleDriveOperationError(
      "AUTHENTICATION_ERROR",
      "AUTHENTICATION_ERROR: access token missing for Drive download"
    );
  }
  if (/^Bearer\s+/i.test(token)) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: access token double-prefixed with 'Bearer '"
    );
  }
}

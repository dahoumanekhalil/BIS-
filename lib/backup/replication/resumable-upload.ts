import "server-only";

// Google Drive resumable upload protocol (§G).
//
// Session URI is a bearer-equivalent capability
// (https://developers.google.com/drive/api/guides/manage-uploads
//  §"Resumable upload"). It is composed of an opaque path + an
// `upload_id` query parameter that authorises the caller to PUT
// bytes into the session. Anyone with the URI can complete or corrupt
// the upload. Absolute rules:
//   * NEVER log the sessionUri (or any part of its URL).
//   * NEVER copy the sessionUri into an audit row.
//   * NEVER return the sessionUri from a server action.
//   * Layer P's browser projection MUST omit it (see serializer.ts).
//
// The public exports of this module never accept a `sessionUri` in a
// position that also carries user input — every function's `sessionUri`
// arg is threaded straight into an outbound request URL and then
// discarded. Never interpolated into a message.

import { HttpClient, HttpRequest, HttpResponse } from "./http";

// ─── Google endpoint (locked constant) ─────────────────────────────────────

/**
 * Drive v3 resumable upload endpoint. `supportsAllDrives=false` is
 * explicit — Layer F never uploads into a shared drive; the
 * app-managed folder from Layer E is always in the operator's My-Drive
 * under `drive.file` scope.
 */
export const DRIVE_RESUMABLE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=false";

// Non-final chunks must be a multiple of 256 KiB per Google's docs.
export const CHUNK_ALIGNMENT_BYTES = 256 * 1024;

export function alignChunkBytesDown(target: number): number {
  if (target <= 0) return CHUNK_ALIGNMENT_BYTES;
  const aligned =
    Math.floor(target / CHUNK_ALIGNMENT_BYTES) * CHUNK_ALIGNMENT_BYTES;
  return aligned < CHUNK_ALIGNMENT_BYTES ? CHUNK_ALIGNMENT_BYTES : aligned;
}

// ─── Sanitized error class ─────────────────────────────────────────────────

/**
 * Every non-2xx HTTP failure from the resumable protocol surfaces as
 * this class. The message NEVER contains the sessionUri, headers, or
 * body — only a stable snake_case reason code + HTTP status.
 */
export class ResumableUploadHttpError extends Error {
  readonly reason: string;
  readonly status: number;
  /** Lower-cased. Never `authorization` / `cookie` / `set-cookie`. */
  readonly retryAfterSeconds: number | null;

  constructor(reason: string, resp: HttpResponse) {
    super(`resumable_upload_error: ${reason} (HTTP ${resp.status})`);
    this.name = "ResumableUploadHttpError";
    this.reason = reason;
    this.status = resp.status;
    const raw = resp.headers["retry-after"];
    const parsed =
      typeof raw === "string" && /^\d+$/.test(raw)
        ? Number.parseInt(raw, 10)
        : NaN;
    this.retryAfterSeconds = Number.isFinite(parsed) ? parsed : null;
  }
}

// ─── Session initiation (§G.2 step 1) ──────────────────────────────────────

export type InitResumableSessionInput = {
  http: HttpClient;
  accessToken: string;
  folderId: string;
  fileName: string;
  mimeType: string;
  totalBytes: number;
  /**
   * appProperties are read-visible to any client holding the OAuth
   * token, but not to arbitrary third parties. We use them for
   * idempotency (backupId, artifact) and integrity attestation
   * (sizeBytes, contentSha256). NEVER include a secret here.
   */
  appProperties: Record<string, string>;
  timeoutMs: number;
};

/**
 * POST an upload metadata blob to Drive, retrieve the session URI.
 * On success, the URI is the ONLY piece of state the caller needs to
 * persist to resume across a process crash.
 *
 * On failure, throws `ResumableUploadHttpError` with a stable reason
 * code and no session/token/body content in the message.
 */
export async function initResumableSession(
  input: InitResumableSessionInput
): Promise<{ sessionUri: string }> {
  assertBearerLooksSafe(input.accessToken);
  const metadata = {
    name: input.fileName,
    mimeType: input.mimeType,
    parents: [input.folderId],
    appProperties: input.appProperties
  };
  const bodyBuf = Buffer.from(JSON.stringify(metadata), "utf-8");
  const req: HttpRequest = {
    url: DRIVE_RESUMABLE_UPLOAD_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.mimeType,
      "X-Upload-Content-Length": String(input.totalBytes),
      "Content-Length": String(bodyBuf.byteLength)
    },
    body: bodyBuf,
    timeoutMs: input.timeoutMs
  };
  const resp = await input.http(req);
  if (resp.status !== 200) {
    throw new ResumableUploadHttpError("init_failed", resp);
  }
  const location = resp.headers["location"];
  if (typeof location !== "string" || !location.startsWith("https://")) {
    throw new ResumableUploadHttpError("init_missing_location_header", resp);
  }
  return { sessionUri: location };
}

// ─── Chunk PUT (§G.2 step 2) ──────────────────────────────────────────────

export type PutChunkInput = {
  http: HttpClient;
  /** Bearer-equivalent capability. */
  sessionUri: string;
  chunk: Buffer;
  /** 0-based first byte of `chunk` within the full body. */
  startByte: number;
  totalBytes: number;
  timeoutMs: number;
};

export type PutChunkResult =
  | { state: "incomplete"; confirmedBytes: number }
  | {
      state: "complete";
      fileId: string;
      size: number;
      md5Checksum: string | null;
    };

/**
 * PUT a chunk to the session. Google responds with 308 + `Range:
 * bytes=0-K` while the upload is incomplete, and 200/201 + a JSON
 * file resource once the last byte is accepted.
 *
 * Chunk alignment: any non-final chunk MUST have `byteLength` that is
 * a multiple of 256 KiB. This function does NOT re-check that — the
 * caller (uploader) is responsible for slicing. A misaligned chunk
 * that Google rejects surfaces via the normal error path.
 */
export async function putChunk(
  input: PutChunkInput
): Promise<PutChunkResult> {
  if (input.chunk.byteLength === 0) {
    throw new ResumableUploadHttpError(
      "chunk_empty",
      { status: 400, headers: {}, body: Buffer.alloc(0) }
    );
  }
  // G4-LOW #3: defensively clamp the Range end to `totalBytes - 1`.
  // Google will 400 an overshooting Content-Range, but a caller bug
  // that computed endByte >= totalBytes should be caught here rather
  // than after a network round trip. `startByte >= totalBytes` is
  // also refused: a chunk past the end is always a caller bug.
  if (input.startByte < 0 || input.startByte >= input.totalBytes) {
    throw new ResumableUploadHttpError(
      "chunk_start_out_of_range",
      { status: 400, headers: {}, body: Buffer.alloc(0) }
    );
  }
  const rawEnd = input.startByte + input.chunk.byteLength - 1;
  if (rawEnd >= input.totalBytes) {
    throw new ResumableUploadHttpError(
      "chunk_end_exceeds_total",
      { status: 400, headers: {}, body: Buffer.alloc(0) }
    );
  }
  const endByte = rawEnd;
  const req: HttpRequest = {
    url: input.sessionUri,
    method: "PUT",
    headers: {
      "Content-Range": `bytes ${input.startByte}-${endByte}/${input.totalBytes}`,
      "Content-Length": String(input.chunk.byteLength)
    },
    body: input.chunk,
    timeoutMs: input.timeoutMs
  };
  const resp = await input.http(req);
  return interpretResponse(resp, input.totalBytes);
}

// ─── Status query on resume (§G.2 step 5) ──────────────────────────────────

export type QueryUploadOffsetInput = {
  http: HttpClient;
  sessionUri: string;
  totalBytes: number;
  timeoutMs: number;
};

export type QueryUploadOffsetResult =
  | { state: "incomplete"; confirmedBytes: number }
  | {
      state: "complete";
      fileId: string;
      size: number;
      md5Checksum: string | null;
    }
  | { state: "session_expired" };

/**
 * Ask Drive where in the session it stopped. Used at the top of every
 * resumable-upload retry so we don't re-send bytes Drive already has,
 * and to detect a session URI Drive has reclaimed (404/410 → tell
 * caller to start a new session).
 */
export async function queryUploadOffset(
  input: QueryUploadOffsetInput
): Promise<QueryUploadOffsetResult> {
  const req: HttpRequest = {
    url: input.sessionUri,
    method: "PUT",
    headers: {
      "Content-Range": `bytes */${input.totalBytes}`,
      "Content-Length": "0"
    },
    timeoutMs: input.timeoutMs
  };
  const resp = await input.http(req);
  if (resp.status === 404 || resp.status === 410) {
    return { state: "session_expired" };
  }
  return interpretResponse(resp, input.totalBytes);
}

// ─── Response interpreter (shared) ────────────────────────────────────────

function interpretResponse(
  resp: HttpResponse,
  totalBytes: number
): PutChunkResult {
  if (resp.status === 308) {
    // Google returns `Range: bytes=0-K` where K is the last confirmed
    // byte (0-indexed inclusive). Absence of Range means zero bytes
    // are confirmed.
    const range = resp.headers["range"];
    if (typeof range !== "string") {
      return { state: "incomplete", confirmedBytes: 0 };
    }
    const m = /^bytes=0-(\d+)$/.exec(range);
    if (m === null) {
      return { state: "incomplete", confirmedBytes: 0 };
    }
    const lastByte = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(lastByte) || lastByte < 0) {
      return { state: "incomplete", confirmedBytes: 0 };
    }
    return { state: "incomplete", confirmedBytes: lastByte + 1 };
  }
  if (resp.status === 200 || resp.status === 201) {
    let parsed: {
      id?: unknown;
      size?: unknown;
      md5Checksum?: unknown;
    };
    try {
      parsed = JSON.parse(resp.body.toString("utf-8")) as typeof parsed;
    } catch {
      throw new ResumableUploadHttpError("malformed_completion_body", resp);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new ResumableUploadHttpError("malformed_completion_body", resp);
    }
    const id = parsed.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ResumableUploadHttpError("missing_id_in_completion", resp);
    }
    const sizeRaw = parsed.size;
    const size =
      typeof sizeRaw === "string" && /^\d+$/.test(sizeRaw)
        ? Number.parseInt(sizeRaw, 10)
        : typeof sizeRaw === "number" && Number.isFinite(sizeRaw)
        ? sizeRaw
        : totalBytes;
    const md5 =
      typeof parsed.md5Checksum === "string" && parsed.md5Checksum.length > 0
        ? parsed.md5Checksum
        : null;
    return { state: "complete", fileId: id, size, md5Checksum: md5 };
  }
  // Every other status is an HTTP error. Do NOT read the body into
  // the error class — Google's error bodies routinely echo request
  // fragments; the response might carry a JSON with a `reason` code
  // but we do not extract it here (the classifier can inspect the
  // exception's `status` in isolation).
  throw new ResumableUploadHttpError("unexpected_status", resp);
}

// ─── Belt-and-braces bearer sanity check ──────────────────────────────────

/**
 * Detect the most common footgun: a caller passing a fully-formed
 * `Authorization: Bearer <token>` header value instead of the raw
 * token. That would double-prefix and cause Google to reject the
 * request — but more importantly it can indicate the caller is
 * pulling from a source that concatenates the header, which risks
 * leaking the full header into a log if the object is JSON-serialized.
 *
 * Refuses with a stable error message that contains NEITHER the
 * offending value NOR any hint of length / structure of it.
 */
function assertBearerLooksSafe(token: string): void {
  if (typeof token !== "string" || token.length === 0) {
    throw new ResumableUploadHttpError(
      "access_token_empty",
      { status: 401, headers: {}, body: Buffer.alloc(0) }
    );
  }
  if (/^Bearer\s+/i.test(token)) {
    throw new ResumableUploadHttpError(
      "access_token_double_prefixed",
      { status: 400, headers: {}, body: Buffer.alloc(0) }
    );
  }
}

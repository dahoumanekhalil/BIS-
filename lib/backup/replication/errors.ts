import "server-only";

import type { BackupReplicationErrorCode } from "@prisma/client";

// ─── Google Drive off-site backup replication — error model ────────────────
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §R.
//
// Absolute rules enforced here:
//   * `GoogleDriveOperationError.message` is ALWAYS a sanitized human
//     phrase built from the classifier. It NEVER contains a URL query
//     string, an `Authorization` header, an OAuth response body, a
//     refresh_token, an access_token, or a resumable-upload session URI.
//   * `sanitizeGoogleError` is the only entry point permitted to
//     transform an arbitrary Google/gaxios error into something a
//     caller may attach to a log line, audit row, or `BackupReplication`
//     row. It is deliberately narrow: it returns a name-only diagnostic
//     plus an HTTP status. It does NOT copy `err.message`, `err.stack`,
//     any header, or any body byte.
//
// The reason for the paranoid stance: googleapis + gaxios routinely
// embed the failing URL (which for a resumable upload contains the
// session token in its query string) and the response body (which for
// a token exchange contains the refresh_token and access_token) into
// the exception message and the exception's `.config` / `.response`
// properties. A single accidental `err.message` in a log would
// exfiltrate a live bearer credential.

// ─── Sanitized operation error ─────────────────────────────────────────────

export class GoogleDriveOperationError extends Error {
  /** Classified code stored on `BackupReplication.errorCode`. */
  readonly code: BackupReplicationErrorCode;

  /** HTTP status from Google, if the failure was HTTP. `null` for
   *  network / timeout / classification-time failures. */
  readonly httpStatus: number | null;

  /** True iff the classifier deems this retryable per §I. */
  readonly retryable: boolean;

  constructor(
    code: BackupReplicationErrorCode,
    /**
     * Sanitized message ready to write to `BackupReplication.errorMessage`.
     * MUST NOT contain a URL, an Authorization header, an OAuth response
     * body, a refresh token, an access token, or a session URI.
     * The classifier and its call sites are the only source of these
     * strings; do not construct one ad-hoc.
     */
    message: string,
    httpStatus: number | null = null,
    retryable = false
  ) {
    super(message);
    this.name = "GoogleDriveOperationError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

// ─── Sanitizer for pre-classification diagnostics ──────────────────────────

/**
 * Narrow the arbitrary exception surface of `googleapis` / `gaxios` down
 * to a name + status pair that is safe to log or attach to an audit
 * row. Deliberately does NOT return `err.message`, `err.stack`, headers,
 * bodies, URLs, or any other free-form byte from the exception.
 *
 * Use this at any call site that catches an exception BEFORE the
 * classifier has run and wants to log a diagnostic — the classifier
 * builds its own sanitized `sanitizedMessage`, so post-classification
 * you write that instead of anything from this function.
 */
export function sanitizeGoogleError(err: unknown): {
  name: string;
  httpStatus: number | null;
} {
  // Extract a safe class name. Never copy `err.message` — it may contain
  // the request URL (which for resumable uploads carries the upload
  // session token in the query string) or an OAuth response body.
  const name =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { constructor?: { name?: unknown } }).constructor?.name ===
      "string"
      ? (err as { constructor: { name: string } }).constructor.name
      : "Error";

  // Extract HTTP status if the exception has one, without ever touching
  // the response body / headers.
  const httpStatus = extractHttpStatus(err);

  return { name, httpStatus };
}

/**
 * Extract the HTTP status from a googleapis / gaxios error without
 * touching any other property. Multiple shapes are supported because
 * gaxios has evolved over the years and google-auth-library's token
 * exchange sometimes surfaces its own shape.
 */
export function extractHttpStatus(err: unknown): number | null {
  if (err === null || typeof err !== "object") return null;
  const raw = err as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  if (typeof raw.status === "number" && Number.isFinite(raw.status)) {
    return raw.status;
  }
  if (
    raw.response &&
    typeof raw.response === "object" &&
    typeof raw.response.status === "number" &&
    Number.isFinite(raw.response.status)
  ) {
    return raw.response.status;
  }
  // `code` on gaxios can be either a string (like ECONNRESET) or, in
  // very old versions, a number equal to the HTTP status. Only treat it
  // as a status when it is a plausible HTTP code.
  if (
    typeof raw.code === "number" &&
    Number.isFinite(raw.code) &&
    raw.code >= 100 &&
    raw.code < 600
  ) {
    return raw.code;
  }
  return null;
}

/**
 * Extract a system error code (like `ECONNRESET`) from a network
 * failure. Returns `null` when the error is HTTP-shaped or unknown.
 * Never returns a URL, hostname, or port — only the abbreviation.
 */
export function extractSystemErrorCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const raw = err as { code?: unknown };
  if (typeof raw.code === "string" && /^[A-Z_]+$/.test(raw.code)) {
    return raw.code;
  }
  return null;
}

/**
 * Extract Google's OAuth `error` field from a token-exchange failure.
 * Returns the exact enum value (`invalid_grant`, `invalid_client`,
 * `invalid_scope`, …) or `null` when the shape is different.
 *
 * IMPORTANT: this function reads ONLY the `error` field. It never
 * touches `error_description` — that field frequently echoes back the
 * refresh_token or client_id that Google rejected. Ignoring it here is
 * intentional; the classifier turns the enum into a fixed sanitized
 * phrase instead.
 */
export function extractOAuthErrorCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const raw = err as {
    response?: { data?: { error?: unknown } };
    data?: { error?: unknown };
  };
  const fromResponse = raw.response?.data?.error;
  if (typeof fromResponse === "string" && /^[a-z_]+$/.test(fromResponse)) {
    return fromResponse;
  }
  const fromData = raw.data?.error;
  if (typeof fromData === "string" && /^[a-z_]+$/.test(fromData)) {
    return fromData;
  }
  return null;
}

/**
 * Extract Google's per-error `reason` field (`storageQuotaExceeded`,
 * `userRateLimitExceeded`, `rateLimitExceeded`, `notFound`, …) from a
 * Drive API HTTP failure. Read-only; never touches messages, URLs, or
 * headers. Returns `null` when the shape is different.
 */
export function extractGoogleReason(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const raw = err as {
    errors?: Array<{ reason?: unknown }>;
    response?: {
      data?: {
        error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
      };
    };
  };
  const direct = raw.errors?.[0]?.reason;
  if (typeof direct === "string" && /^[A-Za-z]+$/.test(direct)) return direct;
  const nested = raw.response?.data?.error?.errors?.[0]?.reason;
  if (typeof nested === "string" && /^[A-Za-z]+$/.test(nested)) return nested;
  return null;
}

import "server-only";

import type { BackupReplicationErrorCode } from "@prisma/client";

import {
  extractGoogleReason,
  extractHttpStatus,
  extractOAuthErrorCode,
  extractSystemErrorCode
} from "./errors";

// ─── Single-source Google error classifier (Layer I) ───────────────────────
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §D.3 and §I.1.
//
// Given ANY thrown exception from a googleapis / gaxios call, produce a
// deterministic quadruple: (code, retryable, httpStatus, sanitizedMessage).
// The classifier is the ONLY function permitted to make a retryability
// decision — every worker + admin path threads its result through
// `GoogleDriveOperationError`.
//
// Sanitized message contract:
//   * Composed exclusively of enum codes + numeric HTTP status.
//   * Never contains a URL, a request/response body byte, a header
//     value, or any env value.
//   * Bounded well under 512 chars so it fits `BackupReplication.errorMessage`
//     without truncation. (Layer A caps the column at 512.)

export type GoogleErrorClassification = {
  code: BackupReplicationErrorCode;
  retryable: boolean;
  httpStatus: number | null;
  sanitizedMessage: string;
};

/**
 * Classify an arbitrary exception from googleapis. Precedence:
 *   1. OAuth token-exchange failures (HTTP 400 + `error` enum) —
 *      including the security-critical `invalid_grant` case which is
 *      classified as REVOKED_AUTHORIZATION (permanent, non-retryable).
 *   2. HTTP status code mapping (401 / 403 / 404 / 429 / 5xx).
 *   3. Network / timeout system errors (ECONNRESET / ETIMEDOUT / …).
 *   4. Fallback UNKNOWN.
 */
export function classifyGoogleError(err: unknown): GoogleErrorClassification {
  const httpStatus = extractHttpStatus(err);
  const oauthError = extractOAuthErrorCode(err);
  const reason = extractGoogleReason(err);
  const sysCode = extractSystemErrorCode(err);

  // ── 1. OAuth token-exchange errors (highest priority) ────────────────
  // `invalid_grant` MUST be classified as REVOKED_AUTHORIZATION — the
  // refresh token is dead, retrying only produces the same failure and
  // may burn our rate budget. §D.3 rule.
  if (oauthError === "invalid_grant") {
    return {
      code: "REVOKED_AUTHORIZATION",
      retryable: false,
      httpStatus,
      sanitizedMessage: "REVOKED_AUTHORIZATION: refresh token rejected by Google"
    };
  }
  if (oauthError === "invalid_client") {
    return {
      code: "CONFIGURATION_ERROR",
      retryable: false,
      httpStatus,
      sanitizedMessage: "CONFIGURATION_ERROR: OAuth client id or secret is invalid"
    };
  }
  if (oauthError === "invalid_scope") {
    return {
      code: "CONFIGURATION_ERROR",
      retryable: false,
      httpStatus,
      sanitizedMessage: "CONFIGURATION_ERROR: OAuth scope is not permitted for this client"
    };
  }
  if (oauthError === "unauthorized_client") {
    return {
      code: "CONFIGURATION_ERROR",
      retryable: false,
      httpStatus,
      sanitizedMessage: "CONFIGURATION_ERROR: OAuth client is not authorized for this grant type"
    };
  }
  // Any other OAuth error string of shape `snake_case`: don't leak it
  // by name, but keep it retryable=false and CONFIGURATION_ERROR — the
  // safer default at the auth boundary.
  if (oauthError !== null) {
    return {
      code: "CONFIGURATION_ERROR",
      retryable: false,
      httpStatus,
      sanitizedMessage: "CONFIGURATION_ERROR: OAuth token exchange rejected"
    };
  }

  // ── 2. HTTP status mapping ───────────────────────────────────────────
  if (httpStatus === 401) {
    // A single 401 is often a transient stale-token race. Layer D's
    // call site retries once after refresh; a SECOND 401 is escalated
    // to REVOKED_AUTHORIZATION at the call site — the classifier only
    // labels this as AUTHENTICATION_ERROR and marks it retryable.
    return {
      code: "AUTHENTICATION_ERROR",
      retryable: true,
      httpStatus,
      sanitizedMessage: "AUTHENTICATION_ERROR: HTTP 401 from Google"
    };
  }

  if (httpStatus === 403) {
    // 403 is ambiguous: could be rate-limit, quota exhaustion, or
    // permission denied. Inspect `reason` when available.
    if (
      reason === "userRateLimitExceeded" ||
      reason === "rateLimitExceeded"
    ) {
      return {
        code: "RATE_LIMITED",
        retryable: true,
        httpStatus,
        sanitizedMessage:
          "RATE_LIMITED: HTTP 403 rate limit (backoff and retry)"
      };
    }
    if (reason === "storageQuotaExceeded") {
      return {
        code: "QUOTA_EXCEEDED",
        retryable: false,
        httpStatus,
        sanitizedMessage: "QUOTA_EXCEEDED: Drive storage quota exhausted"
      };
    }
    return {
      code: "AUTHORIZATION_ERROR",
      retryable: false,
      httpStatus,
      sanitizedMessage:
        "AUTHORIZATION_ERROR: HTTP 403 — insufficient permission on the folder"
    };
  }

  if (httpStatus === 404) {
    return {
      code: "DESTINATION_NOT_FOUND",
      retryable: false,
      httpStatus,
      sanitizedMessage:
        "DESTINATION_NOT_FOUND: HTTP 404 — folder or file id no longer exists"
    };
  }

  if (httpStatus === 429) {
    return {
      code: "RATE_LIMITED",
      retryable: true,
      httpStatus,
      sanitizedMessage: "RATE_LIMITED: HTTP 429 from Google"
    };
  }

  if (httpStatus !== null && httpStatus >= 500 && httpStatus < 600) {
    return {
      code: "SERVER_ERROR",
      retryable: true,
      httpStatus,
      sanitizedMessage: `SERVER_ERROR: HTTP ${httpStatus} from Google`
    };
  }

  if (httpStatus === 410) {
    // Resumable-upload sessions can 410 when the session URI has been
    // reclaimed. Layer G handles this by starting a fresh session; the
    // classifier just labels it.
    return {
      code: "UPLOAD_SESSION_EXPIRED",
      retryable: true,
      httpStatus,
      sanitizedMessage: "UPLOAD_SESSION_EXPIRED: HTTP 410 — resumable session no longer valid"
    };
  }

  // ── 3. Network / timeout ─────────────────────────────────────────────
  if (sysCode === "ETIMEDOUT" || sysCode === "ESOCKETTIMEDOUT") {
    return {
      code: "TIMEOUT",
      retryable: true,
      httpStatus: null,
      sanitizedMessage: `TIMEOUT: ${sysCode}`
    };
  }
  if (
    sysCode !== null &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "ENETUNREACH",
      "EAI_AGAIN",
      "EPIPE"
    ].includes(sysCode)
  ) {
    return {
      code: "NETWORK_ERROR",
      retryable: true,
      httpStatus: null,
      sanitizedMessage: `NETWORK_ERROR: ${sysCode}`
    };
  }

  // ── 4. Fallback ──────────────────────────────────────────────────────
  return {
    code: "UNKNOWN",
    retryable: false,
    httpStatus,
    sanitizedMessage:
      httpStatus !== null
        ? `UNKNOWN: uncategorized error, HTTP ${httpStatus}`
        : "UNKNOWN: uncategorized error from Google"
  };
}

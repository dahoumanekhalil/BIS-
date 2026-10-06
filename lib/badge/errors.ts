// A single typed error for the badge service. The `code` field is stable and
// safe for callers to switch on; the `message` is intentionally short and
// carries no token material. Do NOT include raw tokens, hashes, or
// personally-identifying information in the message field — this class is
// what will end up in logs on unexpected paths.
export type BadgeErrorCode =
  | "PARTICIPANT_NOT_FOUND"
  | "ADMIN_NOT_FOUND"
  | "CREDENTIAL_NOT_FOUND"
  | "ACTIVE_EXISTS"
  // First issuance refused because the participant already has credential
  // history (e.g. an admin revoked it). Only an administrator may replace.
  | "HISTORY_EXISTS"
  // Stale or concurrent administrative operation. Safe, deterministic and
  // retryable after re-reading the current credential. Nothing was changed.
  | "CONFLICT"
  | "REASON_REQUIRED"
  // Per-admin hourly ceiling reached.
  | "RATE_LIMITED"
  // BADGE_QR_TOKEN_SECRET missing, invalid or reused. Never carries a value.
  | "SECRET_NOT_CONFIGURED"
  // The derived token does not match the stored hash (wrong/rotated secret).
  | "SECRET_MISMATCH";

export class BadgeError extends Error {
  readonly code: BadgeErrorCode;

  constructor(code: BadgeErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BadgeError";
    this.code = code;
  }
}

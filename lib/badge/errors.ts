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
  | "CONCURRENT_ROTATION";

export class BadgeError extends Error {
  readonly code: BadgeErrorCode;

  constructor(code: BadgeErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BadgeError";
    this.code = code;
  }
}

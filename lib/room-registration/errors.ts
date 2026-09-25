// Typed error for the RoomRegistration domain service. The `code`
// field is stable and safe for callers to switch on; the `message`
// is intentionally short and MUST NOT include raw tokens or PII.
//
// This error class is thrown from inside prisma.$transaction blocks
// so a Prisma transaction rollback is guaranteed on any thrown code.
// Callers translate the code into a user-facing outcome; the domain
// does not decide UI wording.
export type RoomRegistrationErrorCode =
  // Input identity
  | "PARTICIPANT_NOT_FOUND"
  | "ACCESS_POINT_NOT_FOUND"
  | "REGISTRATION_NOT_FOUND"
  | "ADMIN_NOT_FOUND"
  // AccessPoint eligibility
  | "ACCESS_POINT_INACTIVE"
  | "NOT_A_ROOM"
  // State machine
  | "INVALID_STATE_TRANSITION"
  // Input shape
  | "INVALID_INPUT"
  // Participant eligibility
  | "PARTICIPANT_CANCELLED"
  // Fallback for genuinely unexpected server-side errors. Kept
  // distinct from INVALID_INPUT so operators can tell "the client
  // sent junk" apart from "something inside the domain blew up".
  | "INTERNAL_ERROR";

export class RoomRegistrationError extends Error {
  readonly code: RoomRegistrationErrorCode;

  constructor(code: RoomRegistrationErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RoomRegistrationError";
    this.code = code;
  }
}

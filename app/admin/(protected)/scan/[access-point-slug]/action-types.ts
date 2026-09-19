// Shared types between the Phase 10 / 11 server actions and the
// client scanner UI. Kept in a plain module — no `"use server"`,
// no `import "server-only"`, no runtime side-effect — so a client
// component can `import type { ... }` at compile time without
// dragging any server code into the client bundle.

// Every stable outcome the QR scanner validators can return.
// The enum is intentionally FLAT — a single discriminant is easier
// for the scanner UI to switch on than a nested union. Shared by
// both the MAIN_ENTRANCE validator (Phase 10) and the ROOM
// validator (Phase 11).
//
// Semantics (locked, see master-doc):
//   VALID                    — authorized entrance. Phase 10 (main): first
//                              successful atomic claim; CheckIn(VALID) written.
//                              Phase 11 (room): every authorized scan writes
//                              a fresh CheckIn(VALID) — rooms allow repeat
//                              entry (C1 = A).
//   ALREADY_CHECKED_IN       — Phase 10 (main) only: atomic claim lost or
//                              repeat scan; CheckIn(ALREADY_CHECKED_IN)
//                              written. NOT produced by the room validator.
//   UNPAID                   — participant.paymentStatus !== PAID.
//                              CheckIn(UNPAID) written. No checkedInAt.
//   CANCELLED                — participant.status === CANCELLED OR
//                              verifyBadgeToken returned PARTICIPANT_CANCELLED.
//                              CheckIn(CANCELLED) or AuditLog only, depending
//                              on which path caught it.
//   PA_REVOKED               — ParticipantAccess row exists with
//                              granted === false (explicit admin revocation).
//                              Phase 10 (main): B1 rule C. Phase 11 (room):
//                              same code, room-specific PA row.
//                              CheckIn(UNKNOWN, reason=PA_REVOKED) written.
//   PA_NOT_GRANTED           — Phase 11 (room) ONLY: no ParticipantAccess row
//                              for this participant at this room. Rooms are
//                              default-deny (spec §14). CheckIn(UNKNOWN,
//                              reason=PA_NOT_GRANTED) written.
//                              MAIN_ENTRANCE never produces this outcome —
//                              main is default-allow when payment/eligibility
//                              are OK and no explicit PA revocation exists.
//   BADGE_INVALID            — verifyBadgeToken → INVALID; AuditLog only.
//   BADGE_REVOKED            — verifyBadgeToken → REVOKED; AuditLog only.
//   BADGE_EXPIRED            — verifyBadgeToken → EXPIRED; AuditLog only.
//   ACCESS_POINT_INACTIVE    — AP.active === false at validation time.
//   ACCESS_POINT_WRONG_TYPE  — main validator saw a ROOM AP (or vice versa).
//   ACCESS_POINT_UNKNOWN     — slug did not resolve.
export type ScannerOutcome =
  | "VALID"
  | "ALREADY_CHECKED_IN"
  | "UNPAID"
  | "CANCELLED"
  | "PA_REVOKED"
  | "PA_NOT_GRANTED"
  | "BADGE_INVALID"
  | "BADGE_REVOKED"
  | "BADGE_EXPIRED"
  | "ACCESS_POINT_INACTIVE"
  | "ACCESS_POINT_WRONG_TYPE"
  | "ACCESS_POINT_UNKNOWN";

// Backwards-compatible alias — Phase 10 code used `MainEntranceOutcome`.
// Kept so existing imports do not break as Phase 11 lands.
export type MainEntranceOutcome = ScannerOutcome;

// Shape returned by the server actions to the scanner client. All
// fields are already safe to render — no ids, no ticketCode, no
// tokenHash, no rawToken, no payment metadata. `participant` is
// populated ONLY when a participant was resolved server-side and the
// operator is allowed to see their name (i.e., not for BADGE_* /
// ACCESS_POINT_* outcomes).
export type ScannerValidationResult = {
  ok: boolean;
  outcome: ScannerOutcome;
  // Fixed French message the operator sees. Never carries internal
  // error strings, stack traces, or database identifiers.
  message: string;
  participant?: {
    firstName: string;
    lastName: string;
    tier: string | null;
  };
  // ISO timestamp of the effective check-in (this scan on VALID, the
  // prior successful scan on ALREADY_CHECKED_IN). Absent for all
  // other outcomes and for room scans (which do not persist
  // checkedInAt).
  at?: string;
};

// Backwards-compatible alias for Phase 10 consumers.
export type MainEntranceValidationResult = ScannerValidationResult;

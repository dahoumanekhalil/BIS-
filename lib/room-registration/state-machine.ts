import { RoomRegistrationStatus } from "@prisma/client";

// ─── Room registration state machine — pure, deterministic ────────────
//
// The FREE-only lifecycle has two states:
//
//   FREE_CONFIRMED  → CANCELLED
//
//   Re-registration path (ONLY through initRegistration()):
//     CANCELLED → FREE_CONFIRMED

type S = RoomRegistrationStatus;

const LIFECYCLE_TRANSITIONS: Record<S, ReadonlySet<S>> = {
  FREE_CONFIRMED: new Set<S>([RoomRegistrationStatus.CANCELLED]),
  CANCELLED: new Set<S>()
};

export function canTransition(from: S, to: S): boolean {
  return LIFECYCLE_TRANSITIONS[from].has(to);
}

// Statuses that grant registration-owned room access when synced.
export const GRANT_STATUSES: ReadonlySet<S> = new Set<S>([
  RoomRegistrationStatus.FREE_CONFIRMED
]);

// Statuses that revoke registration-owned room access when synced.
export const REVOKE_STATUSES: ReadonlySet<S> = new Set<S>([
  RoomRegistrationStatus.CANCELLED
]);

export function shouldGrant(status: S): boolean {
  return GRANT_STATUSES.has(status);
}

export function shouldRevoke(status: S): boolean {
  return REVOKE_STATUSES.has(status);
}

// Whether a given prior status is eligible for a fresh
// initRegistration re-run to move it back to an active state.
export function canReRegister(from: S): boolean {
  return from === RoomRegistrationStatus.CANCELLED;
}

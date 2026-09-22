import { RoomRegistrationStatus } from "@prisma/client";

// ─── Room registration state machine — pure, deterministic ────────────
//
// This module contains ONLY pure functions. No Prisma, no I/O, no
// side effects. The domain service composes this module with a Prisma
// transaction; the state machine itself is proven-safe by the tests.
//
// Approved transitions (Sub-Phase C §5):
//
//   PENDING_PAYMENT → PAID
//                   → PAYMENT_FAILED
//                   → CANCELLED
//                   → EXPIRED
//
//   PAID            → REFUNDED
//                   → CANCELLED
//
//   FREE_CONFIRMED  → CANCELLED
//
//   Re-registration path (ONLY through initRegistration()):
//     CANCELLED / REFUNDED / PAYMENT_FAILED / EXPIRED → PENDING_PAYMENT
//                                                     or FREE_CONFIRMED
//
//   All other transitions are REJECTED.

type S = RoomRegistrationStatus;

// The core transition table. `LIFECYCLE_TRANSITIONS[from]` is the set
// of statuses that a lifecycle mutation (confirm/fail/refund/cancel)
// is allowed to move a row into. Re-registration is handled separately
// (see canReRegister) — it is deliberately NOT part of this table,
// because re-registration is only permitted via initRegistration and
// never via a raw state mutation.
const LIFECYCLE_TRANSITIONS: Record<S, ReadonlySet<S>> = {
  PENDING_PAYMENT: new Set<S>([
    RoomRegistrationStatus.PAID,
    RoomRegistrationStatus.PAYMENT_FAILED,
    RoomRegistrationStatus.CANCELLED,
    RoomRegistrationStatus.EXPIRED
  ]),
  PAID: new Set<S>([
    RoomRegistrationStatus.REFUNDED,
    RoomRegistrationStatus.CANCELLED
  ]),
  FREE_CONFIRMED: new Set<S>([RoomRegistrationStatus.CANCELLED]),
  PAYMENT_FAILED: new Set<S>(),
  REFUNDED: new Set<S>(),
  CANCELLED: new Set<S>(),
  EXPIRED: new Set<S>()
};

// True iff a lifecycle mutation may move `from` to `to`.
export function canTransition(from: S, to: S): boolean {
  return LIFECYCLE_TRANSITIONS[from].has(to);
}

// Statuses that grant registration-owned room access when synced.
// Kept in one place so the sync service and the tests agree.
export const GRANT_STATUSES: ReadonlySet<S> = new Set<S>([
  RoomRegistrationStatus.FREE_CONFIRMED,
  RoomRegistrationStatus.PAID
]);

// Statuses that revoke registration-owned room access when synced.
// EXPIRED / PAYMENT_FAILED / PENDING_PAYMENT do NOT belong here —
// those statuses imply "no grant was ever materialised" (or has
// already been reverted).
export const REVOKE_STATUSES: ReadonlySet<S> = new Set<S>([
  RoomRegistrationStatus.CANCELLED,
  RoomRegistrationStatus.REFUNDED
]);

export function shouldGrant(status: S): boolean {
  return GRANT_STATUSES.has(status);
}

export function shouldRevoke(status: S): boolean {
  return REVOKE_STATUSES.has(status);
}

// Whether a given prior status is eligible for a fresh
// initRegistration re-run to move it back to an active state.
// Callers MUST route re-registration through initRegistration —
// this predicate exists so initRegistration knows whether a row
// can be re-activated or must be refused.
export function canReRegister(from: S): boolean {
  return (
    from === RoomRegistrationStatus.CANCELLED ||
    from === RoomRegistrationStatus.PAYMENT_FAILED ||
    from === RoomRegistrationStatus.EXPIRED
    // REFUNDED is deliberately excluded — a refund is a completed
    // financial reversal. The correct path to re-enter the room is
    // a fresh registration explicitly authorised by a stakeholder;
    // treating REFUNDED like CANCELLED would let a refunded pair
    // silently repay through the normal flow. Sub-Phase C keeps
    // that path closed unless a later phase adds an explicit
    // reactivation operation.
  );
}

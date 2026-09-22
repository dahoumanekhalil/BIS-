import type {
  RoomPaymentEventKind,
  RoomRegistrationStatus
} from "@prisma/client";
import type { RoomRegistrationErrorCode } from "./errors";

// ─── Public snapshot returned by every service call ───────────────────
//
// A stable, minimal projection of the RoomRegistration row. The
// service NEVER returns the raw Prisma model — this shape is what
// callers (server actions, future webhook receiver) may render or
// serialize. It intentionally omits internal metadata such as
// updatedAt or nullable timestamps that would only confuse callers.
export type RoomRegistrationView = {
  id: string;
  participantId: string;
  accessPointId: string;
  status: RoomRegistrationStatus;
  priceMinorSnapshot: number | null;
  currencySnapshot: string | null;
  paymentRef: string | null;
  registeredAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  failedAt: Date | null;
  expiresAt: Date | null;
};

// ─── Result shape ─────────────────────────────────────────────────────
//
// Uniform discriminated union used by every public service function.
// Mirrors the pattern used by `lib/badge/service.ts` and Phase 17
// action results — safe to switch on `ok`; no exception handling
// required for expected outcomes.
export type Ok<T> = { ok: true; value: T };
export type Err = {
  ok: false;
  code: RoomRegistrationErrorCode;
  message: string;
};
export type ServiceResult<T> = Ok<T> | Err;

// ─── Trusted payment confirmation ─────────────────────────────────────
//
// The value the domain accepts as authoritative for a PENDING_PAYMENT
// → PAID transition. The caller (admin server action today; future
// verified-webhook route) is trusted to have already authenticated
// the source. This shape carries NO amount or currency because the
// authoritative amount comes from the frozen RoomRegistration
// snapshot, per §12 of the Sub-Phase C spec — the adapter must not
// override participant / room / amount / currency / registration
// identity.
//
//   providerRef:    trusted transaction id from an external provider.
//                   NULL for admin-confirmed payments (the current
//                   phase's default path). When non-null, the domain
//                   enforces idempotency via the partial unique index
//                   on RoomPaymentEvent(registrationId, providerRef).
//   actorAdminId:   admin id when the transition was admin-confirmed.
//                   Recorded on RoomPaymentEvent.actorAdminId. Null
//                   for webhook-driven confirmations.
//
// Callers MUST NOT pass client-supplied values here without a
// server-side authenticity check.
export type TrustedPaymentConfirmation = {
  providerRef: string | null;
  actorAdminId: string | null;
  // Optional short reason string, whitelisted via meta-schema.ts on
  // the way into RoomPaymentEvent.meta. Free-form user input MUST be
  // sanitized/validated by the caller before it reaches here.
  reason?: string;
};

// ─── Input shapes for the five canonical operations ───────────────────
//
// Every input specifies the participant + accessPoint pair — that
// pair is the domain's uniqueness key. Callers cannot address a
// registration by internal id from this API; that keeps the surface
// intent-driven (register X for Y) rather than mutation-driven.

export type InitRegistrationInput = {
  participantId: string;
  accessPointId: string;
  // Optional soft deadline for completing a PENDING_PAYMENT
  // registration. Undefined => no deadline.
  expiresAt?: Date | null;
};

export type ConfirmPaymentInput = {
  participantId: string;
  accessPointId: string;
  confirmation: TrustedPaymentConfirmation;
};

export type FailPaymentInput = {
  participantId: string;
  accessPointId: string;
  actorAdminId: string | null;
  providerRef?: string | null;
  reason?: string;
};

export type RefundInput = {
  participantId: string;
  accessPointId: string;
  actorAdminId: string | null;
  providerRef?: string | null;
  reason?: string;
};

export type CancelInput = {
  participantId: string;
  accessPointId: string;
  actorAdminId: string | null;
  reason?: string;
};

// System-driven maintenance operation. See service.ts:expire and
// scripts/expire-room-registrations.ts. Never accepts an admin identity
// — expiry is not an authorised action, it is a deadline fact.
export type ExpireInput = {
  participantId: string;
  accessPointId: string;
  // Optional reference "now" used to compare against expiresAt.
  // Defaults to `new Date()`. Injected in tests for determinism; the
  // maintenance script does not pass it.
  at?: Date;
};

// ─── Event-kind mapping ───────────────────────────────────────────────
//
// The RoomPaymentEvent kind emitted by each canonical operation.
// Exported for the tests and to keep the mapping in one place.
export const OPERATION_EVENT_KIND = {
  INIT: "INIT",
  CONFIRM: "CONFIRM",
  FAIL: "FAIL",
  REFUND: "REFUND",
  CANCEL: "CANCEL"
} as const satisfies Record<string, RoomPaymentEventKind>;

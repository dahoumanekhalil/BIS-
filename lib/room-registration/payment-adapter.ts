import type { TrustedPaymentConfirmation } from "./types";

// ─── Payment adapter boundary — abstract only ─────────────────────────
//
// Sub-Phase A explicitly chose Option II: NO real payment provider
// integration in this phase, but design so a future provider slots
// in without redesigning the domain (RoomRegistration,
// ParticipantAccess, scanner, CheckIn all remain untouched).
//
// This module defines the shape that future provider adapters must
// satisfy. NO implementation exists yet — that would violate the
// "no fake provider" rule from Sub-Phase A §1 / Sub-Phase C §19.
//
// Contract for any future adapter:
//
//   1. The adapter is responsible for AUTHENTICATING the caller
//      (HMAC signature, IP allow-list, mTLS — provider-specific).
//      By the time it hands a TrustedPaymentConfirmation to the
//      domain, it MUST have completed that verification.
//
//   2. The adapter MUST NOT tell the domain the amount, currency,
//      participant, or room. Those are all resolved from the
//      RoomRegistration snapshot the domain already owns. The
//      adapter's only job is: "this providerRef is trusted".
//
//   3. The adapter MUST return the same `providerRef` for the
//      same underlying provider transaction across retries.
//      Duplicate deliveries are the norm, not the exception.
//      The domain enforces idempotency via the partial unique
//      index on RoomPaymentEvent(registrationId, providerRef).
//
//   4. The adapter MUST NOT leak secrets, headers, or raw
//      request bodies into the domain. Anything that reaches the
//      domain is subject to the RoomPaymentEvent.meta whitelist.
//
// ─── Sub-Phase F0 §5 — Amount / currency mismatch invariant ────────────
//
// A verified provider event that reports an amount or currency which
// does NOT match the RoomRegistration snapshot MUST NOT cause any
// domain state change. Specifically the future adapter/webhook MUST NOT
// call any of:
//
//   • confirmPayment(...)   — provider claims success but we cannot
//                             prove the amount matches, so we cannot
//                             grant access.
//   • failPayment(...)      — the provider MAY have captured money.
//                             Marking the registration PAYMENT_FAILED
//                             would tell operators "payment failed" while
//                             a real charge sits on the provider side.
//                             That is a reconciliation lie.
//   • refund(...)           — refund is only for provider-confirmed
//                             refund events, not for our own safety
//                             rejection of a mismatched success event.
//
// On mismatch the required behavior is:
//
//   1. Do not mutate RoomRegistration.status.
//   2. Do not emit a RoomPaymentEvent (CONFIRM, FAIL, REFUND, CANCEL).
//   3. Do not grant ParticipantAccess.
//   4. Do not revoke ParticipantAccess.
//   5. Write a single AuditLog row with:
//        action    = "payment.webhook.reconciliation_required"
//        entity    = "RoomRegistration"
//        entityId  = <registrationId>
//        userId    = null   (webhook has no admin actor)
//        meta      = { registrationId, providerRef,
//                      expectedMinor, actualMinor,
//                      expectedCurrency, actualCurrency,
//                      mismatchKind: "amount" | "currency" | "both" }
//      The Zod-strict `auditMetaSchema` (meta-schema.ts) rejects any
//      other key — raw webhook body, headers, signatures, PII, tokens
//      never reach AuditLog.
//   6. Return HTTP 200 to the provider so it does not retry the same
//      event indefinitely (the mismatch is not a delivery problem —
//      re-delivering will not resolve it). The 200 is an
//      acknowledgement of RECEIPT, not of business acceptance.
//
// Recovery is a HUMAN process: a Finance operator investigates the
// discrepancy (bad configuration on either side, tampering, mid-flight
// price change), then either:
//   • confirms the payment via the existing admin
//     `confirmRoomPaymentAction` (with a reason that references the
//     reconciliation audit row) — grants access, or
//   • initiates a refund with the provider and, once the provider's
//     own refund event arrives, calls the domain refund path — but the
//     domain refund path only accepts PAID → REFUNDED, so if the
//     registration is still PENDING_PAYMENT the operator instead
//     cancels the registration (`cancelRoomRegistrationAction`,
//     PENDING_PAYMENT → CANCELLED) after the out-of-band refund is
//     complete.
//
// A provider-confirmed FAILURE event (the provider itself says the
// charge did not go through) is ALWAYS distinct from a mismatch. Only
// that class of event may call failPayment().
//
// ─── Sub-Phase F0 §5b — providerRef correlation mismatch ───────────────
//
// A signature-verified event whose providerRef we've never observed
// via `initRegistration()` (checkout-initiation write) or a prior
// RoomPaymentEvent for the referenced registration is a DISTINCT
// class of failure: the signature is valid but the transaction
// identity is unknown to us for THIS registration. This can happen
// under:
//
//   • event replay across registrations (provider mis-routes),
//   • provider-side cross-account confusion,
//   • an attacker who has a valid signing secret and crafts a
//     lookalike event for a different transaction,
//   • our own initiate-call failing to persist the providerRef
//     before the webhook fires (bug in F1 to catch).
//
// Correlation-mismatch handling MUST follow the same audit-only rule
// as amount/currency mismatch:
//
//   1. Do not call confirmPayment, failPayment, refund, or cancel.
//   2. Do not emit a RoomPaymentEvent.
//   3. Do not grant / revoke ParticipantAccess.
//   4. Write one AuditLog row with:
//        action        = "payment.webhook.correlation_mismatch"
//        entity        = "RoomRegistration"
//        entityId      = <registrationId if resolvable, else null>
//        userId        = null
//        meta          = { registrationId?, providerRef,
//                          mismatchKind: "correlation" }
//      via the sanctioned helper `auditReconciliation()` in
//      `lib/room-registration/audit.ts`. The Zod-strict
//      `auditMetaSchema` blocks any other key from reaching AuditLog.
//   5. Return HTTP 200 — retries will not fix a correlation problem.
//
// Recovery is the same human path as §5: a Finance operator resolves
// the discrepancy out-of-band and then either confirms the correct
// registration manually or cancels the affected one.
//
// ─── Sub-Phase F0 §5c — Sanctioned audit path ──────────────────────────
//
// The ONLY sanctioned way to write a reconciliation AuditLog row is
// through `auditReconciliation()` in `lib/room-registration/audit.ts`.
// That helper runs `auditMetaSchema.parse(...)` BEFORE delegating to
// the generic `audit()` helper — this is the only guarantee that a
// future webhook implementer cannot bypass the whitelist by handing a
// raw event body straight to `audit({ meta: rawEvent })`. Reviews of
// F1 code MUST reject any direct call to `audit()` from a webhook
// route with `entity="RoomRegistration"`.
//
// Non-goals of this module:
//   • No provider SDK imports.
//   • No environment-variable reads.
//   • No network I/O.
//   • No HMAC helpers.

// The domain calls the adapter as: given an incoming provider event
// (identified opaquely by whatever the provider gave), verify it and
// return a TrustedPaymentConfirmation the domain can act on. The
// adapter may also produce an admin-side confirmation (with
// providerRef=null) when the current phase uses the admin-confirmed
// path.
//
// This type is intentionally minimal — Sub-Phase D or later may add
// fields (event kind, provider-specific correlation id, etc.).
// Adding fields must never expand what the adapter is allowed to
// override in the domain.
export type PaymentAdapter = {
  // Human-readable identifier used only in logs. Not a permission
  // decision.
  readonly kind: "admin-confirmed" | "stripe" | "chargily" | "cib" | "satim" | "edahabia";

  // Extract a TrustedPaymentConfirmation from a provider-shaped input.
  // The `input` type is `unknown` — the adapter must validate it.
  // Throwing here is fine; the caller catches into an Err result.
  verify(input: unknown): Promise<TrustedPaymentConfirmation>;
};

// A no-op sentinel used ONLY by Sub-Phase C tests that need to prove
// the domain does not depend on any concrete adapter. It intentionally
// throws so no production code path accidentally uses it.
export const NO_ADAPTER: PaymentAdapter = {
  kind: "admin-confirmed",
  verify: async () => {
    throw new Error(
      "No payment adapter is configured. Admin-confirmed payments are the only currently supported trust path and are handled directly at the server-action layer."
    );
  }
};

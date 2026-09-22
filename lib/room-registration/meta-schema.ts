import { z } from "zod";
import {
  RoomPaymentEventKind,
  RoomRegistrationStatus
} from "@prisma/client";

// ─── RoomPaymentEvent.meta whitelist ──────────────────────────────────
//
// Prisma Json columns accept anything by default. The Sub-Phase B
// security review flagged that this must be enforced at the service
// boundary — the DB will not do it. Every field written into
// RoomPaymentEvent.meta MUST match this schema; unknown keys are
// stripped by z.object(...).strict() so a caller cannot smuggle
// arbitrary payloads.
//
// Explicitly EXCLUDED from meta (never written by the domain
// service and rejected here if a caller tries to sneak them in):
//   • raw QR tokens / tokenHash / any credential material
//   • payment secrets (card numbers, CVVs, provider API keys)
//   • authorization headers, cookies, session tokens, passwords
//   • email addresses, phone numbers, or other PII beyond the
//     stable IDs already stored on RoomPaymentEvent columns
//   • raw provider request/response bodies
//
// The allowed fields are stable identifiers or short human-readable
// enum-style values. Free-form `reason` is capped and length-limited
// so it cannot become a data-exfiltration channel.

// Short human-readable reason. Not a free-form comment field —
// callers should pass one of a handful of stable codes ("admin_confirm",
// "webhook_delivery", "attendee_cancel", "admin_refund", …). We do
// not enforce a fixed enum yet (Sub-Phase D may formalise them),
// but we do cap length and strip control characters at the input
// boundary. Never emit user-supplied natural language here.
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9 _.:-]+$/,
    "reason must be short ASCII with only [A-Za-z0-9 _.:-]"
  )
  .optional();

// The stable transition summary the domain emits on every event.
const transitionSchema = z
  .object({
    before: z.nativeEnum(RoomRegistrationStatus),
    after: z.nativeEnum(RoomRegistrationStatus)
  })
  .strict()
  .optional();

// The whitelist itself. `.strict()` on z.object rejects unknown
// keys — critical for the "no secrets/PII injection via meta"
// promise. Every optional field is nullable-safe.
export const roomPaymentEventMetaSchema = z
  .object({
    transition: transitionSchema,
    reason: reasonSchema,
    priceMinorSnapshot: z.number().int().nonnegative().optional(),
    currencySnapshot: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "currency must be ISO 4217 3-letter code")
      .optional(),
    // The event kind is denormalised into meta so an admin scrolling
    // the AuditLog (which shares meta shape) can grep for "CONFIRM"
    // without joining. Enum-validated so it cannot be spoofed.
    kind: z.nativeEnum(RoomPaymentEventKind).optional(),
    // Explicit note when the event was admin-driven vs webhook-driven.
    // Not a permission decision — just a coarse label for auditors.
    source: z.enum(["admin", "webhook", "system"]).optional()
  })
  .strict();

export type RoomPaymentEventMeta = z.infer<typeof roomPaymentEventMetaSchema>;

// ─── AuditLog.meta shape for admin-visible operations ────────────────
//
// The `audit()` helper accepts `unknown`, but Sub-Phase C is careful
// about what it hands over. Same whitelist principles: no PII, no
// secrets, only stable identifiers.
// Reconciliation-audit fields — Sub-Phase F0 §5 mismatch invariant.
//
// A webhook that verifies signature-OK but detects an amount/currency
// discrepancy against the RoomRegistration snapshot MUST NOT mutate
// the domain (see payment-adapter.ts for the full rationale). It
// writes exactly one AuditLog row using these fields to describe the
// mismatch — nothing else. Every field is optional so the existing
// domain audit sites (which do not populate them) continue to
// validate; when populated they carry only integer minor units, ISO
// currency codes, and a short enum-style kind. No secrets, no raw
// bodies, no PII.
//
// F0 §5b (correlation): "correlation" covers a signature-verified
// event that reports a providerRef we've never initiated for this
// RoomRegistration. Same audit-only, no-domain-mutation rule.
const mismatchKindSchema = z
  .enum(["amount", "currency", "both", "correlation"])
  .optional();

// Shared regex applied to providerRef wherever it appears in an audit
// meta payload OR in a domain input. Real provider transaction ids
// from the candidate Algerian gateways (Chargily UUIDs, Stripe-style
// `ch_...`, CIB numeric sequences, PayPal `PAY-...`) all fit this
// character set. If F1 introduces a provider whose refs contain other
// characters, widen this regex in one place — the same shape is used
// by service.ts:optionalProviderRefSchema so a value that fails here
// never reaches the domain either. Defense-in-depth against a
// hostile / compromised provider planting HTML fragments that a
// future AuditLog viewer might render un-escaped.
export const providerRefRegex = /^[A-Za-z0-9_.:-]+$/;

export const auditMetaSchema = z
  .object({
    registrationId: z.string().min(1).optional(),
    accessPointId: z.string().min(1).optional(),
    participantId: z.string().min(1).optional(),
    providerRef: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(providerRefRegex, "providerRef must be [A-Za-z0-9_.:-]+")
      .nullable()
      .optional(),
    before: z.nativeEnum(RoomRegistrationStatus).nullable().optional(),
    after: z.nativeEnum(RoomRegistrationStatus).optional(),
    kind: z.nativeEnum(RoomPaymentEventKind).optional(),
    reason: reasonSchema,
    // Sub-Phase D §9 — true when the operation actually changed state
    // (fresh init, reactivation, confirm/refund/cancel/fail/expire).
    // false when the caller re-invoked the operation and the target
    // state was already reached (idempotent no-op). Callers use this to
    // distinguish "we did something" from "nothing to do" in audit
    // readouts without collapsing the two.
    transitioned: z.boolean().optional(),
    // Sub-Phase F0 §5 — reconciliation fields. Populated ONLY on
    // "payment.webhook.reconciliation_required" or
    // "payment.webhook.correlation_mismatch" audit rows written by a
    // future webhook handler. Values are integer minor units + ISO
    // currency codes; the schema does not accept a raw amount as a
    // string, a float, a negative, or a currency that isn't three
    // uppercase letters.
    expectedMinor: z.number().int().nonnegative().optional(),
    actualMinor: z.number().int().nonnegative().optional(),
    expectedCurrency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "currency must be ISO 4217 3-letter code")
      .optional(),
    actualCurrency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "currency must be ISO 4217 3-letter code")
      .optional(),
    mismatchKind: mismatchKindSchema
  })
  .strict();

export type RoomRegistrationAuditMeta = z.infer<typeof auditMetaSchema>;

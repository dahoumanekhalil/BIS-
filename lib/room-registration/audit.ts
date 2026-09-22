import "server-only";

import { audit } from "@/lib/admin/audit";
import { auditMetaSchema, type RoomRegistrationAuditMeta } from "./meta-schema";

// ─── Reconciliation audit — Sub-Phase F0 §5 / §5b / §5c ───────────────
//
// This is the ONLY sanctioned path to write a reconciliation AuditLog
// row from a (future) webhook handler. It exists because
// `lib/admin/audit.ts:audit(...)` accepts `meta: unknown` for
// compatibility with older domains — that generic surface is unsafe
// for the payment webhook layer, where a hostile provider payload
// could otherwise be handed straight to Prisma:
//
//   BAD  — bypasses whitelist:
//     await audit({
//       userId: null,
//       action: "payment.webhook.reconciliation_required",
//       entity: "RoomRegistration",
//       entityId: reg.id,
//       meta: rawWebhookBody   // ← raw body, headers, secrets leak in
//     });
//
//   GOOD — this helper:
//     await auditReconciliation({
//       action: "payment.webhook.reconciliation_required",
//       registrationId: reg.id,
//       meta: {
//         registrationId: reg.id,
//         providerRef,
//         expectedMinor, actualMinor,
//         expectedCurrency, actualCurrency,
//         mismatchKind: "amount"
//       }
//     });
//
// The helper enforces:
//
//   1. `auditMetaSchema.parse(...)` on the meta payload BEFORE it
//      reaches the DB. The Zod-strict schema rejects raw request
//      bodies, HTTP headers, API keys, signatures, cookies, PII, and
//      any credential material — see the F0 reconciliation-safety test
//      suite for the explicit reject list.
//   2. `userId: null` — a webhook has no admin actor. This helper
//      DOES NOT accept an actor argument, closing the possibility of
//      spoofing a specific admin on a reconciliation row.
//   3. `entity: "RoomRegistration"` — the reconciliation surface is
//      scoped to this one entity.
//   4. `action` is drawn from a small closed set. Free-form action
//      strings are not accepted so grep/alerting rules on the AuditLog
//      remain stable.
//
// Never call `audit()` directly from a payment webhook route. Any
// pull request that does so should be blocked at review time — the
// static check in
// `scripts/payment-reconciliation-safety.test.ts` will fire if the
// invariant doc in `payment-adapter.ts` is removed, but the code-
// review discipline is the primary defence.

export type ReconciliationAction =
  | "payment.webhook.reconciliation_required"
  | "payment.webhook.correlation_mismatch";

// The `meta` argument accepts `unknown` deliberately: a raw webhook
// body may arrive with unknown keys, and the caller may not have
// pre-shaped it. The helper's own `auditMetaSchema.parse(...)` call
// strips unknown keys and rejects malformed values. Successful return
// implies the row was written; a schema failure throws.
export async function auditReconciliation(input: {
  action: ReconciliationAction;
  registrationId: string;
  meta: unknown;
}): Promise<void> {
  const validated: RoomRegistrationAuditMeta = auditMetaSchema.parse(input.meta);
  await audit({
    userId: null,
    action: input.action,
    entity: "RoomRegistration",
    entityId: input.registrationId,
    meta: validated
  });
}

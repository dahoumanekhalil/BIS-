"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AccessPointType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import {
  cancel,
  confirmPayment,
  refund
} from "@/lib/room-registration/service";
import type { RoomRegistrationErrorCode } from "@/lib/room-registration/errors";
import { sendRoomRegistrationEmail } from "@/lib/email/triggers/room-registration";

// ─── Admin room-payment boundary (Sub-Phase D) ─────────────────────────
//
// This is the ONLY trusted server-side path that can:
//
//   • Confirm a PENDING_PAYMENT registration → PAID
//     (grants REGISTRATION-owned ParticipantAccess).
//   • Refund a PAID registration → REFUNDED
//     (revokes REGISTRATION-owned ParticipantAccess only —
//      ADMIN-owned rows are preserved by the domain service).
//   • Cancel a room registration → CANCELLED
//     (attendee-side cancellation lives in
//      `app/actions/room-registration.ts`; this admin variant lets an
//      operator cancel on the attendee's behalf and records the actor).
//
// Every action follows the standard admin action shape:
//
//   1. requirePermission(<perm>)          ← actor derived from session
//   2. Zod-parse inputs (ids + optional reason)
//   3. Resolve target as a real Participant (defends against passing
//      an AdminUser cuid into the participant slot)
//   4. Resolve target AccessPoint (defends against MAIN_ENTRANCE)
//   5. Delegate to the canonical domain service — the service handles
//      state transition, event emission, ParticipantAccess sync, and
//      audit under one transaction.
//   6. Return the ServiceResult translated to a safe UI shape. Never
//      surfaces raw Prisma errors, stack traces, or provider secrets.
//
// Trust boundary invariants (Sub-Phase D §6):
//   • actorAdminId is taken from `user.id` (session-derived).
//     A client-supplied actorAdminId is NEVER trusted.
//   • Amount + currency are re-read from the frozen registration
//     snapshot inside the domain service. This action MUST NOT accept
//     a price or currency from the browser — Zod .strict() would
//     reject them anyway, but no such fields exist in the schema so
//     the surface stays minimal.
//   • confirmPayment / refund are gated by dedicated permissions
//     (payment.confirm.room / payment.refund.room). Cancellation
//     reuses `access.manage` — cancelling a pending or free
//     registration is a permission the existing per-room access
//     administrators already hold.

const idSchema = z.string().trim().min(10).max(64);

// Short reason string. Same shape as the domain's meta-schema (short
// ASCII enum-style codes). We intentionally do NOT accept free-form
// natural language — free text belongs in AuditLog only where it will
// never surface to attendees. See lib/room-registration/meta-schema.ts.
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9 _.:-]+$/, "Motif invalide")
  .optional()
  .transform((s) => (s && s.length > 0 ? s : undefined));

const REVALIDATE_ROOTS = ["/admin/registrants"];
function revalidate(participantId: string) {
  for (const p of REVALIDATE_ROOTS) revalidatePath(p);
  revalidatePath(`/admin/registrants/${participantId}`);
}

export type AdminRoomPaymentResult =
  | { ok: true }
  | { ok: false; message: string; code?: RoomRegistrationErrorCode };

// Friendly-message table — same intent as the participant module but
// with an admin flavour (operators are staff, so we can be more
// specific about the underlying error while still refusing to leak
// database internals).
function adminFriendlyMessage(code: RoomRegistrationErrorCode): string {
  switch (code) {
    case "REGISTRATION_NOT_FOUND":
      return "Aucune inscription en salle n'existe pour ce couple participant/salle.";
    case "PARTICIPANT_NOT_FOUND":
      return "Participant introuvable.";
    case "PARTICIPANT_CANCELLED":
      return "Le participant est annulé — action refusée.";
    case "ACCESS_POINT_NOT_FOUND":
      return "Salle introuvable.";
    case "NOT_A_ROOM":
      return "Cible non valide : ce point d'accès n'est pas une salle.";
    case "ACCESS_POINT_INACTIVE":
      return "Cette salle est désactivée.";
    case "ADMISSION_MODE_NOT_SET":
      return "Le mode d'admission de la salle n'est pas configuré.";
    case "PAID_ROOM_MISSING_PRICE":
    case "PAID_ROOM_MISSING_CURRENCY":
    case "INVALID_PRICE":
    case "UNSUPPORTED_CURRENCY":
      return "Configuration de tarif invalide pour cette salle.";
    case "INVALID_STATE_TRANSITION":
    case "TERMINAL_STATE_PROTECTED":
      return "Transition impossible depuis l'état actuel.";
    case "LATE_FAILURE_ON_PAID":
      return "Impossible d'échouer un paiement déjà confirmé.";
    case "PROVIDER_REF_CONFLICT":
      return "Référence de paiement en conflit avec une transaction déjà enregistrée.";
    case "PROVIDER_REF_REQUIRED":
      return "Référence de paiement requise.";
    case "ADMIN_NOT_FOUND":
      return "Administrateur introuvable.";
    case "INVALID_INPUT":
    case "META_NOT_ALLOWED":
      return "Requête invalide.";
    case "INTERNAL_ERROR":
    default:
      return "Erreur interne. Consultez les journaux serveur.";
  }
}

// Resolve the (participantId, accessPointId) pair before touching the
// domain. This gives us actionable admin-facing error messages ("not
// a room") without depending on the ordering of domain checks.
async function assertRoomTarget(
  participantId: string,
  accessPointId: string
): Promise<AdminRoomPaymentResult | null> {
  const [p, ap] = await Promise.all([
    prisma.participant.findUnique({
      where: { id: participantId },
      select: { id: true }
    }),
    prisma.accessPoint.findUnique({
      where: { id: accessPointId },
      select: { id: true, type: true, active: true }
    })
  ]);
  if (!p) return { ok: false, message: adminFriendlyMessage("PARTICIPANT_NOT_FOUND"), code: "PARTICIPANT_NOT_FOUND" };
  if (!ap) return { ok: false, message: adminFriendlyMessage("ACCESS_POINT_NOT_FOUND"), code: "ACCESS_POINT_NOT_FOUND" };
  if (ap.type !== AccessPointType.ROOM) {
    return { ok: false, message: adminFriendlyMessage("NOT_A_ROOM"), code: "NOT_A_ROOM" };
  }
  return null;
}

// ─── confirm ────────────────────────────────────────────────────────────
//
// Trusted admin confirmation. Marks a PENDING_PAYMENT registration as
// PAID and grants REGISTRATION-owned ParticipantAccess through the
// domain sync. This is the only way payment can be confirmed in
// Sub-Phase D — there is no real payment provider yet, and there is
// no browser-side "mark as paid" path. See CLAUDE.md security notes.
export async function confirmRoomPaymentAction(
  participantId: string,
  accessPointId: string,
  reason?: string
): Promise<AdminRoomPaymentResult> {
  const { user } = await requirePermission("payment.confirm.room");

  const parsed = z
    .object({
      participantId: idSchema,
      accessPointId: idSchema,
      reason: reasonSchema
    })
    .safeParse({ participantId, accessPointId, reason });
  if (!parsed.success) {
    return {
      ok: false,
      message: adminFriendlyMessage("INVALID_INPUT"),
      code: "INVALID_INPUT"
    };
  }

  const targetErr = await assertRoomTarget(
    parsed.data.participantId,
    parsed.data.accessPointId
  );
  if (targetErr) return targetErr;

  const result = await confirmPayment({
    participantId: parsed.data.participantId,
    accessPointId: parsed.data.accessPointId,
    confirmation: {
      // The admin-confirmed path deliberately carries providerRef=null.
      // A real provider would populate this from a verified webhook —
      // out of scope for Sub-Phase D.
      providerRef: null,
      actorAdminId: user.id,
      reason: parsed.data.reason ?? "admin_confirm"
    }
  });

  if (!result.ok) {
    // Action-level audit of rejected admin attempts. The domain
    // service ONLY audits when a transition actually happens, so a
    // rejected confirm would otherwise be invisible in AuditLog.
    await audit({
      userId: user.id,
      action: "admin.room-payment.confirm.rejected",
      entity: "AccessPoint",
      entityId: parsed.data.accessPointId,
      meta: {
        code: result.code,
        participantId: parsed.data.participantId
      }
    }).catch(() => undefined);
    return {
      ok: false,
      message: adminFriendlyMessage(result.code),
      code: result.code
    };
  }

  // Confirmation email — idempotent by (registrationId, status). A double-
  // click on "confirm payment" fires once. Failure MUST NOT roll back the
  // confirmed payment (spec §26).
  sendRoomRegistrationEmail({
    registrationId: result.value.id,
    status: result.value.status
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[admin.room-payment] confirm email trigger failed", err instanceof Error ? err.message : err);
  });

  revalidate(parsed.data.participantId);
  return { ok: true };
}

// ─── refund ─────────────────────────────────────────────────────────────
//
// Trusted admin refund. Marks a PAID registration as REFUNDED and
// revokes REGISTRATION-owned ParticipantAccess (never touches
// source=ADMIN rows). CheckIn history is preserved by the domain.
export async function refundRoomPaymentAction(
  participantId: string,
  accessPointId: string,
  reason?: string
): Promise<AdminRoomPaymentResult> {
  const { user } = await requirePermission("payment.refund.room");

  const parsed = z
    .object({
      participantId: idSchema,
      accessPointId: idSchema,
      reason: reasonSchema
    })
    .safeParse({ participantId, accessPointId, reason });
  if (!parsed.success) {
    return {
      ok: false,
      message: adminFriendlyMessage("INVALID_INPUT"),
      code: "INVALID_INPUT"
    };
  }

  const targetErr = await assertRoomTarget(
    parsed.data.participantId,
    parsed.data.accessPointId
  );
  if (targetErr) return targetErr;

  const result = await refund({
    participantId: parsed.data.participantId,
    accessPointId: parsed.data.accessPointId,
    actorAdminId: user.id,
    providerRef: null,
    reason: parsed.data.reason ?? "admin_refund"
  });

  if (!result.ok) {
    await audit({
      userId: user.id,
      action: "admin.room-payment.refund.rejected",
      entity: "AccessPoint",
      entityId: parsed.data.accessPointId,
      meta: {
        code: result.code,
        participantId: parsed.data.participantId
      }
    }).catch(() => undefined);
    return {
      ok: false,
      message: adminFriendlyMessage(result.code),
      code: result.code
    };
  }

  sendRoomRegistrationEmail({
    registrationId: result.value.id,
    status: result.value.status
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[admin.room-payment] refund email trigger failed", err instanceof Error ? err.message : err);
  });

  revalidate(parsed.data.participantId);
  return { ok: true };
}

// ─── cancel ─────────────────────────────────────────────────────────────
//
// Admin-side cancellation. Gated by `access.manage` because cancelling
// a registration is a per-room access decision — the existing per-
// room access administrators (SUPER_ADMIN, ADMIN, REGISTRATION_MANAGER)
// already own that entitlement.
//
// Sub-Phase D §14 rule 8: FREE_CONFIRMED → CANCELLED is allowed. This
// action does NOT branch on admission mode — the domain service handles
// the state machine.
export async function cancelRoomRegistrationAction(
  participantId: string,
  accessPointId: string,
  reason?: string
): Promise<AdminRoomPaymentResult> {
  const { user } = await requirePermission("access.manage");

  const parsed = z
    .object({
      participantId: idSchema,
      accessPointId: idSchema,
      reason: reasonSchema
    })
    .safeParse({ participantId, accessPointId, reason });
  if (!parsed.success) {
    return {
      ok: false,
      message: adminFriendlyMessage("INVALID_INPUT"),
      code: "INVALID_INPUT"
    };
  }

  const targetErr = await assertRoomTarget(
    parsed.data.participantId,
    parsed.data.accessPointId
  );
  if (targetErr) return targetErr;

  const result = await cancel({
    participantId: parsed.data.participantId,
    accessPointId: parsed.data.accessPointId,
    actorAdminId: user.id,
    reason: parsed.data.reason ?? "admin_cancel"
  });

  if (!result.ok) {
    await audit({
      userId: user.id,
      action: "admin.room-registration.cancel.rejected",
      entity: "AccessPoint",
      entityId: parsed.data.accessPointId,
      meta: {
        code: result.code,
        participantId: parsed.data.participantId
      }
    }).catch(() => undefined);
    return {
      ok: false,
      message: adminFriendlyMessage(result.code),
      code: result.code
    };
  }

  sendRoomRegistrationEmail({
    registrationId: result.value.id,
    status: result.value.status
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[admin.room-registration] cancel email trigger failed", err instanceof Error ? err.message : err);
  });

  revalidate(parsed.data.participantId);
  return { ok: true };
}

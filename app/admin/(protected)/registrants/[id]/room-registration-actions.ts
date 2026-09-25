"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AccessPointType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { cancel } from "@/lib/room-registration/service";
import type { RoomRegistrationErrorCode } from "@/lib/room-registration/errors";

// ─── Admin room-registration boundary (FREE-only) ─────────────────────
//
// This is the ONLY trusted server-side path that can cancel a room
// registration on behalf of an attendee. Attendee-side self-
// cancellation lives in `app/actions/room-registration.ts`.
//
// Every action follows the standard admin action shape:
//
//   1. requirePermission("access.manage")    ← actor derived from session
//   2. Zod-parse inputs (ids + optional reason)
//   3. Resolve target as a real Participant + valid ROOM AccessPoint
//   4. Delegate to the canonical domain service.
//
// Trust boundary:
//   • actorAdminId is taken from `user.id` (session-derived).
//     A client-supplied actorAdminId is NEVER trusted.

const idSchema = z.string().trim().min(10).max(64);

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

export type AdminRoomRegistrationResult =
  | { ok: true }
  | { ok: false; message: string; code?: RoomRegistrationErrorCode };

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
    case "INVALID_STATE_TRANSITION":
      return "Transition impossible depuis l'état actuel.";
    case "ADMIN_NOT_FOUND":
      return "Administrateur introuvable.";
    case "INVALID_INPUT":
      return "Requête invalide.";
    case "INTERNAL_ERROR":
    default:
      return "Erreur interne. Consultez les journaux serveur.";
  }
}

async function assertRoomTarget(
  participantId: string,
  accessPointId: string
): Promise<AdminRoomRegistrationResult | null> {
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

export async function cancelRoomRegistrationAction(
  participantId: string,
  accessPointId: string,
  reason?: string
): Promise<AdminRoomRegistrationResult> {
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

  revalidate(parsed.data.participantId);
  return { ok: true };
}

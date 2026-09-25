"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AccessPointType,
  RegistrationStatus,
  RoomRegistrationStatus
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentAccount } from "@/lib/account/auth";
import { cancel, initRegistration } from "@/lib/room-registration/service";
import type { RoomRegistrationErrorCode } from "@/lib/room-registration/errors";
import { audit } from "@/lib/admin/audit";
import { isBlocked, record, THROTTLED_MESSAGE } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { sendRoomRegistrationEmail } from "@/lib/email/triggers/room-registration";

// ─── Participant-facing FREE room registration server actions ─────────
//
// This module is the ONLY entrypoint attendees use to register for a
// room. It is a thin application-level boundary:
//
//   1. Resolve the authenticated AccountUser from the cookie session.
//      NEVER trust participantId from the client — it is derived from
//      the session-bound AccountUser.
//   2. Resolve the Participant row owned by that account.
//   3. Validate participant eligibility (must not be CANCELLED).
//   4. Validate the requested AccessPoint (must exist, be a ROOM, be
//      active).
//   5. Delegate to the canonical `initRegistration()` / `cancel()`
//      domain service.

export type RegistrationActionResult =
  | {
      ok: true;
      status: RoomRegistrationStatus;
    }
  | { ok: false; message: string; code?: RoomRegistrationErrorCode | "UNAUTHENTICATED" | "NO_PARTICIPANT" | "THROTTLED" };

const REGISTRATION_ATTEMPTS_PER_ACCOUNT = 30;
const REGISTRATION_ATTEMPTS_PER_IP = 60;

const accessPointIdSchema = z.string().trim().min(10).max(64);

function friendlyMessage(code: RoomRegistrationErrorCode): string {
  switch (code) {
    case "PARTICIPANT_NOT_FOUND":
    case "PARTICIPANT_CANCELLED":
      return "Votre inscription BIS 2027 n'est pas éligible à l'inscription en salle.";
    case "ACCESS_POINT_NOT_FOUND":
    case "NOT_A_ROOM":
    case "ACCESS_POINT_INACTIVE":
      return "Cette salle n'est pas disponible à l'inscription.";
    case "REGISTRATION_NOT_FOUND":
      return "Aucune inscription à cette salle n'a été trouvée pour vous.";
    case "INVALID_STATE_TRANSITION":
      return "Cette action n'est pas disponible pour l'état actuel de votre inscription.";
    case "INVALID_INPUT":
      return "Requête invalide.";
    case "ADMIN_NOT_FOUND":
    case "INTERNAL_ERROR":
    default:
      return "Une erreur est survenue. Merci de réessayer.";
  }
}

async function resolveSessionParticipant(accountId: string) {
  return prisma.participant.findFirst({
    where: { accountUserId: accountId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true
    }
  });
}

async function resolveAccessPoint(accessPointId: string) {
  return prisma.accessPoint.findUnique({
    where: { id: accessPointId },
    select: {
      id: true,
      type: true,
      active: true
    }
  });
}

// ─── registerForRoom ────────────────────────────────────────────────────
//
// Self-service FREE registration entrypoint. Idempotent for existing
// live registrations — repeated invocations return the current state.
export async function registerForRoom(
  accessPointId: unknown
): Promise<RegistrationActionResult> {
  const account = await getCurrentAccount();
  if (!account) {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      message: "Merci de vous connecter pour vous inscrire à une salle."
    };
  }

  const parsed = accessPointIdSchema.safeParse(accessPointId);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Requête invalide."
    };
  }

  const ip = await clientIp();
  const accountKey = `room-registration:account:${account.id}`;
  const ipKey = `room-registration:ip:${ip ?? "shared"}`;
  if (
    isBlocked(accountKey, REGISTRATION_ATTEMPTS_PER_ACCOUNT) ||
    isBlocked(ipKey, REGISTRATION_ATTEMPTS_PER_IP)
  ) {
    return {
      ok: false,
      code: "THROTTLED",
      message: THROTTLED_MESSAGE
    };
  }
  record(accountKey);
  record(ipKey);

  const participant = await resolveSessionParticipant(account.id);
  if (!participant) {
    return {
      ok: false,
      code: "NO_PARTICIPANT",
      message:
        "Complétez votre inscription BIS 2027 avant de vous inscrire à une salle."
    };
  }
  if (participant.status === RegistrationStatus.CANCELLED) {
    return {
      ok: false,
      code: "PARTICIPANT_CANCELLED",
      message: friendlyMessage("PARTICIPANT_CANCELLED")
    };
  }

  const ap = await resolveAccessPoint(parsed.data);
  if (!ap) {
    return {
      ok: false,
      code: "ACCESS_POINT_NOT_FOUND",
      message: friendlyMessage("ACCESS_POINT_NOT_FOUND")
    };
  }
  if (ap.type !== AccessPointType.ROOM) {
    return {
      ok: false,
      code: "NOT_A_ROOM",
      message: friendlyMessage("NOT_A_ROOM")
    };
  }
  if (!ap.active) {
    return {
      ok: false,
      code: "ACCESS_POINT_INACTIVE",
      message: friendlyMessage("ACCESS_POINT_INACTIVE")
    };
  }

  const result = await initRegistration({
    participantId: participant.id,
    accessPointId: ap.id
  });

  if (!result.ok) {
    await audit({
      userId: null,
      action: "participant.room-registration.init.rejected",
      entity: "AccessPoint",
      entityId: ap.id,
      meta: { code: result.code, participantId: participant.id }
    }).catch(() => undefined);
    return { ok: false, code: result.code, message: friendlyMessage(result.code) };
  }

  sendRoomRegistrationEmail({
    registrationId: result.value.id,
    status: result.value.status
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[room-registration] email trigger failed",
      err instanceof Error ? err.message : err
    );
  });

  revalidatePath("/compte");
  revalidatePath("/compte/acces");

  return {
    ok: true,
    status: result.value.status
  };
}

// ─── cancelMyRoomRegistration ───────────────────────────────────────────
//
// Attendee-facing self-cancellation. Only revokes REGISTRATION-owned
// ParticipantAccess. Never touches ADMIN grants and never rewrites
// CheckIn history.
export async function cancelMyRoomRegistration(
  accessPointId: unknown
): Promise<RegistrationActionResult> {
  const account = await getCurrentAccount();
  if (!account) {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      message: "Merci de vous connecter."
    };
  }

  const parsed = accessPointIdSchema.safeParse(accessPointId);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Requête invalide."
    };
  }

  const ip = await clientIp();
  const accountKey = `room-registration:account:${account.id}`;
  const ipKey = `room-registration:ip:${ip ?? "shared"}`;
  if (
    isBlocked(accountKey, REGISTRATION_ATTEMPTS_PER_ACCOUNT) ||
    isBlocked(ipKey, REGISTRATION_ATTEMPTS_PER_IP)
  ) {
    return {
      ok: false,
      code: "THROTTLED",
      message: THROTTLED_MESSAGE
    };
  }
  record(accountKey);
  record(ipKey);

  const participant = await resolveSessionParticipant(account.id);
  if (!participant) {
    return {
      ok: false,
      code: "NO_PARTICIPANT",
      message: "Aucune inscription active à annuler."
    };
  }

  const result = await cancel({
    participantId: participant.id,
    accessPointId: parsed.data,
    actorAdminId: null,
    reason: "attendee_cancel"
  });

  if (!result.ok) {
    await audit({
      userId: null,
      action: "participant.room-registration.cancel.rejected",
      entity: "AccessPoint",
      entityId: parsed.data,
      meta: { code: result.code, participantId: participant.id }
    }).catch(() => undefined);
    return { ok: false, code: result.code, message: friendlyMessage(result.code) };
  }

  sendRoomRegistrationEmail({
    registrationId: result.value.id,
    status: result.value.status
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[room-registration] email trigger failed",
      err instanceof Error ? err.message : err
    );
  });

  revalidatePath("/compte");
  revalidatePath("/compte/acces");

  return {
    ok: true,
    status: result.value.status
  };
}

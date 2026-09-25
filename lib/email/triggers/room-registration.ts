import "server-only";

import type { RoomRegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { queueTemplatedEmail, EVENT_VARS } from "@/lib/email/queue";

// Room-registration email triggers (FREE-only). One helper per state
// transition. Each carries a deterministic idempotency key so a
// double-clicked cancel button or a re-fired domain event does not
// send two emails.

const TEMPLATE_KEY: Record<RoomRegistrationStatus, string | null> = {
  FREE_CONFIRMED: "room-registration-free-confirmed",
  CANCELLED: "room-registration-cancelled"
};

/**
 * Fire the appropriate email for a room-registration state transition.
 * NEVER throws — logs and returns a discriminated result so the caller
 * can decide whether to surface anything to the operator.
 */
export async function sendRoomRegistrationEmail({
  registrationId,
  status
}: {
  registrationId: string;
  status: RoomRegistrationStatus;
}): Promise<
  | { ok: true; deduped: boolean }
  | { ok: false; reason: string }
  | { ok: true; skipped: true }
> {
  const templateKey = TEMPLATE_KEY[status];
  if (!templateKey) return { ok: true, skipped: true };

  const registration = await prisma.roomRegistration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      participant: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true
        }
      },
      accessPoint: {
        select: { name: true }
      }
    }
  });
  if (!registration) {
    return { ok: false, reason: "registration-not-found" };
  }
  if (!registration.participant || !registration.participant.email) {
    return { ok: false, reason: "participant-not-found" };
  }

  const p = registration.participant;
  return queueTemplatedEmail({
    templateKey,
    to: p.email,
    toName: `${p.firstName} ${p.lastName}`,
    participantId: p.id,
    idempotencyKey: `room-reg:${registration.id}:${status}`,
    vars: {
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: `${p.firstName} ${p.lastName}`,
      email: p.email,
      roomName: registration.accessPoint.name,
      ...EVENT_VARS
    }
  });
}

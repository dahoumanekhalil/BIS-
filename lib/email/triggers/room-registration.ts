import "server-only";

import type { RoomRegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { queueTemplatedEmail, EVENT_VARS } from "@/lib/email/queue";

// Room-registration email triggers. One helper per state transition. Each
// carries a deterministic idempotency key so a retried admin action, a
// double-clicked cancel button, or a re-fired domain event does not send
// two emails.
//
// The helpers look up the Participant + AccessPoint themselves so the
// caller only needs to pass the ids that domain events already carry.
// This keeps the trigger site (server action / domain listener) tiny and
// prevents accidentally leaking a snapshot-vs-live-price mismatch.

const TEMPLATE_KEY: Record<RoomRegistrationStatus, string | null> = {
  PENDING_PAYMENT: "room-registration-pending-payment",
  FREE_CONFIRMED: "room-registration-free-confirmed",
  PAID: "room-registration-paid",
  REFUNDED: "room-registration-refunded",
  CANCELLED: "room-registration-cancelled",
  // No user-facing email on internal payment-failure or automatic expiry.
  // Admins see these transitions through AuditLog / RoomPaymentEvent.
  PAYMENT_FAILED: null,
  EXPIRED: null
};

function formatPrice(minor: number | null | undefined): string {
  if (minor == null) return "";
  return (minor / 100).toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

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
      priceMinorSnapshot: true,
      currencySnapshot: true,
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
  // Defensive: without a Participant we cannot address the mail. Never
  // silently attempt to email `null`.
  if (!registration.participant || !registration.participant.email) {
    return { ok: false, reason: "participant-not-found" };
  }

  const p = registration.participant;
  return queueTemplatedEmail({
    templateKey,
    to: p.email,
    toName: `${p.firstName} ${p.lastName}`,
    participantId: p.id,
    // The status is part of the key: PENDING → PAID transition emits a
    // second, distinct email. A retried PAID confirmation dedupes.
    idempotencyKey: `room-reg:${registration.id}:${status}`,
    vars: {
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: `${p.firstName} ${p.lastName}`,
      email: p.email,
      roomName: registration.accessPoint.name,
      roomPrice: formatPrice(registration.priceMinorSnapshot),
      roomCurrency: registration.currencySnapshot ?? "",
      ...EVENT_VARS
    }
  });
}

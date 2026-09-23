"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AccessPointType,
  AdmissionMode,
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

// ─── Participant-facing room registration server actions (Sub-Phase D) ─
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
//      active). The room's admission mode is read server-side; the
//      browser MUST NOT determine price/currency/status.
//   5. Delegate to the canonical `initRegistration()` / `cancel()`
//      domain service. All state changes, event emission, and
//      ParticipantAccess sync happen inside the service transaction.
//
// The action never:
//   • Mutates RoomRegistration / ParticipantAccess / RoomPaymentEvent
//     directly.
//   • Accepts a price, currency, admission mode, participant id,
//     or payment status from the browser.
//   • Progresses PAID rooms past PENDING_PAYMENT — a real payment
//     provider is out of scope for Sub-Phase D. Confirmation is
//     handled by the trusted admin boundary (see
//     `app/admin/(protected)/registrants/[id]/room-payment-actions.ts`).

// Public result shape mirrored on the compte UI. Deliberately narrow —
// exposes only what the browser needs to render the outcome. Never
// includes internal DB ids, provider identifiers, or raw error stacks.
export type RegistrationActionResult =
  | {
      ok: true;
      status: RoomRegistrationStatus;
      // Server-side snapshot for PAID rooms so the UI can render the
      // frozen price/currency without querying the AccessPoint again
      // (and thereby being tricked into showing a mutated price).
      priceMinorSnapshot: number | null;
      currencySnapshot: string | null;
    }
  | { ok: false; message: string; code?: RoomRegistrationErrorCode | "UNAUTHENTICATED" | "NO_PARTICIPANT" | "THROTTLED" };

// Rate-limit budget. Room registration is a cheap DB write that
// creates a new RoomRegistration row (or reactivates one from a
// terminal state), so the per-participant cap is deliberately
// generous — enough for a user to try several rooms in one sitting
// while still throttling scripted enumeration. The DB
// @@unique([participantId, accessPointId]) remains the authoritative
// duplicate-prevention barrier; this limit is anti-abuse, not
// correctness.
const REGISTRATION_ATTEMPTS_PER_ACCOUNT = 30;
const REGISTRATION_ATTEMPTS_PER_IP = 60;

const accessPointIdSchema = z.string().trim().min(10).max(64);

// Shared friendly-message table so the participant-facing UI never
// receives a raw domain error code or Prisma detail. INTERNAL_ERROR is
// deliberately masked to a generic string — operators debug via the
// server log.
function friendlyMessage(code: RoomRegistrationErrorCode): string {
  switch (code) {
    case "PARTICIPANT_NOT_FOUND":
    case "PARTICIPANT_CANCELLED":
      return "Votre inscription BIS 2027 n'est pas éligible à l'inscription en salle.";
    case "ACCESS_POINT_NOT_FOUND":
    case "NOT_A_ROOM":
    case "ACCESS_POINT_INACTIVE":
    case "ADMISSION_MODE_NOT_SET":
      return "Cette salle n'est pas disponible à l'inscription.";
    case "PAID_ROOM_MISSING_PRICE":
    case "PAID_ROOM_MISSING_CURRENCY":
    case "INVALID_PRICE":
    case "UNSUPPORTED_CURRENCY":
      return "Cette salle payante n'est pas configurée correctement. Merci de réessayer plus tard.";
    case "REGISTRATION_NOT_FOUND":
      return "Aucune inscription à cette salle n'a été trouvée pour vous.";
    case "INVALID_STATE_TRANSITION":
    case "TERMINAL_STATE_PROTECTED":
      return "Cette action n'est pas disponible pour l'état actuel de votre inscription.";
    case "INVALID_INPUT":
      return "Requête invalide.";
    case "PROVIDER_REF_CONFLICT":
    case "PROVIDER_REF_REQUIRED":
    case "LATE_FAILURE_ON_PAID":
    case "ADMIN_NOT_FOUND":
    case "META_NOT_ALLOWED":
    case "INTERNAL_ERROR":
    default:
      return "Une erreur est survenue. Merci de réessayer.";
  }
}

// Load the participant that the current session's AccountUser owns.
// Whitelist select — no passwordHash, no session token, no other
// participants. Returns null when the account exists but has no
// participant row (never went through /register) so the caller can
// surface a friendly "finish onboarding" response.
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

// Load the AccessPoint the participant is trying to register for.
// Whitelist select — no counts, no timestamps, no admin metadata.
// The service re-reads this row inside its transaction so this check
// is only a fast-fail; the truth remains inside the domain.
async function resolveAccessPoint(accessPointId: string) {
  return prisma.accessPoint.findUnique({
    where: { id: accessPointId },
    select: {
      id: true,
      type: true,
      active: true,
      admissionMode: true
    }
  });
}

// ─── registerForRoom ────────────────────────────────────────────────────
//
// Self-service registration entrypoint. FREE rooms → FREE_CONFIRMED +
// registration-owned access. PAID rooms → PENDING_PAYMENT with no
// access grant. Idempotent for existing live registrations — repeated
// invocations return the current state without duplicate events.
export async function registerForRoom(
  accessPointId: unknown
): Promise<RegistrationActionResult> {
  // ─── Auth ─────────────────────────────────────────────────────────
  const account = await getCurrentAccount();
  if (!account) {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      message: "Merci de vous connecter pour vous inscrire à une salle."
    };
  }

  // ─── Input validation ─────────────────────────────────────────────
  // Anything the browser can control passes through Zod. participantId
  // is NEVER read from the browser — it is derived from the session.
  const parsed = accessPointIdSchema.safeParse(accessPointId);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Requête invalide."
    };
  }

  // ─── Rate limit ───────────────────────────────────────────────────
  // Existing in-process bucket. Uses namespaced keys so we don't
  // collide with login/register buckets. The IP bucket falls back to
  // a shared "no-proxy" bucket when the deployment has no proxy set,
  // matching the pattern used by app/actions/account.ts.
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

  // ─── Participant resolution ───────────────────────────────────────
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
    // Fast-fail without going to the domain; the domain would return
    // PARTICIPANT_CANCELLED. Same friendly response either way.
    return {
      ok: false,
      code: "PARTICIPANT_CANCELLED",
      message: friendlyMessage("PARTICIPANT_CANCELLED")
    };
  }

  // ─── Access-point pre-validation ──────────────────────────────────
  // The service will re-validate everything inside its transaction —
  // this pre-check is purely to fast-fail obviously invalid input
  // (like a MAIN_ENTRANCE id) with a specific message before we open
  // a transaction.
  const ap = await resolveAccessPoint(parsed.data);
  if (!ap) {
    return {
      ok: false,
      code: "ACCESS_POINT_NOT_FOUND",
      message: friendlyMessage("ACCESS_POINT_NOT_FOUND")
    };
  }
  if (ap.type !== AccessPointType.ROOM) {
    // Explicitly reject MAIN_ENTRANCE registration attempts even
    // though the domain also rejects them.
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
  if (ap.admissionMode !== AdmissionMode.FREE && ap.admissionMode !== AdmissionMode.PAID) {
    return {
      ok: false,
      code: "ADMISSION_MODE_NOT_SET",
      message: friendlyMessage("ADMISSION_MODE_NOT_SET")
    };
  }

  // ─── Delegate to the canonical domain service ────────────────────
  // Sub-Phase D §8 — we deliberately do NOT pass expiresAt here. The
  // system has no approved policy for automatic expiry duration
  // (documented as an unresolved business decision in the Sub-Phase D
  // report), so registrations remain open until an operator cancels
  // them or a future phase adds an approved deadline policy.
  const result = await initRegistration({
    participantId: participant.id,
    accessPointId: ap.id
  });

  if (!result.ok) {
    // Best-effort audit of the failure at the action layer. Domain
    // internals already log via `console.error` on unexpected errors;
    // this row captures WHO attempted WHAT so an admin reviewing the
    // AuditLog can see the pattern of rejected attempts.
    await audit({
      userId: null,
      action: "participant.room-registration.init.rejected",
      entity: "AccessPoint",
      entityId: ap.id,
      meta: { code: result.code, participantId: participant.id }
    }).catch(() => undefined);
    return { ok: false, code: result.code, message: friendlyMessage(result.code) };
  }

  // Best-effort notification. Idempotency key = `room-reg:<id>:<status>`,
  // so a re-emit is a no-op. Any error is swallowed — email failure MUST
  // NOT roll back the successful registration (spec §26).
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

  // Revalidate the compte tree so the UI reflects the new state.
  revalidatePath("/compte");
  revalidatePath("/compte/acces");

  return {
    ok: true,
    status: result.value.status,
    priceMinorSnapshot: result.value.priceMinorSnapshot,
    currencySnapshot: result.value.currencySnapshot
  };
}

// ─── cancelMyRoomRegistration ───────────────────────────────────────────
//
// Attendee-facing self-cancellation. Cancels the current session-
// bound participant's registration for a room. Only revokes
// REGISTRATION-owned ParticipantAccess (the domain service enforces
// this — see sync.ts:revokeRegistrationOwned). Never touches ADMIN
// grants and never rewrites CheckIn history.
//
// Refused when:
//   • no session
//   • no participant row on the account
//   • participant is CANCELLED (would be idempotent no-op in the
//     domain, but we return a friendly message)
//   • target row is REFUNDED (state machine refuses REFUNDED → CANCELLED)
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

  // Self-cancellation runs with actorAdminId=null; the domain records
  // meta.source="system" for null-admin cancels. This is intentional:
  // the AuditLog helper we call below tags the row with entity+meta
  // that identifies this as a participant self-cancel, and the
  // RoomPaymentEvent captures the transition detail.
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

  // Attendee self-cancellation email — idempotent by (registrationId, status).
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
    status: result.value.status,
    priceMinorSnapshot: result.value.priceMinorSnapshot,
    currencySnapshot: result.value.currencySnapshot
  };
}

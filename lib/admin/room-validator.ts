import "server-only";

import {
  AccessPointType,
  CheckInResult,
  PaymentStatus,
  RegistrationStatus,
  type AdminUser
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { verifyBadgeToken } from "@/lib/badge/service";
import type { ScannerValidationResult } from "@/app/admin/(protected)/scan/[access-point-slug]/action-types";

// Phase 11 — ROOM QR validator core.
//
// Companion to lib/admin/main-entrance-validator.ts. The two share
// almost every concern (Phase-2 verify → AccessPoint resolve →
// participant eligibility → CheckIn + AuditLog with data-safety
// discipline) but differ in three important places:
//
//   1. Required permission is `access.validate.room` (checked by
//      the wrapper — the core accepts an already-authorized user).
//   2. Required AccessPoint.type is ROOM.
//   3. Eligibility rule is STRICT (spec §14): the participant needs
//      `ParticipantAccess.granted === true` for THIS specific room.
//        • no row      → PA_NOT_GRANTED (default-deny, spec explicit)
//        • granted=false → PA_REVOKED   (explicit admin denial)
//        • granted=true  → allowed, subject to payment/eligibility
//   4. No `Participant.checkedInAt` mutation. Rooms are independent
//      per-room accesses; venue entry does not grant room access,
//      and room entry does not update the main-entrance timestamp.
//   5. No atomic first-scan claim. Rooms allow repeat entry (owner
//      decision C1 = A, master-doc default). Every authorized scan
//      writes a fresh CheckIn(VALID) with reason `ROOM_ENTRY`.
//
// Everything else — data-safety, AuditLog contract, rawToken/tokenHash
// discipline, whitelist selects — mirrors the main-entrance validator.

// Fixed French messages the operator sees. Reason strings and outcome
// codes are internal; the operator sees only these localized strings.
const MESSAGES = {
  VALID: "Accès autorisé.",
  UNPAID: "Paiement non confirmé.",
  CANCELLED: "Inscription annulée.",
  PA_REVOKED: "Accès refusé.",
  PA_NOT_GRANTED: "Accès non autorisé pour cette salle.",
  BADGE_INVALID: "Badge non reconnu.",
  BADGE_REVOKED: "Badge révoqué.",
  BADGE_EXPIRED: "Badge expiré.",
  ACCESS_POINT_INACTIVE: "Salle désactivée.",
  ACCESS_POINT_WRONG_TYPE: "Ce point n'est pas une salle.",
  ACCESS_POINT_UNKNOWN: "Salle introuvable."
} as const;

export type RoomValidatorInput = {
  user: Pick<AdminUser, "id">;
  slug: string;
  rawToken: string;
};

export async function validateRoomQrCore(
  input: RoomValidatorInput
): Promise<ScannerValidationResult> {
  const { user, slug, rawToken } = input;

  // ─── 1. Re-resolve AccessPoint (do NOT trust the rendered page). ─
  const point = await prisma.accessPoint.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      active: true
    }
  });

  if (!point) {
    await auditQrScan({
      userId: user.id,
      accessPointId: null,
      accessPointSlug: slug,
      accessPointType: null,
      result: CheckInResult.UNKNOWN,
      reason: "ACCESS_POINT_UNKNOWN"
    });
    return {
      ok: false,
      outcome: "ACCESS_POINT_UNKNOWN",
      message: MESSAGES.ACCESS_POINT_UNKNOWN
    };
  }

  if (!point.active) {
    await auditQrScan({
      userId: user.id,
      accessPointId: point.id,
      accessPointSlug: point.slug,
      accessPointType: point.type,
      result: CheckInResult.UNKNOWN,
      reason: "ACCESS_POINT_INACTIVE"
    });
    return {
      ok: false,
      outcome: "ACCESS_POINT_INACTIVE",
      message: MESSAGES.ACCESS_POINT_INACTIVE
    };
  }

  if (point.type !== AccessPointType.ROOM) {
    // A MAIN_ENTRANCE point reaching this validator is a routing bug
    // or a crafted call — refuse. Phase 10 validator does the mirror
    // check for ROOMs sent to it.
    await auditQrScan({
      userId: user.id,
      accessPointId: point.id,
      accessPointSlug: point.slug,
      accessPointType: point.type,
      result: CheckInResult.UNKNOWN,
      reason: "ACCESS_POINT_WRONG_TYPE"
    });
    return {
      ok: false,
      outcome: "ACCESS_POINT_WRONG_TYPE",
      message: MESSAGES.ACCESS_POINT_WRONG_TYPE
    };
  }

  // ─── 2. Verify the raw token via the Phase 2 service. ─────────
  const verify = await verifyBadgeToken(rawToken);
  if (!verify.ok) {
    // Same B4 policy as Phase 10: verify failures do not have a
    // participantId in the caller's scope. AuditLog only.
    if (verify.reason === "PARTICIPANT_CANCELLED") {
      await auditQrScan({
        userId: user.id,
        accessPointId: point.id,
        accessPointSlug: point.slug,
        accessPointType: point.type,
        result: CheckInResult.CANCELLED,
        reason: "PARTICIPANT_CANCELLED"
      });
      return {
        ok: false,
        outcome: "CANCELLED",
        message: MESSAGES.CANCELLED
      };
    }
    const badgeOutcome =
      verify.reason === "INVALID"
        ? "BADGE_INVALID"
        : verify.reason === "REVOKED"
          ? "BADGE_REVOKED"
          : /* EXPIRED */ "BADGE_EXPIRED";
    await auditQrScan({
      userId: user.id,
      accessPointId: point.id,
      accessPointSlug: point.slug,
      accessPointType: point.type,
      result: CheckInResult.UNKNOWN,
      reason: badgeOutcome
    });
    return {
      ok: false,
      outcome: badgeOutcome,
      message: MESSAGES[badgeOutcome]
    };
  }

  // ─── 3. Load participant with the ROOM PA row joined. ─────────
  const participant = await prisma.participant.findUnique({
    where: { id: verify.participantId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      tier: true,
      status: true,
      paymentStatus: true,
      ticketCode: true,
      accessPermissions: {
        where: { accessPointId: point.id },
        select: { granted: true }
      }
    }
  });

  if (!participant) {
    // Same defensive case as Phase 10 — credential verified but
    // participant vanished. Treat as BADGE_INVALID; no CheckIn.
    await auditQrScan({
      userId: user.id,
      accessPointId: point.id,
      accessPointSlug: point.slug,
      accessPointType: point.type,
      result: CheckInResult.UNKNOWN,
      reason: "BADGE_INVALID"
    });
    return {
      ok: false,
      outcome: "BADGE_INVALID",
      message: MESSAGES.BADGE_INVALID
    };
  }

  const safeParticipant = {
    firstName: participant.firstName,
    lastName: participant.lastName,
    tier: participant.tier as string | null
  };

  // ─── 4. Eligibility gates (spec §14, strict). ──────────────────
  //   CANCELLED → deny, DEDICATED reason.
  //   UNPAID    → deny.
  //   No PA row → deny (PA_NOT_GRANTED) — rooms are default-deny.
  //   granted=false → deny (PA_REVOKED).
  //   granted=true → allow.

  if (participant.status === RegistrationStatus.CANCELLED) {
    await writeCheckInAndAudit({
      participantId: participant.id,
      credentialId: verify.credentialId,
      point,
      operatorId: user.id,
      ticketCode: participant.ticketCode ?? "",
      result: CheckInResult.CANCELLED,
      reason: "PARTICIPANT_CANCELLED"
    });
    return {
      ok: false,
      outcome: "CANCELLED",
      message: MESSAGES.CANCELLED,
      participant: safeParticipant
    };
  }

  if (participant.paymentStatus !== PaymentStatus.PAID) {
    await writeCheckInAndAudit({
      participantId: participant.id,
      credentialId: verify.credentialId,
      point,
      operatorId: user.id,
      ticketCode: participant.ticketCode ?? "",
      result: CheckInResult.UNPAID,
      reason: "UNPAID"
    });
    return {
      ok: false,
      outcome: "UNPAID",
      message: MESSAGES.UNPAID,
      participant: safeParticipant
    };
  }

  const paRow = participant.accessPermissions[0];

  if (!paRow) {
    // No PA row at all — rooms are default-deny per spec §14.
    // Distinct reason string from PA_REVOKED (which is an EXPLICIT
    // admin revocation via the registrant matrix). Both deny; the
    // forensic split is preserved in the audit trail.
    await writeCheckInAndAudit({
      participantId: participant.id,
      credentialId: verify.credentialId,
      point,
      operatorId: user.id,
      ticketCode: participant.ticketCode ?? "",
      result: CheckInResult.UNKNOWN,
      reason: "PA_NOT_GRANTED"
    });
    return {
      ok: false,
      outcome: "PA_NOT_GRANTED",
      message: MESSAGES.PA_NOT_GRANTED,
      participant: safeParticipant
    };
  }

  if (paRow.granted === false) {
    await writeCheckInAndAudit({
      participantId: participant.id,
      credentialId: verify.credentialId,
      point,
      operatorId: user.id,
      ticketCode: participant.ticketCode ?? "",
      result: CheckInResult.UNKNOWN,
      reason: "PA_REVOKED"
    });
    return {
      ok: false,
      outcome: "PA_REVOKED",
      message: MESSAGES.PA_REVOKED,
      participant: safeParticipant
    };
  }

  // ─── 5. Room entry — every authorized scan is a fresh CheckIn.
  // No Participant.checkedInAt mutation. No atomic claim; rooms allow
  // repeat entry (C1 = A). Concurrent scans produce concurrent CheckIn
  // rows, all VALID — this is the intended behaviour.
  const now = new Date();
  await writeCheckInAndAudit({
    participantId: participant.id,
    credentialId: verify.credentialId,
    point,
    operatorId: user.id,
    ticketCode: participant.ticketCode ?? "",
    result: CheckInResult.VALID,
    reason: "ROOM_ENTRY"
  });
  return {
    ok: true,
    outcome: "VALID",
    message: MESSAGES.VALID,
    participant: safeParticipant,
    at: now.toISOString()
  };
}

// ─── Internal helpers (mirror of main-entrance-validator's helpers) ─

async function writeCheckInAndAudit(args: {
  participantId: string;
  credentialId: string;
  point: {
    id: string;
    slug: string;
    name: string;
    type: AccessPointType;
  };
  operatorId: string;
  ticketCode: string;
  result: CheckInResult;
  reason: string;
}): Promise<void> {
  await prisma.checkIn.create({
    data: {
      participantId: args.participantId,
      credentialId: args.credentialId,
      accessPointId: args.point.id,
      operatorId: args.operatorId,
      ticketCode: args.ticketCode,
      gate: args.point.slug,
      result: args.result,
      reason: args.reason
    }
  });
  await auditQrScan({
    userId: args.operatorId,
    accessPointId: args.point.id,
    accessPointSlug: args.point.slug,
    accessPointType: args.point.type,
    result: args.result,
    reason: args.reason,
    participantId: args.participantId
  });
}

async function auditQrScan(args: {
  userId: string;
  accessPointId: string | null;
  accessPointSlug: string | null;
  accessPointType: AccessPointType | null;
  result: CheckInResult;
  reason: string;
  participantId?: string;
}): Promise<void> {
  await audit({
    userId: args.userId,
    // Same action name as Phase 10: `checkin.scan.qr`. The meta
    // includes accessPointType so ROOM vs MAIN is distinguishable
    // in forensics.
    action: "checkin.scan.qr",
    entity: args.participantId ? "Participant" : "AccessPoint",
    entityId: args.participantId ?? args.accessPointId ?? undefined,
    meta: {
      accessPointId: args.accessPointId,
      accessPointSlug: args.accessPointSlug,
      accessPointType: args.accessPointType,
      result: args.result,
      reason: args.reason
    }
  });
}

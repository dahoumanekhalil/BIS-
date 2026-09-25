import "server-only";

import {
  AccessPointType,
  CheckInResult,
  RegistrationStatus,
  type AdminUser
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { verifyBadgeToken } from "@/lib/badge/service";
import type { MainEntranceValidationResult } from "@/app/admin/(protected)/scan/[access-point-slug]/action-types";

// Phase 10 — MAIN_ENTRANCE QR validator core.
//
// Separated from the `"use server"` wrapper so tests can call this
// with a fixture admin user instead of going through the Next.js
// request boundary (cookies / redirect). Mirrors the Phase 7 pattern
// where the action file imports the core and re-checks
// requirePermission at the entry.
//
// Contract:
//   • Operator authorization is the CALLER's responsibility. The
//     server action wrapper calls requirePermission("access.validate.main")
//     BEFORE invoking this function. Tests pass a real AdminUser
//     row that already holds the permission.
//   • Input is (user, slug, rawToken). Every other authoritative
//     fact is re-derived from the DB inside this function — the
//     caller may NOT pass participantId, accessPointId, or any other
//     identity claim.
//   • rawToken is treated as opaque and passed only to
//     verifyBadgeToken. It is never persisted to CheckIn, AuditLog,
//     Participant, or any log sink.
//   • Every scan attempt writes exactly one AuditLog row with
//     action = "checkin.scan.qr".
//   • CheckIn is written iff verifyBadgeToken returned {ok: true}
//     AND the AccessPoint gates passed. See §"B4 policy summary" in
//     the master doc.
//   • Owner-locked semantics: B1 = C, B2 = A, B3 = B.

// Fixed French messages the operator sees. Kept as data so both the
// happy and denial paths stay consistent. Never expose internal
// exception messages, database IDs, or credential material.
//
// `UNPAID` is retained on the map for backward compatibility with
// historical CheckIn rows that recorded `result = UNPAID` before
// payment was removed as an event-entry prerequisite. The validator
// no longer produces this outcome — see the eligibility gates below.
const MESSAGES = {
  VALID: "Accès autorisé.",
  ALREADY_CHECKED_IN: "Déjà enregistré.",
  UNPAID: "Paiement non confirmé.",
  CANCELLED: "Inscription annulée.",
  PA_REVOKED: "Accès refusé.",
  BADGE_INVALID: "Badge non reconnu.",
  BADGE_REVOKED: "Badge révoqué.",
  BADGE_EXPIRED: "Badge expiré.",
  ACCESS_POINT_INACTIVE: "Point d'accès désactivé.",
  ACCESS_POINT_WRONG_TYPE: "Ce point n'est pas l'entrée principale.",
  ACCESS_POINT_UNKNOWN: "Point d'accès introuvable."
} as const;

export type MainEntranceValidatorInput = {
  // Operator whose permission has ALREADY been verified by the
  // wrapper (or by the test harness). MUST be a session-derived
  // AdminUser, never a client-supplied identifier.
  user: Pick<AdminUser, "id">;
  // URL slug the scanner client is bound to. Re-resolved to an
  // AccessPoint here — the caller does NOT get to pass an
  // AccessPoint id or type.
  slug: string;
  // Opaque credential decoded from the QR by the client. Handled
  // ONLY by verifyBadgeToken; never logged or persisted.
  rawToken: string;
};

export async function validateMainEntranceQrCore(
  input: MainEntranceValidatorInput
): Promise<MainEntranceValidationResult> {
  const { user, slug, rawToken } = input;

  // ─── 1. Re-resolve AccessPoint (do NOT trust anything from the
  //        rendered scanner page). Whitelist select. ─────────────
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

  if (point.type !== AccessPointType.MAIN_ENTRANCE) {
    // Phase 10 is MAIN_ENTRANCE only. A ROOM point reaching this
    // validator is a routing bug or a crafted call — refuse.
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
    // B4: verifyBadgeToken does NOT expose participantId on failure
    // paths. Without a participantId we cannot write a CheckIn (its
    // `ticketCode` field is NOT NULL and we MUST NOT fabricate one
    // from the rawToken). AuditLog only.
    const badgeOutcome =
      verify.reason === "INVALID"
        ? "BADGE_INVALID"
        : verify.reason === "REVOKED"
          ? "BADGE_REVOKED"
          : verify.reason === "EXPIRED"
            ? "BADGE_EXPIRED"
            : /* PARTICIPANT_CANCELLED */ "CANCELLED";

    if (badgeOutcome === "CANCELLED") {
      // verify returned PARTICIPANT_CANCELLED — the credential is
      // technically valid but the participant is cancelled. Per B4
      // we still don't have a participantId in scope; AuditLog only.
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

  // ─── 3. Load participant with the MAIN_ENTRANCE PA row joined. ─
  // Whitelist select — never fetch passwordHash, session tokens,
  // reviewNotes, or paymentRef into scope. The narrow projection also
  // shields the code path from accidentally rendering sensitive
  // fields via a slip-up later.
  const participant = await prisma.participant.findUnique({
    where: { id: verify.participantId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      tier: true,
      status: true,
      ticketCode: true,
      accessPermissions: {
        where: { accessPointId: point.id },
        select: { granted: true }
      }
    }
  });

  if (!participant) {
    // Extremely rare — credential verified but the participant row
    // vanished (e.g., cascade delete in-flight). Treat as
    // BADGE_INVALID from the operator's perspective. No CheckIn
    // (no id to attribute).
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

  // Attach the safe-to-render participant snapshot to every response
  // from here on. First/last name + tier only.
  const safeParticipant = {
    firstName: participant.firstName,
    lastName: participant.lastName,
    tier: participant.tier as string | null
  };

  // ─── 4. Eligibility gates. ────────────────────────────────────
  //   ELIGIBLE = status !== CANCELLED AND ParticipantAccess.granted !== false
  //     → ALLOW.
  //   granted=false explicitly denies otherwise-eligible attendees.
  //
  // Payment-removal Phase 1: the `paymentStatus === PAID` gate that
  // previously sat between CANCELLED and PA_REVOKED has been removed.
  // Event entry no longer requires payment. See
  // docs/payment-removal-phase-1-2.md.
  //
  // Security note: the CANCELLED guard immediately below and the
  // PARTICIPANT_CANCELLED path returned by verifyBadgeToken above
  // remain the only status-based denials — this is intentional and
  // preserves the "cancelled attendees blocked" invariant.

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

  // B1 tri-state: no PA row → treat as no explicit override.
  // granted=false → explicit deny. granted=true → allow.
  const paRow = participant.accessPermissions[0];
  if (paRow && paRow.granted === false) {
    await writeCheckInAndAudit({
      participantId: participant.id,
      credentialId: verify.credentialId,
      point,
      operatorId: user.id,
      ticketCode: participant.ticketCode ?? "",
      // Reuse UNKNOWN + reason string per B2. There is no
      // "explicitly denied by admin matrix" CheckInResult; UNKNOWN
      // + reason="PA_REVOKED" is the agreed encoding.
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

  // ─── 5. Atomic checkedInAt claim (B3). ────────────────────────
  const now = new Date();
  const claim = await prisma.participant.updateMany({
    where: { id: participant.id, checkedInAt: null },
    data: { checkedInAt: now, checkedInGate: point.slug }
  });

  if (claim.count === 1) {
    await writeCheckInAndAudit({
      participantId: participant.id,
      credentialId: verify.credentialId,
      point,
      operatorId: user.id,
      ticketCode: participant.ticketCode ?? "",
      result: CheckInResult.VALID,
      reason: "FIRST_SCAN"
    });
    return {
      ok: true,
      outcome: "VALID",
      message: MESSAGES.VALID,
      participant: safeParticipant,
      at: now.toISOString()
    };
  }

  // count === 0 — either this participant was already checked in
  // before we started, or a concurrent scan won the race. Re-fetch
  // to get the authoritative timestamp.
  const winner = await prisma.participant.findUnique({
    where: { id: participant.id },
    select: { checkedInAt: true }
  });

  await writeCheckInAndAudit({
    participantId: participant.id,
    credentialId: verify.credentialId,
    point,
    operatorId: user.id,
    ticketCode: participant.ticketCode ?? "",
    result: CheckInResult.ALREADY_CHECKED_IN,
    reason: "REPEAT_SCAN"
  });
  return {
    ok: true,
    outcome: "ALREADY_CHECKED_IN",
    message: MESSAGES.ALREADY_CHECKED_IN,
    participant: safeParticipant,
    at: winner?.checkedInAt?.toISOString()
  };
}

// ─── Internal helpers ───────────────────────────────────────────

// Write CheckIn + AuditLog for outcomes where a participant is
// resolved. Every field is populated from server-derived values.
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
  // Always `participant.ticketCode ?? ""` — never the rawToken.
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
      // Legacy string field; use the AccessPoint slug so admin
      // dashboards that group by `gate` still work.
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

// Write ONE AuditLog row with the canonical Phase 10 action name.
// meta is fixed-shape — never receives free-form user input, never
// receives rawToken or tokenHash.
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
    action: "checkin.scan.qr",
    entity: args.participantId ? "Participant" : "AccessPoint",
    entityId: args.participantId ?? args.accessPointId ?? undefined,
    meta: {
      accessPointId: args.accessPointId,
      accessPointSlug: args.accessPointSlug,
      accessPointType: args.accessPointType,
      result: args.result,
      reason: args.reason
      // Deliberately no rawToken, no tokenHash, no participantId
      // when null. If participantId is provided it appears as the
      // AuditLog entityId, not in meta.
    }
  });
}

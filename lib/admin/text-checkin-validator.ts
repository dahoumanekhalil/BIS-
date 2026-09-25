import "server-only";

import {
  AccessPointType,
  CheckInResult,
  RegistrationStatus,
  type AdminUser
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { normalizeCheckinCode } from "@/lib/badge/checkin-code";
import { isBlocked, record } from "@/lib/rate-limit";
import type { ScannerValidationResult } from "@/app/admin/(protected)/scan/[access-point-slug]/action-types";

// Phase 19 — MAIN_ENTRANCE + ROOM validators for the text
// check-in code fallback.
//
// DECISION SEMANTICS:
//   Byte-for-byte identical to the Phase 10 (main-entrance) and
//   Phase 11 (room) validators. Only the participant-resolution
//   step differs: this file resolves the participant by looking up
//   `Participant.checkinCode` on the normalized user-supplied code,
//   whereas the QR path resolves via `verifyBadgeToken`.
//
//   All downstream rules — CANCELLED → PA row → atomic claim (main)
//   or ROOM_ENTRY (room) — MUST remain identical to the QR path.
//   This is not a new authorization system; it is a second transport
//   into the same access-control engine.
//
//   BIS 2027 is FREE-only; the two paths remain byte-identical.
//
// SECURITY ADDITIONS specific to the text-input surface:
//   • Rate limit runs BEFORE the DB lookup, keyed by
//     `text-checkin:ip:*` AND `text-checkin:op:*`. A hostile
//     brute-force cannot even trigger a Postgres query beyond the
//     threshold.
//   • Malformed / unnormalizable codes return the generic
//     TEXT_INVALID outcome — indistinguishable from "shape-valid
//     but unknown code" to the operator. Enumeration protection.
//   • CheckIn is written only when a participant is resolved (same
//     as QR: B4 policy preserved).
//   • Raw code NEVER enters AuditLog. Meta uses only fixed short
//     reason strings + accessPointId / slug / type.
//   • Result is written with a distinct audit action name
//     `checkin.scan.text` so operations can distinguish QR vs text
//     scans in forensic queries.

// Same thresholds we use for admin-login (Phase 13 WARN 1 fix).
// Different key prefix so text-code buckets do not collide with
// login buckets.
const TEXT_FAILS_PER_IP = 20;
const TEXT_FAILS_PER_OP = 40;

// Fixed staff-facing French messages. Never expose internal error
// text, stack traces, or DB identifiers.
const MESSAGES = {
  VALID: "Accès autorisé.",
  ALREADY_CHECKED_IN: "Déjà enregistré.",
  CANCELLED: "Inscription annulée.",
  PA_REVOKED: "Accès refusé.",
  PA_NOT_GRANTED: "Accès non autorisé pour cette salle.",
  TEXT_INVALID: "Code non reconnu.",
  ACCESS_POINT_INACTIVE: "Point d'accès désactivé.",
  ACCESS_POINT_WRONG_TYPE_MAIN: "Ce point n'est pas l'entrée principale.",
  ACCESS_POINT_WRONG_TYPE_ROOM: "Ce point n'est pas une salle.",
  ACCESS_POINT_UNKNOWN_MAIN: "Point d'accès introuvable.",
  ACCESS_POINT_UNKNOWN_ROOM: "Salle introuvable.",
  THROTTLED:
    "Trop de tentatives. Réessayez dans quelques minutes."
} as const;

export type TextValidatorInput = {
  user: Pick<AdminUser, "id">;
  slug: string;
  code: string;
  // Non-null for real requests. Null in tests that don't want to
  // exercise the IP bucket.
  ip: string | null;
};

// ─── MAIN_ENTRANCE — text fallback ───────────────────────────────

export async function validateMainEntranceTextCore(
  input: TextValidatorInput
): Promise<ScannerValidationResult> {
  return validate({
    ...input,
    expectedType: AccessPointType.MAIN_ENTRANCE
  });
}

// ─── ROOM — text fallback ───────────────────────────────────────

export async function validateRoomTextCore(
  input: TextValidatorInput
): Promise<ScannerValidationResult> {
  return validate({
    ...input,
    expectedType: AccessPointType.ROOM
  });
}

// ─── Shared implementation ──────────────────────────────────────

async function validate(
  input: TextValidatorInput & { expectedType: AccessPointType }
): Promise<ScannerValidationResult> {
  const { user, slug, code, ip, expectedType } = input;

  // ─── Step 1: rate-limit BEFORE any DB lookup ────────────────
  // Text-code entry is a live authentication-adjacent input surface.
  // Bounds:
  //   • per-IP:       20 fails / 15 min
  //   • per-operator: 40 fails / 15 min
  // Successful validations do NOT count toward the fail bucket
  // (they are not recorded). Malformed AND unknown-code attempts
  // both increment. Threshold trip → THROTTLED, generic message,
  // no DB lookup.
  const ipKey = ip ? `text-checkin:ip:${ip}` : null;
  const opKey = `text-checkin:op:${user.id}`;
  if (
    isBlocked(ipKey, TEXT_FAILS_PER_IP) ||
    isBlocked(opKey, TEXT_FAILS_PER_OP)
  ) {
    // Do NOT resolve the AccessPoint here — we don't want to leak
    // that the AP exists via THROTTLED responses either.
    await auditText({
      userId: user.id,
      accessPointId: null,
      accessPointSlug: slug,
      accessPointType: null,
      result: CheckInResult.UNKNOWN,
      reason: "TEXT_THROTTLED"
    });
    return {
      ok: false,
      outcome: "BADGE_INVALID",
      message: MESSAGES.THROTTLED
    };
  }

  // ─── Step 2: resolve AccessPoint (same as QR validator) ─────
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
    // Record failure counters — an operator repeatedly submitting
    // codes to an unknown slug is either misconfigured or hostile.
    record(ipKey);
    record(opKey);
    await auditText({
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
      message:
        expectedType === "MAIN_ENTRANCE"
          ? MESSAGES.ACCESS_POINT_UNKNOWN_MAIN
          : MESSAGES.ACCESS_POINT_UNKNOWN_ROOM
    };
  }
  if (!point.active) {
    await auditText({
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
  if (point.type !== expectedType) {
    await auditText({
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
      message:
        expectedType === "MAIN_ENTRANCE"
          ? MESSAGES.ACCESS_POINT_WRONG_TYPE_MAIN
          : MESSAGES.ACCESS_POINT_WRONG_TYPE_ROOM
    };
  }

  // ─── Step 3: normalize + lookup by checkinCode ──────────────
  const canonical = normalizeCheckinCode(code);
  if (!canonical) {
    // Malformed → generic invalid. Counts toward rate limit.
    record(ipKey);
    record(opKey);
    await auditText({
      userId: user.id,
      accessPointId: point.id,
      accessPointSlug: point.slug,
      accessPointType: point.type,
      result: CheckInResult.UNKNOWN,
      reason: "TEXT_INVALID_SHAPE"
    });
    return {
      ok: false,
      outcome: "BADGE_INVALID",
      message: MESSAGES.TEXT_INVALID
    };
  }

  // Constant-time equality via Postgres unique index.
  const participant = await prisma.participant.findUnique({
    where: { checkinCode: canonical },
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
    // Unknown code. Counts toward rate limit. Generic message —
    // indistinguishable from malformed code to the operator.
    record(ipKey);
    record(opKey);
    await auditText({
      userId: user.id,
      accessPointId: point.id,
      accessPointSlug: point.slug,
      accessPointType: point.type,
      result: CheckInResult.UNKNOWN,
      reason: "TEXT_UNKNOWN"
    });
    return {
      ok: false,
      outcome: "BADGE_INVALID",
      message: MESSAGES.TEXT_INVALID
    };
  }

  const safeParticipant = {
    firstName: participant.firstName,
    lastName: participant.lastName,
    tier: participant.tier as string | null
  };

  // ─── Step 4: eligibility gates (IDENTICAL to Phase 10/11) ──
  //
  // These branches are the exact same order, condition, and audit
  // reason strings as the QR validators. Duplication is deliberate
  // (see file header). Any change here MUST be mirrored in
  // `main-entrance-validator.ts` / `room-validator.ts` and vice
  // versa — the shared invariants are locked by regression tests.
  //
  // BIS 2027 is FREE-only: no payment gate sits between the CANCELLED
  // guard and the PA row check.

  if (participant.status === RegistrationStatus.CANCELLED) {
    await writeCheckInAndAudit({
      participantId: participant.id,
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

  // MAIN_ENTRANCE: B1 = C — PA row must be granted !== false.
  // ROOM: strict — PA row MUST exist AND granted === true.
  const paRow = participant.accessPermissions[0];

  if (expectedType === "ROOM") {
    if (!paRow) {
      await writeCheckInAndAudit({
        participantId: participant.id,
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
    // Room entry — fresh CheckIn(VALID). No atomic claim (C1 = A).
    const now = new Date();
    await writeCheckInAndAudit({
      participantId: participant.id,
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

  // MAIN_ENTRANCE path.
  if (paRow && paRow.granted === false) {
    await writeCheckInAndAudit({
      participantId: participant.id,
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

  // Atomic checkedInAt claim — same pattern as Phase 10 B3.
  const now = new Date();
  const claim = await prisma.participant.updateMany({
    where: { id: participant.id, checkedInAt: null },
    data: { checkedInAt: now, checkedInGate: point.slug }
  });
  if (claim.count === 1) {
    await writeCheckInAndAudit({
      participantId: participant.id,
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
  const winner = await prisma.participant.findUnique({
    where: { id: participant.id },
    select: { checkedInAt: true }
  });
  await writeCheckInAndAudit({
    participantId: participant.id,
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

async function writeCheckInAndAudit(args: {
  participantId: string;
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
      // Phase 19: no BadgeCredential in scope — text-code path
      // never resolves a credential. CheckIn.credentialId is nullable
      // per the Phase 1 schema.
      credentialId: null,
      accessPointId: args.point.id,
      operatorId: args.operatorId,
      // Same discipline as Phase 10/11: legacy ticketCode field
      // populated from participant.ticketCode. NEVER the raw text
      // check-in code (that is a separate secret designed for typing,
      // not for CheckIn history).
      ticketCode: args.ticketCode,
      gate: args.point.slug,
      result: args.result,
      reason: args.reason
    }
  });
  await auditText({
    userId: args.operatorId,
    accessPointId: args.point.id,
    accessPointSlug: args.point.slug,
    accessPointType: args.point.type,
    result: args.result,
    reason: args.reason,
    participantId: args.participantId
  });
}

async function auditText(args: {
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
    // Phase 19 audit action — distinct from Phase 10/11's
    // `checkin.scan.qr` so operations can distinguish scan
    // transport in forensic queries.
    action: "checkin.scan.text",
    entity: args.participantId ? "Participant" : "AccessPoint",
    entityId: args.participantId ?? args.accessPointId ?? undefined,
    meta: {
      accessPointId: args.accessPointId,
      accessPointSlug: args.accessPointSlug,
      accessPointType: args.accessPointType,
      result: args.result,
      reason: args.reason
      // Deliberately no raw checkin code, no hash, no participantId
      // when null. If participantId is provided it appears as the
      // AuditLog entityId, not in meta.
    }
  });
}

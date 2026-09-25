"use server";

import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { CheckInResult, RegistrationStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";

export type CheckInResponse =
  | {
      ok: true;
      result: "VALID" | "ALREADY_CHECKED_IN";
      participant: {
        id: string;
        firstName: string;
        lastName: string;
        tier: string | null;
        gate: string | null;
        ticketCode: string | null;
        checkedInAt: Date | null;
      };
      message: string;
    }
  | {
      ok: false;
      result:
        | "UNKNOWN"
        | "WRONG_GATE"
        | "CANCELLED"
        | "WRONG_TIME";
      message: string;
      participant?: {
        firstName: string;
        lastName: string;
        gate: string | null;
      };
    };

export async function validateTicket({
  code,
  gate
}: {
  code: string;
  gate: string;
}): Promise<CheckInResponse> {
  const { user } = await requirePermission("checkin.validate");
  const ticketCode = code.trim().toUpperCase();

  if (!ticketCode) {
    return {
      ok: false,
      result: "UNKNOWN",
      message: "Code de ticket vide."
    };
  }

  const participant = await prisma.participant.findFirst({
    where: {
      OR: [{ ticketCode }, { id: ticketCode }]
    }
  });

  // Log every scan attempt regardless of outcome.
  const logScan = async (result: CheckInResult, reason?: string) => {
    await prisma.checkIn.create({
      data: {
        participantId: participant?.id,
        operatorId: user.id,
        ticketCode,
        gate,
        result,
        reason
      }
    });
    await audit({
      userId: user.id,
      action: "checkin.scan",
      entity: "Participant",
      entityId: participant?.id ?? undefined,
      meta: { ticketCode, gate, result, reason }
    });
  };

  if (!participant) {
    await logScan(CheckInResult.UNKNOWN, "Ticket introuvable");
    revalidatePath("/admin/dashboard");
    return {
      ok: false,
      result: "UNKNOWN",
      message: "Ticket introuvable."
    };
  }

  if (participant.status === RegistrationStatus.CANCELLED) {
    await logScan(CheckInResult.CANCELLED);
    return {
      ok: false,
      result: "CANCELLED",
      message: "Inscription annulée.",
      participant: {
        firstName: participant.firstName,
        lastName: participant.lastName,
        gate: participant.gate
      }
    };
  }

  if (participant.gate && participant.gate !== gate) {
    await logScan(CheckInResult.WRONG_GATE);
    return {
      ok: false,
      result: "WRONG_GATE",
      message: `Mauvaise porte. Gate autorisé : ${participant.gate}`,
      participant: {
        firstName: participant.firstName,
        lastName: participant.lastName,
        gate: participant.gate
      }
    };
  }

  // Atomic first-scan claim (Phase 10 / B3).
  //
  // Replaces the earlier two-step "if (checkedInAt) → ALREADY else
  // update" pattern, which had a race: two concurrent scans on the
  // same ticket could both pass the null-check and both write.
  //
  // The `updateMany` below sets `checkedInAt` only if it is still
  // null at the moment of the UPDATE. Postgres does the null-check
  // and the write in one statement, so exactly ONE concurrent caller
  // sees `count === 1` and every subsequent caller sees `count === 0`.
  // The winner returns VALID with the timestamp we just wrote; the
  // losers refetch to obtain the winner's timestamp and return
  // ALREADY_CHECKED_IN.
  //
  // Applied here per the pre-Phase-10 gate B3 = B decision. Every
  // other manual-flow semantic is preserved: gate matching, CANCELLED /
  // WRONG_GATE ordering, revalidatePath targets, `checkin.scan`
  // AuditLog action, `checkin.validate` permission.
  const now = new Date();
  const claim = await prisma.participant.updateMany({
    where: { id: participant.id, checkedInAt: null },
    data: {
      checkedInAt: now,
      checkedInGate: gate
    }
  });

  if (claim.count === 1) {
    await logScan(CheckInResult.VALID);
    revalidatePath("/admin/dashboard");
    return {
      ok: true,
      result: "VALID",
      message: `Bienvenue à ${gate}.`,
      participant: {
        id: participant.id,
        firstName: participant.firstName,
        lastName: participant.lastName,
        tier: participant.tier,
        gate: participant.gate,
        ticketCode: participant.ticketCode,
        checkedInAt: now
      }
    };
  }

  // count === 0 — either the participant was already checked in
  // before we started (repeat scan) or a concurrent scan won the
  // race. Either way, fetch the authoritative timestamp.
  const winner = await prisma.participant.findUnique({
    where: { id: participant.id },
    select: { checkedInAt: true }
  });
  await logScan(CheckInResult.ALREADY_CHECKED_IN);
  revalidatePath("/admin/dashboard");
  return {
    ok: true,
    result: "ALREADY_CHECKED_IN",
    message: `Déjà entré à ${gate}.`,
    participant: {
      id: participant.id,
      firstName: participant.firstName,
      lastName: participant.lastName,
      tier: participant.tier,
      gate: participant.gate,
      ticketCode: participant.ticketCode,
      checkedInAt: winner?.checkedInAt ?? participant.checkedInAt
    }
  };
}

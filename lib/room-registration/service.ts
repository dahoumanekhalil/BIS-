import "server-only";

import {
  AccessPointType,
  Prisma,
  RegistrationStatus,
  RoomRegistrationStatus
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { RoomRegistrationError } from "./errors";
import { auditMetaSchema, type RoomRegistrationAuditMeta } from "./meta-schema";
import { canReRegister, canTransition } from "./state-machine";
import { syncRoomAccessEntitlement } from "./sync";
import type {
  CancelInput,
  InitRegistrationInput,
  RoomRegistrationView,
  ServiceResult
} from "./types";

// ─── Room registration domain service (FREE-only) ─────────────────────
//
// This is the canonical, transactional, idempotent surface for the
// FREE room registration feature. Composes:
//
//   • state-machine.ts  (pure transition validation)
//   • meta-schema.ts    (Zod whitelist for AuditLog.meta)
//   • sync.ts           (single ParticipantAccess writer)
//   • lib/admin/audit   (existing AuditLog helper)
//
// Each public function:
//
//   1. Validates inputs at the boundary with Zod.
//   2. Opens a single Prisma interactive transaction.
//   3. Reads the current registration + AccessPoint state.
//   4. Applies the state machine (canTransition).
//   5. Writes the registration + calls syncRoomAccessEntitlement —
//      all inside the same tx.
//   6. Writes an AuditLog row post-commit (best-effort, uses the
//      `audit()` helper which never throws).
//
// Idempotency:
//   • Registration uniqueness: DB @@unique([participantId,accessPointId]).
//   • Duplicate cancel calls where the target state is already the
//     current state → no-op, returns existing view.

// ─── Input Zod schemas ────────────────────────────────────────────────

const idSchema = z.string().trim().min(10).max(64);
const optionalReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9 _.:-]+$/)
  .optional();

const initRegistrationSchema = z
  .object({
    participantId: idSchema,
    accessPointId: idSchema
  })
  .strict();

const cancelSchema = z
  .object({
    participantId: idSchema,
    accessPointId: idSchema,
    actorAdminId: idSchema.nullable(),
    reason: optionalReasonSchema
  })
  .strict();

// ─── Public API ───────────────────────────────────────────────────────

export async function initRegistration(
  input: InitRegistrationInput
): Promise<ServiceResult<RoomRegistrationView>> {
  const parsed = initRegistrationSchema.safeParse(input);
  if (!parsed.success) return err("INVALID_INPUT", "invalid initRegistration input");

  const { participantId, accessPointId } = parsed.data;

  // Concurrent-init race handling. On PostgreSQL a unique-violation
  // inside a transaction poisons the whole transaction. Instead we
  // let $transaction rethrow and retry the whole tx from the outside.
  // On retry the row now exists, so the "existing" branch returns the
  // winner idempotently.
  const MAX_RETRIES = 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await assertParticipantEligible(tx, participantId);
        await assertRoomEligible(tx, accessPointId);

        const existing = await tx.roomRegistration.findUnique({
          where: {
            participantId_accessPointId: { participantId, accessPointId }
          }
        });

        if (existing) {
          if (canReRegister(existing.status)) {
            const now = new Date();
            const before = existing.status;
            const updated = await tx.roomRegistration.update({
              where: { id: existing.id },
              data: {
                status: RoomRegistrationStatus.FREE_CONFIRMED,
                registeredAt: now,
                cancelledAt: null
              }
            });

            await syncRoomAccessEntitlement(tx, {
              participantId,
              accessPointId,
              status: RoomRegistrationStatus.FREE_CONFIRMED
            });
            return { view: toView(updated), transitioned: true, before };
          }

          // Live status → return as-is, no mutation.
          return {
            view: toView(existing),
            transitioned: false,
            before: existing.status
          };
        }

        const created = await tx.roomRegistration.create({
          data: {
            participantId,
            accessPointId,
            status: RoomRegistrationStatus.FREE_CONFIRMED
          }
        });

        await syncRoomAccessEntitlement(tx, {
          participantId,
          accessPointId,
          status: RoomRegistrationStatus.FREE_CONFIRMED
        });
        return { view: toView(created), transitioned: true, before: null };
      });

      await auditSafe({
        userId: null,
        action: "room-registration.init",
        registrationId: outcome.view.id,
        participantId: outcome.view.participantId,
        accessPointId: outcome.view.accessPointId,
        before: outcome.before,
        after: outcome.view.status,
        transitioned: outcome.transitioned
      });

      return ok(outcome.view);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        attempt < MAX_RETRIES
      ) {
        lastErr = e;
        continue;
      }
      return catchToErr(e);
    }
  }
  return catchToErr(lastErr);
}

export async function cancel(
  input: CancelInput
): Promise<ServiceResult<RoomRegistrationView>> {
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return err("INVALID_INPUT", "invalid cancel input");

  const { participantId, accessPointId, actorAdminId, reason } = parsed.data;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      if (actorAdminId) await assertAdminExists(tx, actorAdminId);
      const existing = await lockedRegistrationRow(tx, participantId, accessPointId);
      if (!existing) throw new RoomRegistrationError("REGISTRATION_NOT_FOUND");

      if (existing.status === RoomRegistrationStatus.CANCELLED) {
        return { view: toView(existing), transitioned: false, before: existing.status };
      }
      if (!canTransition(existing.status, RoomRegistrationStatus.CANCELLED)) {
        throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
      }

      const now = new Date();
      const before = existing.status;

      const conditional = await tx.roomRegistration.updateMany({
        where: { id: existing.id, status: before },
        data: {
          status: RoomRegistrationStatus.CANCELLED,
          cancelledAt: now
        }
      });
      if (conditional.count !== 1) {
        const refetched = await tx.roomRegistration.findUniqueOrThrow({
          where: { id: existing.id }
        });
        if (refetched.status !== RoomRegistrationStatus.CANCELLED) {
          throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
        }
        return { view: toView(refetched), transitioned: false, before };
      }

      const updated = await tx.roomRegistration.findUniqueOrThrow({
        where: { id: existing.id }
      });

      await syncRoomAccessEntitlement(tx, {
        participantId,
        accessPointId,
        status: RoomRegistrationStatus.CANCELLED
      });

      return { view: toView(updated), transitioned: true, before };
    });

    if (outcome.transitioned) {
      await auditSafe({
        userId: actorAdminId ?? null,
        action: "room-registration.cancel",
        registrationId: outcome.view.id,
        participantId: outcome.view.participantId,
        accessPointId: outcome.view.accessPointId,
        before: outcome.before,
        after: RoomRegistrationStatus.CANCELLED,
        reason,
        transitioned: true
      });
    }
    return ok(outcome.view);
  } catch (e) {
    return catchToErr(e);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

async function assertParticipantEligible(tx: Tx, participantId: string) {
  const p = await tx.participant.findUnique({
    where: { id: participantId },
    select: { id: true, status: true }
  });
  if (!p) throw new RoomRegistrationError("PARTICIPANT_NOT_FOUND");
  if (p.status === RegistrationStatus.CANCELLED) {
    throw new RoomRegistrationError("PARTICIPANT_CANCELLED");
  }
}

async function assertRoomEligible(tx: Tx, accessPointId: string) {
  const ap = await tx.accessPoint.findUnique({
    where: { id: accessPointId },
    select: {
      id: true,
      type: true,
      active: true
    }
  });
  if (!ap) throw new RoomRegistrationError("ACCESS_POINT_NOT_FOUND");
  if (ap.type !== AccessPointType.ROOM) throw new RoomRegistrationError("NOT_A_ROOM");
  if (!ap.active) throw new RoomRegistrationError("ACCESS_POINT_INACTIVE");

  return ap;
}

async function assertAdminExists(tx: Tx, adminId: string) {
  const a = await tx.adminUser.findUnique({
    where: { id: adminId },
    select: { id: true }
  });
  if (!a) throw new RoomRegistrationError("ADMIN_NOT_FOUND");
}

async function lockedRegistrationRow(
  tx: Tx,
  participantId: string,
  accessPointId: string
) {
  return await tx.roomRegistration.findUnique({
    where: {
      participantId_accessPointId: { participantId, accessPointId }
    }
  });
}

async function auditSafe(payload: {
  userId: string | null;
  action: string;
  registrationId: string;
  participantId: string;
  accessPointId: string;
  before?: RoomRegistrationStatus | null;
  after?: RoomRegistrationStatus;
  reason?: string;
  transitioned?: boolean;
}) {
  try {
    const meta: RoomRegistrationAuditMeta = auditMetaSchema.parse({
      registrationId: payload.registrationId,
      participantId: payload.participantId,
      accessPointId: payload.accessPointId,
      before: payload.before ?? null,
      after: payload.after,
      reason: payload.reason,
      transitioned: payload.transitioned
    });
    await audit({
      userId: payload.userId,
      action: payload.action,
      entity: "RoomRegistration",
      entityId: payload.registrationId,
      meta
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[room-registration] audit failed", e);
  }
}

function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}
function err(
  code: RoomRegistrationError["code"],
  message: string
): ServiceResult<never> {
  return { ok: false, code, message };
}
function catchToErr(e: unknown): ServiceResult<never> {
  if (e instanceof RoomRegistrationError) {
    return { ok: false, code: e.code, message: e.message };
  }
  // eslint-disable-next-line no-console
  console.error("[room-registration] unexpected error", e);
  return {
    ok: false,
    code: "INTERNAL_ERROR",
    message: "Unexpected error"
  };
}

function toView(r: {
  id: string;
  participantId: string;
  accessPointId: string;
  status: RoomRegistrationStatus;
  registeredAt: Date;
  cancelledAt: Date | null;
}): RoomRegistrationView {
  return {
    id: r.id,
    participantId: r.participantId,
    accessPointId: r.accessPointId,
    status: r.status,
    registeredAt: r.registeredAt,
    cancelledAt: r.cancelledAt
  };
}

// Re-exports so callers get one import from `lib/room-registration`.
export type {
  CancelInput,
  InitRegistrationInput,
  RoomRegistrationView,
  ServiceResult
} from "./types";
export { RoomRegistrationError } from "./errors";

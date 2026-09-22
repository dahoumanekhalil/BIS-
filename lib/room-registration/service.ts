import "server-only";

import {
  AccessPointType,
  AdmissionMode,
  Prisma,
  RegistrationStatus,
  RoomPaymentEventKind,
  RoomRegistrationStatus
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { RoomRegistrationError } from "./errors";
import {
  auditMetaSchema,
  roomPaymentEventMetaSchema,
  type RoomPaymentEventMeta,
  type RoomRegistrationAuditMeta
} from "./meta-schema";
import { canReRegister, canTransition } from "./state-machine";
import { syncRoomAccessEntitlement } from "./sync";
import type {
  CancelInput,
  ConfirmPaymentInput,
  ExpireInput,
  FailPaymentInput,
  InitRegistrationInput,
  RefundInput,
  RoomRegistrationView,
  ServiceResult,
  TrustedPaymentConfirmation
} from "./types";

// ─── Room registration domain service — Sub-Phase C ───────────────────
//
// This is the canonical, transactional, idempotent surface for the
// paid/free room registration feature. It composes:
//
//   • state-machine.ts  (pure transition validation)
//   • meta-schema.ts    (Zod whitelist for RoomPaymentEvent.meta)
//   • sync.ts           (single ParticipantAccess writer)
//   • lib/admin/audit   (existing AuditLog helper)
//
// Every public function:
//
//   1. Validates inputs at the boundary with Zod.
//   2. Opens a single Prisma interactive transaction.
//   3. Reads the current registration + AccessPoint state.
//   4. Applies the state machine (canTransition).
//   5. Writes the registration + emits exactly one RoomPaymentEvent
//      + calls syncRoomAccessEntitlement — all inside the same tx.
//   6. Writes an AuditLog row post-commit (best-effort, uses the
//     `audit()` helper which never throws).
//
// Idempotency:
//   • Registration uniqueness: DB @@unique([participantId,accessPointId]).
//   • Duplicate confirm/refund/fail/cancel where the target state
//     is already the current state → no-op, returns existing view,
//     no duplicate event emitted, no duplicate audit row.
//   • Duplicate provider webhook (same providerRef) → partial
//     unique index rejects the event insert; the service catches
//     P2002 and returns the existing view.
//   • Conflicting providerRef against an already-PAID registration
//     → PROVIDER_REF_CONFLICT.
//
// Trust boundary:
//   • Amount + currency are ALWAYS resolved from the RoomRegistration
//     snapshot inside the tx. Callers cannot override.
//   • confirmPayment / refund / cancel accept an `actorAdminId` OR
//     a `providerRef`. Neither is trusted by identity — the caller
//     (server action or verified webhook route) is responsible for
//     having authenticated the source.
//   • RoomPaymentEvent.meta is Zod-validated at the write boundary;
//     unknown keys are stripped.

// ─── Input Zod schemas ────────────────────────────────────────────────

const idSchema = z.string().trim().min(10).max(64);
const optionalReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9 _.:-]+$/)
  .optional();
// Sub-Phase F0 §5b — providerRef character set is constrained at the
// domain boundary so it stays consistent with `auditMetaSchema`. See
// `meta-schema.ts:providerRefRegex` for the rationale. This is the
// gate every trusted-provider path passes through — a real
// verified-webhook adapter that receives an unusual character set
// must have already stripped/rejected it before calling the domain.
const optionalProviderRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/, "providerRef must be [A-Za-z0-9_.:-]+")
  .optional()
  .nullable();

const initRegistrationSchema = z
  .object({
    participantId: idSchema,
    accessPointId: idSchema,
    expiresAt: z
      .date()
      .optional()
      .nullable()
      .transform((v) => v ?? null)
  })
  .strict();

const confirmSchema = z
  .object({
    participantId: idSchema,
    accessPointId: idSchema,
    confirmation: z
      .object({
        // Sub-Phase F0 §5b — same character-set gate as
        // optionalProviderRefSchema. Kept inline (rather than reused)
        // because this one is nullable but not optional.
        providerRef: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .regex(
            /^[A-Za-z0-9_.:-]+$/,
            "providerRef must be [A-Za-z0-9_.:-]+"
          )
          .nullable(),
        actorAdminId: idSchema.nullable(),
        reason: optionalReasonSchema
      })
      .strict()
  })
  .strict();

const failSchema = z
  .object({
    participantId: idSchema,
    accessPointId: idSchema,
    actorAdminId: idSchema.nullable(),
    providerRef: optionalProviderRefSchema,
    reason: optionalReasonSchema
  })
  .strict();

const refundSchema = z
  .object({
    participantId: idSchema,
    accessPointId: idSchema,
    actorAdminId: idSchema.nullable(),
    providerRef: optionalProviderRefSchema,
    reason: optionalReasonSchema
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

const expireSchema = z
  .object({
    participantId: idSchema,
    accessPointId: idSchema,
    // Sub-Phase D §8 — expire is a system-driven maintenance
    // operation. `at` is the reference "now" the caller uses to
    // check expiresAt against; injecting it keeps the service
    // deterministic under test.
    at: z.date().optional()
  })
  .strict();

// ─── Public API ───────────────────────────────────────────────────────

export async function initRegistration(
  input: InitRegistrationInput
): Promise<ServiceResult<RoomRegistrationView>> {
  const parsed = initRegistrationSchema.safeParse(input);
  if (!parsed.success) return err("INVALID_INPUT", "invalid initRegistration input");

  const { participantId, accessPointId, expiresAt } = parsed.data;

  // Concurrent-init race handling. In PostgreSQL, a unique-violation
  // inside a transaction poisons the whole transaction — catching
  // P2002 INSIDE the tx does not let us refetch. Instead we let the
  // transaction abort and retry once at this outer layer. On retry
  // the row now exists, so the tx enters the idempotent
  // "existing row" branch and returns the winner's view.
  // Concurrent-init race handling. In PostgreSQL a unique-violation
  // aborts the enclosing transaction, so catching P2002 *inside* the
  // tx and calling findUniqueOrThrow again would just hit
  // "current transaction is aborted". Instead we let $transaction
  // rethrow, and retry the whole tx from the outside. On retry the
  // row now exists, so the "existing" branch returns the winner
  // idempotently.
  const MAX_RETRIES = 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await assertParticipantEligible(tx, participantId);
        const ap = await assertRoomEligible(tx, accessPointId);

        const existing = await tx.roomRegistration.findUnique({
          where: {
            participantId_accessPointId: { participantId, accessPointId }
          }
        });

        // Idempotency: if a live registration exists, do NOT mutate.
        if (existing) {
          // Terminal-but-reactivatable → re-register through the state
          // machine. REFUNDED is deliberately NOT reactivatable
          // (see state-machine.ts:canReRegister).
          if (canReRegister(existing.status)) {
            const targetStatus = deriveInitialStatus(ap.admissionMode);
            const now = new Date();
            const priceMinor = ap.admissionMode === AdmissionMode.PAID ? ap.priceMinor : null;
            const currency = ap.admissionMode === AdmissionMode.PAID ? ap.currency : null;

            const before = existing.status;
            const updated = await tx.roomRegistration.update({
              where: { id: existing.id },
              data: {
                status: targetStatus,
                // Freeze a fresh snapshot for the new attempt. This is
                // the ONLY place inside the domain where the snapshot
                // is (re)written — a currently-active row's snapshot
                // is otherwise immutable.
                priceMinorSnapshot: priceMinor,
                currencySnapshot: currency,
                paymentRef: null,
                registeredAt: now,
                paidAt: null,
                cancelledAt: null,
                refundedAt: null,
                failedAt: null,
                expiresAt: expiresAt ?? null
              }
            });

            await emitEvent(tx, {
              registrationId: updated.id,
              kind: RoomPaymentEventKind.INIT,
              providerRef: null,
              actorAdminId: null,
              meta: {
                transition: { before, after: targetStatus },
                source: "system",
                kind: RoomPaymentEventKind.INIT
              }
            });

            if (targetStatus === RoomRegistrationStatus.FREE_CONFIRMED) {
              await syncRoomAccessEntitlement(tx, {
                participantId,
                accessPointId,
                status: RoomRegistrationStatus.FREE_CONFIRMED
              });
            }
            return { view: toView(updated), transitioned: true, before };
          }

          // Live/terminal-non-reactivatable status → return as-is,
          // no mutation, no duplicate event.
          return {
            view: toView(existing),
            transitioned: false,
            before: existing.status
          };
        }

        // No existing row — create a fresh registration. If another
        // concurrent transaction wins the race, this create throws
        // P2002 which aborts the whole tx; the outer retry loop
        // re-enters this callback and the "existing" branch above
        // returns the winner.
        const targetStatus = deriveInitialStatus(ap.admissionMode);
        const priceMinor = ap.admissionMode === AdmissionMode.PAID ? ap.priceMinor : null;
        const currency = ap.admissionMode === AdmissionMode.PAID ? ap.currency : null;
        const created = await tx.roomRegistration.create({
          data: {
            participantId,
            accessPointId,
            status: targetStatus,
            priceMinorSnapshot: priceMinor,
            currencySnapshot: currency,
            expiresAt: expiresAt ?? null
          }
        });

        await emitEvent(tx, {
          registrationId: created.id,
          kind: RoomPaymentEventKind.INIT,
          providerRef: null,
          actorAdminId: null,
          meta: {
            transition: { before: targetStatus, after: targetStatus },
            source: "system",
            kind: RoomPaymentEventKind.INIT
          }
        });

        if (targetStatus === RoomRegistrationStatus.FREE_CONFIRMED) {
          await syncRoomAccessEntitlement(tx, {
            participantId,
            accessPointId,
            status: RoomRegistrationStatus.FREE_CONFIRMED
          });
        }
        return { view: toView(created), transitioned: true, before: null };
      });

      // Sub-Phase D §9 — audit every init call, but tag whether it
      // actually transitioned state. A duplicate init that finds a
      // live/refunded row and returns as-is is recorded as
      // transitioned=false so operators can distinguish "no-op replay"
      // from "row created / reactivated" without joining
      // RoomPaymentEvent.
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
      // Only retry on unique-constraint races. Any other error is
      // final and translates via catchToErr.
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

export async function confirmPayment(
  input: ConfirmPaymentInput
): Promise<ServiceResult<RoomRegistrationView>> {
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return err("INVALID_INPUT", "invalid confirmPayment input");

  const { participantId, accessPointId, confirmation } = parsed.data;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      if (confirmation.actorAdminId) await assertAdminExists(tx, confirmation.actorAdminId);

      const existing = await lockedRegistrationRow(tx, participantId, accessPointId);
      if (!existing) throw new RoomRegistrationError("REGISTRATION_NOT_FOUND");

      // Re-delivery detection (before any mutation, per the P2002-
      // safety comment on providerEventAlreadyRecorded): if we've
      // already recorded a CONFIRM/FAIL/REFUND event for this
      // registrationId + providerRef pair, this call is a duplicate.
      // Return the current view without transitioning, without
      // emitting a duplicate event.
      if (
        await providerEventAlreadyRecorded(tx, existing.id, confirmation.providerRef ?? null)
      ) {
        return { view: toView(existing), transitioned: false };
      }

      // Idempotent path: already PAID.
      if (existing.status === RoomRegistrationStatus.PAID) {
        // Same providerRef (or both NULL) → no-op. Different non-null
        // providerRef → reject (never overwrite trusted payment
        // identity).
        const currentRef = existing.paymentRef ?? null;
        const incomingRef = confirmation.providerRef ?? null;
        if (currentRef === null && incomingRef === null) {
          return { view: toView(existing), transitioned: false };
        }
        if (currentRef !== null && incomingRef !== null && currentRef === incomingRef) {
          return { view: toView(existing), transitioned: false };
        }
        if (currentRef !== incomingRef) {
          throw new RoomRegistrationError("PROVIDER_REF_CONFLICT");
        }
        return { view: toView(existing), transitioned: false };
      }

      // Any non-PENDING_PAYMENT status must reject — the state
      // machine defines PENDING_PAYMENT → PAID as the only
      // confirm-authorised transition. FREE_CONFIRMED never
      // needs a payment confirmation (fails cleanly here).
      if (!canTransition(existing.status, RoomRegistrationStatus.PAID)) {
        throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
      }

      // Sanity: a PENDING_PAYMENT row must have a positive snapshot.
      if (
        existing.priceMinorSnapshot === null ||
        existing.priceMinorSnapshot <= 0 ||
        existing.currencySnapshot === null
      ) {
        throw new RoomRegistrationError("INVALID_PRICE");
      }

      const now = new Date();
      const before = existing.status;

      // Conditional update — only succeeds if the row is still in
      // PENDING_PAYMENT. Protects against two concurrent confirmations
      // both trying to move the same row to PAID.
      const conditional = await tx.roomRegistration.updateMany({
        where: {
          id: existing.id,
          status: RoomRegistrationStatus.PENDING_PAYMENT
        },
        data: {
          status: RoomRegistrationStatus.PAID,
          paidAt: now,
          paymentRef: confirmation.providerRef ?? null
        }
      });
      if (conditional.count !== 1) {
        // Another concurrent transaction beat us to PAID. Refetch
        // and treat this call as idempotent iff the outcome
        // matches (same providerRef).
        const refetched = await tx.roomRegistration.findUniqueOrThrow({
          where: { id: existing.id }
        });
        if (refetched.status !== RoomRegistrationStatus.PAID) {
          throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
        }
        if ((refetched.paymentRef ?? null) !== (confirmation.providerRef ?? null)) {
          throw new RoomRegistrationError("PROVIDER_REF_CONFLICT");
        }
        return { view: toView(refetched), transitioned: false };
      }

      const updated = await tx.roomRegistration.findUniqueOrThrow({
        where: { id: existing.id }
      });

      // Emit exactly one CONFIRM event. If the partial unique index
      // (registrationId, providerRef) fires here (residual race
      // between the pre-check and this insert), we intentionally
      // rethrow — a swallowed P2002 would leave the tx in an
      // aborted-but-not-rolled-back state on Postgres.
      await emitEvent(tx, {
        registrationId: updated.id,
        kind: RoomPaymentEventKind.CONFIRM,
        providerRef: confirmation.providerRef ?? null,
        actorAdminId: confirmation.actorAdminId,
        meta: {
          transition: { before, after: RoomRegistrationStatus.PAID },
          source: confirmation.actorAdminId ? "admin" : "webhook",
          reason: confirmation.reason,
          kind: RoomPaymentEventKind.CONFIRM,
          priceMinorSnapshot: existing.priceMinorSnapshot,
          currencySnapshot: existing.currencySnapshot ?? undefined
        }
      });

      await syncRoomAccessEntitlement(tx, {
        participantId,
        accessPointId,
        status: RoomRegistrationStatus.PAID
      });

      return { view: toView(updated), transitioned: true };
    });

    if (outcome.transitioned) {
      await auditSafe({
        userId: input.confirmation.actorAdminId ?? null,
        action: "room-registration.confirm",
        registrationId: outcome.view.id,
        participantId: outcome.view.participantId,
        accessPointId: outcome.view.accessPointId,
        before: RoomRegistrationStatus.PENDING_PAYMENT,
        after: RoomRegistrationStatus.PAID,
        providerRef: outcome.view.paymentRef,
        reason: input.confirmation.reason,
        transitioned: true
      });
    }

    return ok(outcome.view);
  } catch (e) {
    return catchToErr(e);
  }
}

export async function failPayment(
  input: FailPaymentInput
): Promise<ServiceResult<RoomRegistrationView>> {
  const parsed = failSchema.safeParse(input);
  if (!parsed.success) return err("INVALID_INPUT", "invalid failPayment input");

  const { participantId, accessPointId, actorAdminId, providerRef, reason } = parsed.data;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      if (actorAdminId) await assertAdminExists(tx, actorAdminId);

      const existing = await lockedRegistrationRow(tx, participantId, accessPointId);
      if (!existing) throw new RoomRegistrationError("REGISTRATION_NOT_FOUND");

      // Re-delivery detection (see providerEventAlreadyRecorded).
      if (await providerEventAlreadyRecorded(tx, existing.id, providerRef ?? null)) {
        return { view: toView(existing), transitioned: false };
      }

      // Idempotent path.
      if (existing.status === RoomRegistrationStatus.PAYMENT_FAILED) {
        return { view: toView(existing), transitioned: false };
      }

      // Late-failure protection: cannot downgrade PAID via a failure.
      if (existing.status === RoomRegistrationStatus.PAID) {
        throw new RoomRegistrationError("LATE_FAILURE_ON_PAID");
      }

      if (!canTransition(existing.status, RoomRegistrationStatus.PAYMENT_FAILED)) {
        throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
      }

      const now = new Date();
      const before = existing.status;

      const conditional = await tx.roomRegistration.updateMany({
        where: {
          id: existing.id,
          status: RoomRegistrationStatus.PENDING_PAYMENT
        },
        data: {
          status: RoomRegistrationStatus.PAYMENT_FAILED,
          failedAt: now
        }
      });
      if (conditional.count !== 1) {
        const refetched = await tx.roomRegistration.findUniqueOrThrow({
          where: { id: existing.id }
        });
        if (refetched.status !== RoomRegistrationStatus.PAYMENT_FAILED) {
          throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
        }
        return { view: toView(refetched), transitioned: false };
      }

      const updated = await tx.roomRegistration.findUniqueOrThrow({
        where: { id: existing.id }
      });

      // Emit exactly one FAIL event. Residual P2002 from a race
      // between the pre-check and this insert is rethrown — a
      // swallowed P2002 poisons the tx on Postgres.
      await emitEvent(tx, {
        registrationId: updated.id,
        kind: RoomPaymentEventKind.FAIL,
        providerRef: providerRef ?? null,
        actorAdminId,
        meta: {
          transition: { before, after: RoomRegistrationStatus.PAYMENT_FAILED },
          source: actorAdminId ? "admin" : "webhook",
          reason: reason,
          kind: RoomPaymentEventKind.FAIL
        }
      });

      // No sync call: PAYMENT_FAILED never grants access, and any
      // REGISTRATION-owned row from a hypothetical prior grant is
      // handled by the refund/cancel paths — a failed payment on a
      // PENDING_PAYMENT row means no grant was ever materialised.
      return { view: toView(updated), transitioned: true };
    });

    if (outcome.transitioned) {
      await auditSafe({
        userId: actorAdminId ?? null,
        action: "room-registration.fail",
        registrationId: outcome.view.id,
        participantId: outcome.view.participantId,
        accessPointId: outcome.view.accessPointId,
        before: RoomRegistrationStatus.PENDING_PAYMENT,
        after: RoomRegistrationStatus.PAYMENT_FAILED,
        providerRef: outcome.view.paymentRef,
        reason,
        transitioned: true
      });
    }
    return ok(outcome.view);
  } catch (e) {
    return catchToErr(e);
  }
}

export async function refund(
  input: RefundInput
): Promise<ServiceResult<RoomRegistrationView>> {
  const parsed = refundSchema.safeParse(input);
  if (!parsed.success) return err("INVALID_INPUT", "invalid refund input");

  const { participantId, accessPointId, actorAdminId, providerRef, reason } = parsed.data;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      if (actorAdminId) await assertAdminExists(tx, actorAdminId);
      const existing = await lockedRegistrationRow(tx, participantId, accessPointId);
      if (!existing) throw new RoomRegistrationError("REGISTRATION_NOT_FOUND");

      // Re-delivery detection (see providerEventAlreadyRecorded).
      if (await providerEventAlreadyRecorded(tx, existing.id, providerRef ?? null)) {
        return { view: toView(existing), transitioned: false };
      }

      if (existing.status === RoomRegistrationStatus.REFUNDED) {
        return { view: toView(existing), transitioned: false };
      }
      if (!canTransition(existing.status, RoomRegistrationStatus.REFUNDED)) {
        throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
      }

      const now = new Date();
      const before = existing.status;

      const conditional = await tx.roomRegistration.updateMany({
        where: { id: existing.id, status: RoomRegistrationStatus.PAID },
        data: {
          status: RoomRegistrationStatus.REFUNDED,
          refundedAt: now
        }
      });
      if (conditional.count !== 1) {
        const refetched = await tx.roomRegistration.findUniqueOrThrow({
          where: { id: existing.id }
        });
        if (refetched.status !== RoomRegistrationStatus.REFUNDED) {
          throw new RoomRegistrationError("INVALID_STATE_TRANSITION");
        }
        return { view: toView(refetched), transitioned: false };
      }

      const updated = await tx.roomRegistration.findUniqueOrThrow({
        where: { id: existing.id }
      });

      // Emit exactly one REFUND event. Residual P2002 from a race
      // between the pre-check and this insert is rethrown — a
      // swallowed P2002 poisons the tx on Postgres.
      await emitEvent(tx, {
        registrationId: updated.id,
        kind: RoomPaymentEventKind.REFUND,
        providerRef: providerRef ?? null,
        actorAdminId,
        meta: {
          transition: { before, after: RoomRegistrationStatus.REFUNDED },
          source: actorAdminId ? "admin" : "webhook",
          reason,
          kind: RoomPaymentEventKind.REFUND
        }
      });

      await syncRoomAccessEntitlement(tx, {
        participantId,
        accessPointId,
        status: RoomRegistrationStatus.REFUNDED
      });

      return { view: toView(updated), transitioned: true };
    });

    if (outcome.transitioned) {
      await auditSafe({
        userId: actorAdminId ?? null,
        action: "room-registration.refund",
        registrationId: outcome.view.id,
        participantId: outcome.view.participantId,
        accessPointId: outcome.view.accessPointId,
        before: RoomRegistrationStatus.PAID,
        after: RoomRegistrationStatus.REFUNDED,
        providerRef: outcome.view.paymentRef,
        reason,
        transitioned: true
      });
    }
    return ok(outcome.view);
  } catch (e) {
    return catchToErr(e);
  }
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
        return { view: toView(existing), transitioned: false };
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
        return { view: toView(refetched), transitioned: false };
      }

      const updated = await tx.roomRegistration.findUniqueOrThrow({
        where: { id: existing.id }
      });

      await emitEvent(tx, {
        registrationId: updated.id,
        kind: RoomPaymentEventKind.CANCEL,
        providerRef: null,
        actorAdminId,
        meta: {
          transition: { before, after: RoomRegistrationStatus.CANCELLED },
          source: actorAdminId ? "admin" : "system",
          reason,
          kind: RoomPaymentEventKind.CANCEL
        }
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
        before: (outcome as { before: RoomRegistrationStatus }).before,
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

// ─── Expire (Sub-Phase D §8) ───────────────────────────────────────────
//
// Transitions a single PENDING_PAYMENT registration to EXPIRED iff its
// expiresAt is strictly in the past relative to `at` (defaults to now).
//
// This is a system-driven maintenance operation — never triggered by a
// participant action, never triggered by an admin action. The
// maintenance script `scripts/expire-room-registrations.ts` iterates
// candidates and calls this function per row.
//
// Design decisions:
//
//   • NEVER invent a duration. If a registration has expiresAt=null,
//     this function is a no-op (transitioned=false) — matches the
//     Sub-Phase D §8 explicit constraint that no arbitrary expiry is
//     assumed by the maintenance layer.
//   • Idempotent. Repeat calls on an already-EXPIRED row return the
//     existing view with transitioned=false. No duplicate event emitted.
//   • ADMIN-owned ParticipantAccess is preserved (syncRoomAccessEntitlement
//     never mutates source=ADMIN rows).
//   • Only PENDING_PAYMENT → EXPIRED. Every other current status
//     (FREE_CONFIRMED, PAID, PAYMENT_FAILED, CANCELLED, REFUNDED,
//     EXPIRED already) is rejected/no-op via the state machine.
export async function expire(
  input: ExpireInput
): Promise<ServiceResult<RoomRegistrationView>> {
  const parsed = expireSchema.safeParse(input);
  if (!parsed.success) return err("INVALID_INPUT", "invalid expire input");

  const { participantId, accessPointId, at } = parsed.data;
  const now = at ?? new Date();

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await lockedRegistrationRow(tx, participantId, accessPointId);
      if (!existing) throw new RoomRegistrationError("REGISTRATION_NOT_FOUND");

      // Idempotent path.
      if (existing.status === RoomRegistrationStatus.EXPIRED) {
        return { view: toView(existing), transitioned: false };
      }

      // Never expire a row that has no deadline set. The maintenance
      // script must never manufacture an expiry — Sub-Phase D §8.
      if (!existing.expiresAt) {
        return { view: toView(existing), transitioned: false };
      }

      // Deadline still in the future — not yet expired.
      if (existing.expiresAt.getTime() > now.getTime()) {
        return { view: toView(existing), transitioned: false };
      }

      // Only PENDING_PAYMENT is eligible per the state machine.
      if (!canTransition(existing.status, RoomRegistrationStatus.EXPIRED)) {
        // State machine forbids: caller passed a stale row (already
        // CANCELLED / PAID / etc.). Not an error — the script may see
        // rows that transitioned via another path between listing and
        // per-row processing.
        return { view: toView(existing), transitioned: false };
      }

      const before = existing.status;

      const conditional = await tx.roomRegistration.updateMany({
        where: {
          id: existing.id,
          status: RoomRegistrationStatus.PENDING_PAYMENT
        },
        data: {
          status: RoomRegistrationStatus.EXPIRED
        }
      });
      if (conditional.count !== 1) {
        // Another concurrent transition beat us. Refetch and
        // idempotently return whatever the row is now.
        const refetched = await tx.roomRegistration.findUniqueOrThrow({
          where: { id: existing.id }
        });
        return { view: toView(refetched), transitioned: false };
      }

      const updated = await tx.roomRegistration.findUniqueOrThrow({
        where: { id: existing.id }
      });

      await emitEvent(tx, {
        registrationId: updated.id,
        kind: RoomPaymentEventKind.FAIL, // no dedicated EXPIRE kind in
        // the enum — we reuse FAIL with a meta.reason="expired" tag.
        // This keeps the enum stable across phases while providing an
        // append-only audit trail; state=EXPIRED is derivable from
        // RoomRegistration.status.
        providerRef: null,
        actorAdminId: null,
        meta: {
          transition: { before, after: RoomRegistrationStatus.EXPIRED },
          source: "system",
          reason: "expired",
          kind: RoomPaymentEventKind.FAIL
        }
      });

      // Registration was PENDING_PAYMENT → no PA row was ever
      // materialised (sync only grants on FREE_CONFIRMED / PAID).
      // Calling sync with EXPIRED still safely returns
      // "status-does-not-require-sync" — see sync.ts.
      await syncRoomAccessEntitlement(tx, {
        participantId,
        accessPointId,
        status: RoomRegistrationStatus.EXPIRED
      });

      return { view: toView(updated), transitioned: true, before };
    });

    if (outcome.transitioned) {
      await auditSafe({
        userId: null,
        action: "room-registration.expire",
        registrationId: outcome.view.id,
        participantId: outcome.view.participantId,
        accessPointId: outcome.view.accessPointId,
        before: (outcome as { before: RoomRegistrationStatus }).before,
        after: RoomRegistrationStatus.EXPIRED,
        reason: "expired",
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
      active: true,
      admissionMode: true,
      priceMinor: true,
      currency: true
    }
  });
  if (!ap) throw new RoomRegistrationError("ACCESS_POINT_NOT_FOUND");
  if (ap.type !== AccessPointType.ROOM) throw new RoomRegistrationError("NOT_A_ROOM");
  if (!ap.active) throw new RoomRegistrationError("ACCESS_POINT_INACTIVE");
  if (!ap.admissionMode) throw new RoomRegistrationError("ADMISSION_MODE_NOT_SET");

  if (ap.admissionMode === AdmissionMode.PAID) {
    if (ap.priceMinor === null) throw new RoomRegistrationError("PAID_ROOM_MISSING_PRICE");
    if (ap.priceMinor <= 0) throw new RoomRegistrationError("INVALID_PRICE");
    if (!ap.currency) throw new RoomRegistrationError("PAID_ROOM_MISSING_CURRENCY");
    // DZD-only for this phase (approved in Sub-Phase A).
    if (ap.currency !== "DZD") throw new RoomRegistrationError("UNSUPPORTED_CURRENCY");
  }

  return ap;
}

async function assertAdminExists(tx: Tx, adminId: string) {
  const a = await tx.adminUser.findUnique({
    where: { id: adminId },
    select: { id: true }
  });
  if (!a) throw new RoomRegistrationError("ADMIN_NOT_FOUND");
}

// Pre-check for a prior RoomPaymentEvent(registrationId, providerRef).
// Called at the START of the state-transition tx, BEFORE any mutation.
//
// Why this exists: the partial unique index
//   (registrationId, providerRef) WHERE providerRef IS NOT NULL
// on RoomPaymentEvent is a correctness *guarantee* — but on
// PostgreSQL, a unique-violation raised INSIDE a transaction aborts
// the whole tx (`current transaction is aborted`). Catching P2002 in
// JS does not un-abort the tx — subsequent statements silently fail
// and the whole transaction rolls back, losing the intended state
// change. So we detect duplicates BEFORE the state mutation and
// short-circuit into the idempotent path; the DB index remains as a
// last-line-of-defence race safety net.
//
// Returns true if the same (registrationId, providerRef) has already
// been recorded — meaning the incoming call is a re-delivery.
async function providerEventAlreadyRecorded(
  tx: Tx,
  registrationId: string,
  providerRef: string | null
): Promise<boolean> {
  if (providerRef === null) return false;
  const prior = await tx.roomPaymentEvent.findFirst({
    where: { registrationId, providerRef },
    select: { id: true }
  });
  return prior !== null;
}

// The domain does not use SELECT FOR UPDATE explicitly — Postgres
// under Prisma's default transaction isolation (READ COMMITTED)
// combined with conditional updateMany() gives us the serialisation
// we need for the transitions. `lockedRegistrationRow` is a name
// hint: use it wherever a subsequent conditional write depends on
// a preceding read of the same row.
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

function deriveInitialStatus(mode: AdmissionMode | null): RoomRegistrationStatus {
  if (mode === AdmissionMode.FREE) return RoomRegistrationStatus.FREE_CONFIRMED;
  if (mode === AdmissionMode.PAID) return RoomRegistrationStatus.PENDING_PAYMENT;
  // Guarded by assertRoomEligible before we reach here.
  throw new RoomRegistrationError("ADMISSION_MODE_NOT_SET");
}

// Zod-validates the meta payload, strips unknown keys, and creates
// the RoomPaymentEvent row. Throws Prisma P2002 on duplicate
// (registrationId, providerRef) with a non-null providerRef; the
// service's outer try/catch translates that into idempotent behavior.
async function emitEvent(
  tx: Tx,
  args: {
    registrationId: string;
    kind: RoomPaymentEventKind;
    providerRef: string | null;
    actorAdminId: string | null;
    meta: Partial<RoomPaymentEventMeta>;
  }
) {
  const meta = roomPaymentEventMetaSchema.parse(args.meta);
  await tx.roomPaymentEvent.create({
    data: {
      registrationId: args.registrationId,
      kind: args.kind,
      providerRef: args.providerRef,
      actorAdminId: args.actorAdminId,
      meta: meta as Prisma.InputJsonValue
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
  providerRef?: string | null;
  reason?: string;
  transitioned?: boolean;
}) {
  // Audit is a best-effort side-channel. The state change has
  // already committed by the time we get here; a Zod parse failure
  // or logging outage must NOT be surfaced as a domain error.
  try {
    const meta: RoomRegistrationAuditMeta = auditMetaSchema.parse({
      registrationId: payload.registrationId,
      participantId: payload.participantId,
      accessPointId: payload.accessPointId,
      before: payload.before ?? null,
      after: payload.after,
      providerRef: payload.providerRef ?? null,
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
  // Any other throw is an unexpected server-side error. We surface a
  // stable generic result — no raw message, no stack, no Prisma
  // detail leaks — but log the original to stderr so ops has a trace
  // (INVALID_INPUT for a database blip would be misleading).
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
  priceMinorSnapshot: number | null;
  currencySnapshot: string | null;
  paymentRef: string | null;
  registeredAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  failedAt: Date | null;
  expiresAt: Date | null;
}): RoomRegistrationView {
  return {
    id: r.id,
    participantId: r.participantId,
    accessPointId: r.accessPointId,
    status: r.status,
    priceMinorSnapshot: r.priceMinorSnapshot,
    currencySnapshot: r.currencySnapshot,
    paymentRef: r.paymentRef,
    registeredAt: r.registeredAt,
    paidAt: r.paidAt,
    cancelledAt: r.cancelledAt,
    refundedAt: r.refundedAt,
    failedAt: r.failedAt,
    expiresAt: r.expiresAt
  };
}

// Re-exports so callers get one import from `lib/room-registration`.
export type {
  CancelInput,
  ConfirmPaymentInput,
  ExpireInput,
  FailPaymentInput,
  InitRegistrationInput,
  RefundInput,
  RoomRegistrationView,
  ServiceResult,
  TrustedPaymentConfirmation
} from "./types";
export { RoomRegistrationError } from "./errors";

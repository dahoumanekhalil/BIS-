import { z } from "zod";
import { RoomRegistrationStatus } from "@prisma/client";

// ─── AuditLog.meta shape for room-registration operations ─────────────
//
// The `audit()` helper accepts `unknown`, but this whitelist ensures
// only stable identifiers and short enum-style values reach the log —
// no PII, no secrets, no free-form user input.
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9 _.:-]+$/,
    "reason must be short ASCII with only [A-Za-z0-9 _.:-]"
  )
  .optional();

export const auditMetaSchema = z
  .object({
    registrationId: z.string().min(1).optional(),
    accessPointId: z.string().min(1).optional(),
    participantId: z.string().min(1).optional(),
    before: z.nativeEnum(RoomRegistrationStatus).nullable().optional(),
    after: z.nativeEnum(RoomRegistrationStatus).optional(),
    reason: reasonSchema,
    // True when the operation actually changed state (fresh init,
    // reactivation, cancel). False when the caller re-invoked an
    // operation and the target state was already reached (idempotent
    // no-op).
    transitioned: z.boolean().optional()
  })
  .strict();

export type RoomRegistrationAuditMeta = z.infer<typeof auditMetaSchema>;

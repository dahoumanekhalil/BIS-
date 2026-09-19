"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AccessPointType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import {
  BadgeError,
  revokeBadgeCredential,
  rotateBadgeCredential
} from "@/lib/badge";
import { isAccessMutationNoop } from "./access-mutation-guard";

// ─── Shared shapes / validators ──────────────────────────────────────────
//
// SECURITY MODEL (identical across all four actions):
//   • Actor:   `user` from `requirePermission(perm)`. Session-derived.
//              The action IGNORES any client-supplied actor field.
//   • Target:  a `Participant.id` supplied by the caller AND then verified
//              to resolve to a real Participant row. This defends against
//              a `REGISTRATION_MANAGER` (or any holder of access.manage)
//              being tricked into applying access.* to an AdminUser row
//              that shares the cuid shape.
//   • Audit:   every mutation writes an AuditLog row with actor, target,
//              and a `{before, after}` meta payload. Rate-limited only
//              indirectly through the DB (each write is one row).

// cuid()s are ~25 chars; leave headroom without allowing pathological
// input. The DB is the ultimate arbiter — this is just a first cut.
const idSchema = z.string().trim().min(10).max(64);

// Free-text reason. Attendee-facing UIs never display this field, but it
// ends up in AuditLog and in `BadgeCredential.revokedReason`. Cap length,
// and refuse anything that looks like a credential token — cheap
// defense-in-depth so a copy-paste slip cannot leak a token into the log.
const reasonSchema = z
  .string()
  .trim()
  .max(500, "Motif trop long")
  .refine((s) => !/^[A-Za-z0-9_-]{40,}$/.test(s), {
    message: "Motif invalide"
  })
  .optional()
  .transform((s) => (s && s.length > 0 ? s : null));

// URL path (not filesystem). Route groups `(protected)` are stripped from
// the routed URL; the leading `/app` is never part of the URL space.
// Passing a filesystem-shaped string here silently no-ops the cache
// invalidation, leaving the admin with stale state after a mutation.
const ROOM_ACCESS_SCOPE = "admin/registrants";

// Resolves the target as a Participant row. Throws (which surfaces as a
// server-action rejection) if the id does not resolve — this closes the
// "grant access.manage to an AdminUser id" attack vector explicitly.
async function assertParticipantTarget(participantId: string) {
  const p = await prisma.participant.findUnique({
    where: { id: participantId },
    select: { id: true }
  });
  if (!p) {
    throw new Error("Cible introuvable : aucun participant avec cet identifiant.");
  }
  return p;
}

// Access-point resolution: refuse unknown or inactive points at the action
// layer. The admin UI only offers active points, but a crafted POST could
// try otherwise.
async function assertActiveAccessPoint(accessPointId: string) {
  const ap = await prisma.accessPoint.findUnique({
    where: { id: accessPointId },
    select: { id: true, active: true, type: true, slug: true }
  });
  if (!ap || !ap.active) {
    throw new Error("Point d'accès inconnu ou inactif.");
  }
  return ap;
}

// ─── grantRoomAccessAction ───────────────────────────────────────────────
//
// Idempotent: granting an already-granted row rewrites `grantedBy/At` and
// clears any prior revoke — the audit row records the before/after so a
// reviewer can see "was already granted, re-granted by admin X".
export async function grantRoomAccessAction(
  participantIdRaw: string,
  accessPointIdRaw: string
) {
  const { user } = await requirePermission("access.manage");
  const participantId = idSchema.parse(participantIdRaw);
  const accessPointId = idSchema.parse(accessPointIdRaw);

  await assertParticipantTarget(participantId);
  const ap = await assertActiveAccessPoint(accessPointId);

  const before = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: { participantId, accessPointId }
    },
    select: { granted: true, grantedById: true, grantedAt: true }
  });

  // NOOP guard (Phase 7 audit finding). If access is already granted,
  // return silently — no mutation, no audit row, no revalidation. This
  // keeps AuditLog focused on "exactly one meaningful event per real
  // mutation" and prevents redundant grantedAt rewrites from admin
  // double-clicks or race retries.
  if (isAccessMutationNoop(before, true)) return;

  const now = new Date();
  await prisma.participantAccess.upsert({
    where: {
      participantId_accessPointId: { participantId, accessPointId }
    },
    create: {
      participantId,
      accessPointId,
      granted: true,
      grantedById: user.id,
      grantedAt: now
    },
    update: {
      granted: true,
      grantedById: user.id,
      grantedAt: now,
      revokedAt: null,
      revokedById: null
    }
  });

  await audit({
    userId: user.id,
    action: "access.grant",
    entity: "Participant",
    entityId: participantId,
    meta: {
      accessPointId,
      accessPointSlug: ap.slug,
      accessPointType: ap.type,
      before: before ? { granted: before.granted } : null,
      after: { granted: true }
    }
  });

  revalidatePath(`/${ROOM_ACCESS_SCOPE}/${participantId}`);
}

// ─── revokeRoomAccessAction ──────────────────────────────────────────────
//
// Sets `granted = false` on the existing row (or creates a new row with
// granted=false if none existed — preserves the tri-state "denied" from
// the hardening pass). Does NOT delete the row; the audit trail lives in
// `AuditLog` but the row itself carries `revokedBy/At` for admin visibility.
export async function revokeRoomAccessAction(
  participantIdRaw: string,
  accessPointIdRaw: string
) {
  const { user } = await requirePermission("access.manage");
  const participantId = idSchema.parse(participantIdRaw);
  const accessPointId = idSchema.parse(accessPointIdRaw);

  await assertParticipantTarget(participantId);
  const ap = await assertActiveAccessPoint(accessPointId);

  const before = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: { participantId, accessPointId }
    },
    select: { granted: true }
  });

  // NOOP guard (Phase 7 audit finding). If access is already revoked,
  // return silently — see the mirror comment on grantRoomAccessAction.
  // Note: the `unassigned → revoke` path is deliberately NOT a NOOP —
  // the audit spec asked to preserve the existing behavior of creating
  // an explicit "denied" row, which happens below via upsert.create.
  if (isAccessMutationNoop(before, false)) return;

  const now = new Date();
  await prisma.participantAccess.upsert({
    where: {
      participantId_accessPointId: { participantId, accessPointId }
    },
    create: {
      participantId,
      accessPointId,
      granted: false,
      grantedById: null,
      revokedById: user.id,
      revokedAt: now
    },
    update: {
      granted: false,
      revokedById: user.id,
      revokedAt: now
    }
  });

  await audit({
    userId: user.id,
    action: "access.revoke",
    entity: "Participant",
    entityId: participantId,
    meta: {
      accessPointId,
      accessPointSlug: ap.slug,
      accessPointType: ap.type,
      before: before ? { granted: before.granted } : null,
      after: { granted: false }
    }
  });

  revalidatePath(`/${ROOM_ACCESS_SCOPE}/${participantId}`);
}

// ─── rotateBadgeAsAdminAction ────────────────────────────────────────────
//
// Admin-initiated rotation. Calls the Phase 2 service which does the
// revoke-old + create-new atomically. The rawToken is generated and then
// DISCARDED SERVER-SIDE — it is never returned to the admin, never logged,
// never displayed. The participant will see the new QR when they next
// call their own `generateOrRotateMyBadge` action (which will rotate
// again — that is the expected shape of the current UX).
export async function rotateBadgeAsAdminAction(
  participantIdRaw: string,
  reasonRaw: string
) {
  const { user } = await requirePermission("badge.manage");
  const participantId = idSchema.parse(participantIdRaw);
  const reason = reasonSchema.parse(reasonRaw);
  await assertParticipantTarget(participantId);

  try {
    // Phase 2 service already writes a `badge.rotate` AuditLog row inside
    // its transaction. We deliberately discard the rawToken by not
    // destructuring it out of the result.
    await rotateBadgeCredential(
      participantId,
      user.id,
      reason ?? "admin-rotate"
    );
  } catch (err) {
    if (err instanceof BadgeError) {
      // Surface as an ordinary server-action error string. The UI
      // renders the message; no token or internal state leaks.
      throw new Error(`Rotation refusée : ${err.code}`);
    }
    throw err;
  }

  // Separate audit row so the "admin-initiated" origin is filterable.
  // The service's audit row records the credential IDs; this one records
  // the actor/target/reason context.
  await audit({
    userId: user.id,
    action: "badge.rotate.admin",
    entity: "Participant",
    entityId: participantId,
    meta: { reason: reason ?? null }
  });

  revalidatePath(`/${ROOM_ACCESS_SCOPE}/${participantId}`);
}

// ─── revokeBadgeAsAdminAction ────────────────────────────────────────────
//
// Kills the current ACTIVE credential. If no ACTIVE credential exists,
// this is a NOOP (idempotent) — no error surfaced to the admin. The
// service audit hook writes `badge.revoke`; we add `badge.revoke.admin`
// for actor context, mirroring the rotate pattern.
export async function revokeBadgeAsAdminAction(
  participantIdRaw: string,
  reasonRaw: string
) {
  const { user } = await requirePermission("badge.manage");
  const participantId = idSchema.parse(participantIdRaw);
  const reason = reasonSchema.parse(reasonRaw);
  await assertParticipantTarget(participantId);

  // Look up the ACTIVE credential id ourselves — the Phase 2 service
  // takes a credentialId, not a participantId, for revoke.
  const active = await prisma.badgeCredential.findFirst({
    where: { participantId, status: "ACTIVE" },
    select: { id: true }
  });

  let outcome: "REVOKED" | "NOOP" = "NOOP";
  if (active) {
    try {
      const r = await revokeBadgeCredential(
        active.id,
        user.id,
        reason ?? "admin-revoke"
      );
      outcome = r.status;
    } catch (err) {
      if (err instanceof BadgeError) {
        throw new Error(`Révocation refusée : ${err.code}`);
      }
      throw err;
    }
  }

  // Audit only on a real revoke — a NOOP outcome (no ACTIVE credential
  // existed, or Phase 2 service returned NOOP because it was already
  // revoked) intentionally does not emit a row. This aligns with the
  // Phase 2 `badge.revoke` audit which also skips on NOOP, so the two
  // together produce exactly one meaningful event per real revoke.
  if (outcome === "REVOKED") {
    await audit({
      userId: user.id,
      action: "badge.revoke.admin",
      entity: "Participant",
      entityId: participantId,
      meta: {
        outcome,
        reason: reason ?? null,
        revokedCredentialId: active?.id ?? null
      }
    });
  }

  revalidatePath(`/${ROOM_ACCESS_SCOPE}/${participantId}`);
}

// Type used by the associated Access-point relation on AccessPoint. Exported
// so the panel components can consume it without re-importing from Prisma.
export { AccessPointType };

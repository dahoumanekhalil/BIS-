"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import {
  BadgeError,
  getCurrentBadgeToken,
  regenerateBadgeCredential,
  revokeBadgeCredential
} from "@/lib/badge";
import { renderBadgeQrDataUrl } from "@/lib/badge/qr";
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

// ─── Badge (QR) administration ───────────────────────────────────────────
//
// POLICY: a participant has ONE persistent QR. Subscribers can only view it.
// Only an administrator can replace it, and only through
// `regenerateBadgeAsAdminAction` (permission `badge.regenerate`). Revoking
// is durable: nothing a subscriber does re-creates a credential afterwards.
//
// Raw tokens are rendered straight into a QR image and are never logged,
// audited or returned as strings.

export type BadgeAdminQrResult =
  | {
      ok: true;
      qrDataUrl: string;
      credentialId: string;
      sequence: number;
      issuedAt: string;
    }
  | {
      ok: false;
      code:
        | "NO_ACTIVE"
        | "LEGACY"
        | "EXPIRED"
        | "CONFLICT"
        | "REASON_REQUIRED"
        | "UNAVAILABLE";
      message: string;
    };

const MSG = {
  NO_ACTIVE: "Aucun QR actif pour ce participant.",
  LEGACY:
    "Ce badge date de l'ancien système et ne peut pas être réaffiché. Régénérez le QR.",
  EXPIRED: "Le badge actif a expiré. Régénérez le QR.",
  CONFLICT:
    "Le badge a changé entre-temps (autre administrateur ou requête dupliquée). Rien n'a été modifié : actualisez la page.",
  REASON_REQUIRED: "Un motif de 5 à 500 caractères est obligatoire.",
  UNAVAILABLE:
    "Opération momentanément indisponible. Aucune modification n'a été appliquée.",
  TOO_MANY:
    "Limite horaire atteinte pour votre compte. Réessayez dans une heure."
} as const;

const expectedIdSchema = z.string().trim().min(10).max(64).nullable();

// Per-admin hourly ceiling for QR display. Counted from the audit trail in
// the SAME transaction that writes the new audit row, serialised per admin
// with an advisory lock, so parallel requests cannot all slip under it.
// (Regeneration has the same ceiling inside regenerateBadgeCredential.)
const VIEW_PER_ADMIN_PER_HOUR = 60;

// Read-only: shows the CURRENT QR without rotating anything. Showing a live
// QR lets its viewer impersonate the participant at a scanner, so it needs
// its own sensitive permission (badge.view), not the weaker badge.manage. Each display is audited; if the audit row cannot be written,
// the QR is NOT returned.
export async function viewBadgeQrAsAdminAction(
  participantIdRaw: string
): Promise<BadgeAdminQrResult> {
  const { user } = await requirePermission("badge.view");
  const participantId = idSchema.parse(participantIdRaw);
  await assertParticipantTarget(participantId);

  try {
    // One transaction: lock admin → count → read → audit. Fail closed: no
    // audit row → no QR; over the ceiling → no QR.
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"badge-budget:" + user.id}))`;
      const used = await tx.auditLog.count({
        where: {
          userId: user.id,
          action: "badge.view.admin",
          createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }
        }
      });
      if (used >= VIEW_PER_ADMIN_PER_HOUR) return { limited: true as const };
      const cur = await getCurrentBadgeToken(participantId, tx);
      if (!cur.ok) return { limited: false as const, cur };
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "badge.view.admin",
          entity: "Participant",
          entityId: participantId,
          meta: { credentialId: cur.credentialId }
        }
      });
      return { limited: false as const, cur };
    });
    if (outcome.limited) {
      return { ok: false, code: "UNAVAILABLE", message: MSG.TOO_MANY };
    }
    const current = outcome.cur;
    if (!current.ok) {
      const code =
        current.reason === "LEGACY"
          ? "LEGACY"
          : current.reason === "EXPIRED"
            ? "EXPIRED"
            : "NO_ACTIVE";
      return { ok: false, code, message: MSG[code] };
    }
    const qrDataUrl = await renderBadgeQrDataUrl(current.rawToken);
    return {
      ok: true,
      qrDataUrl,
      credentialId: current.credentialId,
      sequence: current.sequence,
      issuedAt: current.issuedAt.toISOString()
    };
  } catch {
    return { ok: false, code: "UNAVAILABLE", message: MSG.UNAVAILABLE };
  }
}

// ADMIN-ONLY replacement. Atomic: revoke current ACTIVE + create the next
// persistent ACTIVE (same Participant) + rotate the printed text code +
// audit row, all in one transaction (see regenerateBadgeCredential).
// `expectedCredentialId` is the credential the admin was looking at; if it
// is no longer current (another admin, duplicate click, retry) nothing is
// changed and a deterministic CONFLICT result is returned.
export async function regenerateBadgeAsAdminAction(
  participantIdRaw: string,
  reasonRaw: string,
  expectedCredentialIdRaw: string | null
): Promise<BadgeAdminQrResult> {
  const { user } = await requirePermission("badge.regenerate");
  const participantId = idSchema.parse(participantIdRaw);
  const expectedCredentialId = expectedIdSchema.parse(expectedCredentialIdRaw);
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason.length < 5 || reason.length > 500) {
    return { ok: false, code: "REASON_REQUIRED", message: MSG.REASON_REQUIRED };
  }
  if (/^[A-Za-z0-9_-]{40,}$/.test(reason)) {
    return { ok: false, code: "REASON_REQUIRED", message: MSG.REASON_REQUIRED };
  }
  await assertParticipantTarget(participantId);

  let result;
  try {
    result = await regenerateBadgeCredential({
      participantId,
      adminId: user.id,
      reason,
      expectedCredentialId
    });
  } catch (err) {
    if (err instanceof BadgeError) {
      if (err.code === "CONFLICT") {
        return { ok: false, code: "CONFLICT", message: MSG.CONFLICT };
      }
      if (err.code === "RATE_LIMITED") {
        return { ok: false, code: "UNAVAILABLE", message: MSG.TOO_MANY };
      }
      if (err.code === "REASON_REQUIRED") {
        return {
          ok: false,
          code: "REASON_REQUIRED",
          message: MSG.REASON_REQUIRED
        };
      }
    }
    // Never leak internals (secret config, SQL) to the browser.
    // eslint-disable-next-line no-console
    console.error(
      "[badge.regenerate] failed:",
      err instanceof BadgeError ? err.code : "unexpected"
    );
    return { ok: false, code: "UNAVAILABLE", message: MSG.UNAVAILABLE };
  }

  revalidatePath(`/${ROOM_ACCESS_SCOPE}/${participantId}`);

  // The credential is already committed. If rendering fails the admin can
  // simply use "view" — the QR is deterministic.
  try {
    const qrDataUrl = await renderBadgeQrDataUrl(result.rawToken);
    return {
      ok: true,
      qrDataUrl,
      credentialId: result.credentialId,
      sequence: result.sequence,
      issuedAt: new Date().toISOString()
    };
  } catch {
    return { ok: false, code: "UNAVAILABLE", message: MSG.UNAVAILABLE };
  }
}

// Durable revoke: the current ACTIVE credential becomes REVOKED. The
// subscriber cannot re-create one (no subscriber path writes credentials,
// and first issuance refuses when history exists). A replacement can only be
// created by an administrator via regenerateBadgeAsAdminAction.
// NOTE: this revokes the QR credential only. The printed text check-in code
// is blocked at the text validator while the latest credential is REVOKED;
// the legacy manual ticket-code / id check-in is an independent operator
// workflow and is NOT affected.
export async function revokeBadgeAsAdminAction(
  participantIdRaw: string,
  reasonRaw: string,
  expectedCredentialIdRaw: string | null
): Promise<
  | { ok: true }
  | { ok: false; code: "CONFLICT" | "NO_ACTIVE" | "UNAVAILABLE"; message: string }
> {
  const { user } = await requirePermission("badge.manage");
  const participantId = idSchema.parse(participantIdRaw);
  const expectedCredentialId = expectedIdSchema.parse(expectedCredentialIdRaw);
  const reason = reasonSchema.parse(reasonRaw);
  await assertParticipantTarget(participantId);

  const active = await prisma.badgeCredential.findFirst({
    where: { participantId, status: "ACTIVE" },
    select: { id: true }
  });
  if (!active) {
    return { ok: false, code: "NO_ACTIVE", message: MSG.NO_ACTIVE };
  }
  // Compare-and-swap with what the admin saw: if another admin regenerated
  // meanwhile, do NOT silently report success on a credential that has
  // already been replaced.
  if (active.id !== expectedCredentialId) {
    return { ok: false, code: "CONFLICT", message: MSG.CONFLICT };
  }

  try {
    // The service locks the participant and writes the audit row in the
    // same transaction. NOOP = already revoked/replaced by someone else.
    const r = await revokeBadgeCredential(
      active.id,
      user.id,
      reason ?? "admin-revoke"
    );
    if (r.status === "NOOP") {
      return { ok: false, code: "CONFLICT", message: MSG.CONFLICT };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[badge.revoke] failed:",
      err instanceof BadgeError ? err.code : "unexpected"
    );
    return { ok: false, code: "UNAVAILABLE", message: MSG.UNAVAILABLE };
  }

  revalidatePath(`/${ROOM_ACCESS_SCOPE}/${participantId}`);
  return { ok: true };
}


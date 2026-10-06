"use server";

import { revalidatePath } from "next/cache";
import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import {
  BADGE_REGENERATE_FORBIDDEN_ROLES,
  canWithOverrides
} from "@/lib/admin/rbac";

// Which admin ROLES may regenerate (and view) a participant's QR
// (permission `badge.regenerate`). Stored as RolePermissionOverride rows —
// the same mechanism canWithOverrides() already reads, so the change takes
// effect immediately and everywhere (server actions included).
//
// AUTHORIZATION: `roles.manage` (SUPER_ADMIN baseline). Rules:
//   • SUPER_ADMIN always keeps the permission (not editable here).
//   • You cannot edit your own role's access (same rule as the role editor).
//   • You cannot grant a permission you do not hold yourself.
//   • The change and its audit row are written in ONE transaction.

const PERM = "badge.regenerate";

export type BadgeRolesResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export async function setBadgeRegenerateRolesAction(
  selectedRaw: unknown
): Promise<BadgeRolesResult> {
  const { user } = await requirePermission("roles.manage");

  if (!Array.isArray(selectedRaw) || selectedRaw.length > 20) {
    return { ok: false, message: "Requête invalide." };
  }
  const valid = new Set<string>(Object.values(AdminRole));
  const selected = new Set<AdminRole>();
  for (const r of selectedRaw) {
    if (typeof r !== "string" || !valid.has(r)) {
      return { ok: false, message: "Rôle invalide." };
    }
    selected.add(r as AdminRole);
  }

  for (const r of BADGE_REGENERATE_FORBIDDEN_ROLES) {
    if (selected.has(r)) {
      return {
        ok: false,
        message:
          "Ce rôle ne peut pas recevoir cette permission pour des raisons de sécurité."
      };
    }
  }

  const editable = Object.values(AdminRole).filter(
    (r) => r !== AdminRole.SUPER_ADMIN && r !== user.role
  );

  try {
    const changes = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction (fresh read): you cannot grant a
      // permission you do not hold yourself.
      if (selected.size > 0) {
        const own = await tx.rolePermissionOverride.findUnique({
          where: { role_permission: { role: user.role, permission: PERM } },
          select: { granted: true }
        });
        const holds = own ? own.granted : await canWithOverrides(user.role, PERM);
        if (!holds) throw new Error("NOT_HELD");
      }
      const before = await tx.rolePermissionOverride.findMany({
        where: { permission: PERM },
        select: { role: true, granted: true }
      });
      const beforeMap = new Map(before.map((b) => [b.role, b.granted]));
      const applied: Array<{ role: AdminRole; granted: boolean }> = [];

      for (const role of editable) {
        const granted = selected.has(role);
        // Effective state before: an explicit override wins, otherwise the
        // baseline. Only write when the explicit state actually changes.
        const current = beforeMap.has(role)
          ? beforeMap.get(role)
          : (await canWithOverrides(role, PERM));
        if (current === granted) continue;
        await tx.rolePermissionOverride.upsert({
          where: { role_permission: { role, permission: PERM } },
          create: { role, permission: PERM, granted, updatedBy: user.id },
          update: { granted, updatedBy: user.id }
        });
        applied.push({ role, granted });
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "BADGE_REGENERATE_ROLES_UPDATED",
          entity: "RolePermissionOverride",
          entityId: PERM,
          meta: { permission: PERM, changes: applied }
        }
      });
      return applied.length;
    });

    revalidatePath("/admin/settings/badges");
    return {
      ok: true,
      message:
        changes === 0
          ? "Aucune modification."
          : `${changes} rôle${changes > 1 ? "s" : ""} mis à jour.`
    };
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_HELD") {
      return {
        ok: false,
        message: "Vous ne pouvez pas accorder une permission que vous n'avez pas."
      };
    }
    return { ok: false, message: "Erreur lors de l'enregistrement." };
  }
}

"use server";

import { z } from "zod";
import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { getCurrentAdmin } from "@/lib/admin/auth";
import {
  PERMISSIONS,
  SUPER_ADMIN_ONLY_PERMISSIONS,
  can,
  canWithOverrides,
  isForbiddenGrant,
  type Permission
} from "@/lib/admin/rbac";
import { ROLE_CATALOG } from "@/lib/admin/role-catalog";
import { revalidatePath } from "next/cache";

export type UpdatePermissionsState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

// A refusal that must abort the transaction and be shown to the admin.
class RoleEditRefusal extends Error {}

// Strict payload: { "<permission>": boolean }. No non-boolean values, no
// oversized objects, keys must be real permissions (checked below).
const payloadSchema = z
  .record(z.string().min(1).max(64), z.boolean())
  .refine((o) => Object.keys(o).length <= PERMISSIONS.length, {
    message: "Requête invalide."
  });

export async function updateRolePermissions(
  roleKey: string,
  permissionsRaw: unknown
): Promise<UpdatePermissionsState> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return { status: "error", message: "Non authentifié." };
  }

  const canManageRoles = await canWithOverrides(admin.user.role, "roles.manage");
  if (!canManageRoles) {
    return {
      status: "error",
      message: "Permission requise : roles.manage."
    };
  }

  const parsed = payloadSchema.safeParse(permissionsRaw);
  if (!parsed.success) {
    return { status: "error", message: "Requête invalide." };
  }
  const permissions = parsed.data;

  // The editor sends the CATALOG key ("sales", "admin", …) — not the enum
  // value ("SALES"). Resolve it server-side against the catalog (staff only);
  // the enum value is also accepted. Anything else is refused.
  const catalogEntry = ROLE_CATALOG.find(
    (r): r is Extract<typeof r, { kind: "staff" }> =>
      r.kind === "staff" &&
      (r.key === roleKey || r.adminRole === (roleKey as AdminRole))
  );
  if (!catalogEntry || typeof roleKey !== "string" || roleKey.length > 64) {
    return { status: "error", message: "Rôle invalide." };
  }
  const role = catalogEntry.adminRole;

  // Only SUPER_ADMIN may edit SUPER_ADMIN permissions
  if (role === AdminRole.SUPER_ADMIN && admin.user.role !== AdminRole.SUPER_ADMIN) {
    return {
      status: "error",
      message: "Seul un super admin peut modifier les permissions super admin."
    };
  }

  if (role === admin.user.role) {
    return {
      status: "error",
      message: "Vous ne pouvez pas modifier les permissions de votre propre rôle."
    };
  }

  // Unknown permission keys are refused (never silently ignored).
  const entries = Object.entries(permissions);
  for (const [perm] of entries) {
    if (!PERMISSIONS.includes(perm as Permission)) {
      return { status: "error", message: "Permission inconnue." };
    }
  }
  if (entries.length === 0) {
    return { status: "success", message: "Aucune modification." };
  }

  const callerRole = admin.user.role;
  const callerIsSuper = callerRole === AdminRole.SUPER_ADMIN;

  // Hierarchy: a delegated roles.manage holder (not SUPER_ADMIN) may not
  // edit ADMIN — it sits above them and holds audit / backup / badge powers.
  if (!callerIsSuper && role === AdminRole.ADMIN) {
    return {
      status: "error",
      message: "Seul un super admin peut modifier le rôle Admin."
    };
  }

  try {
    const applied = await prisma.$transaction(
      async (tx) => {
      // Serialise ALL role edits (cheap: rare admin action): no concurrent
      // edit can interleave, so `before` in the audit row is exact and the
      // authority re-checks below cannot go stale mid-flight.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('role-permission-edit'))`;

      // Does the CALLER hold `perm` right now? (fresh, in-transaction read)
      const callerHolds = async (perm: string): Promise<boolean> => {
        const p = perm as Permission;
        const own = await tx.rolePermissionOverride.findUnique({
          where: { role_permission: { role: callerRole, permission: perm } },
          select: { granted: true }
        });
        return own
          ? own.granted && !isForbiddenGrant(callerRole, p)
          : can(callerRole, p);
      };
      // roles.manage must still be held at commit time.
      if (!(await callerHolds("roles.manage"))) {
        throw new RoleEditRefusal("Permission requise : roles.manage.");
      }

      const changes: Array<{
        permission: string;
        before: boolean;
        after: boolean;
      }> = [];

      for (const [perm, granted] of entries) {
        const p = perm as Permission;

        // The most sensitive verbs (role / user management, destructive
        // backup verbs) are SUPER_ADMIN-only to change: this prevents a
        // delegated roles.manage holder from creating a delegation chain.
        if (SUPER_ADMIN_ONLY_PERMISSIONS.includes(p) && !callerIsSuper) {
          throw new RoleEditRefusal(
            `Seul un super admin peut modifier « ${perm} ».`
          );
        }

        // Hard security exclusion (operational / read-only roles).
        if (granted && isForbiddenGrant(role, p)) {
          throw new RoleEditRefusal(
            "Ce rôle ne peut pas recevoir cette permission pour des raisons de sécurité."
          );
        }

        // Authority: a non-SUPER_ADMIN may only change permissions they
        // hold themselves — grants AND revocations (no sabotage by stripping
        // powers they never had).
        if (!callerIsSuper && !(await callerHolds(perm))) {
          throw new RoleEditRefusal(
            `Permission refusée : vous ne détenez pas "${perm}".`
          );
        }

        const existing = await tx.rolePermissionOverride.findUnique({
          where: { role_permission: { role, permission: perm } },
          select: { granted: true }
        });
        const before = existing ? existing.granted : can(role, p);
        if (before === granted) continue; // no-op: no write, no audit noise

        await tx.rolePermissionOverride.upsert({
          where: { role_permission: { role, permission: perm } },
          create: { role, permission: perm, granted, updatedBy: admin.user.id },
          update: { granted, updatedBy: admin.user.id }
        });
        changes.push({ permission: perm, before, after: granted });
      }

      if (changes.length === 0) return changes;

      // Permission changes and their audit row commit (or fail) together.
      await tx.auditLog.create({
        data: {
          userId: admin.user.id,
          action: "ROLE_PERMISSIONS_UPDATED",
          entity: "RolePermissionOverride",
          entityId: role,
          meta: { role, changedCount: changes.length, changes }
        }
      });
      return changes;
      },
      { timeout: 15000 }
    );

    revalidatePath(`/admin/roles/${catalogEntry.key}`);
    revalidatePath("/admin/roles");
    revalidatePath("/admin/settings/badges");

    if (applied.length === 0) {
      return { status: "success", message: "Aucune modification." };
    }
    return {
      status: "success",
      message: `${applied.length} permission${applied.length > 1 ? "s" : ""} mise${applied.length > 1 ? "s" : ""} à jour.`
    };
  } catch (err) {
    if (err instanceof RoleEditRefusal) {
      // Security signal: someone tried to exceed their authority.
      await audit({
        userId: admin.user.id,
        action: "ROLE_PERMISSIONS_DENIED",
        entity: "RolePermissionOverride",
        entityId: role,
        meta: { role, reason: err.message }
      });
      return { status: "error", message: err.message };
    }
    return {
      status: "error",
      message: "Erreur lors de la sauvegarde des permissions."
    };
  }
}

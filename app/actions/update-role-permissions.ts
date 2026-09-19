"use server";

import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentAdmin } from "@/lib/admin/auth";
import { PERMISSIONS, canWithOverrides, getEffectivePermissions, type Permission } from "@/lib/admin/rbac";
import { ROLE_CATALOG } from "@/lib/admin/role-catalog";
import { revalidatePath } from "next/cache";

export type UpdatePermissionsState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function updateRolePermissions(
  roleKey: string,
  permissions: Record<string, boolean>
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

  const validRoles = Object.values(AdminRole);
  if (!validRoles.includes(roleKey as AdminRole)) {
    return { status: "error", message: "Rôle invalide." };
  }

  const role = roleKey as AdminRole;

  // Only SUPER_ADMIN may edit SUPER_ADMIN permissions
  if (role === AdminRole.SUPER_ADMIN && admin.user.role !== AdminRole.SUPER_ADMIN) {
    return {
      status: "error",
      message: "Seul un super admin peut modifier les permissions super admin."
    };
  }

  // Prevent granting permissions the caller does not possess
  const callerPerms = new Set(await getEffectivePermissions(admin.user.role));

  const catalogEntry = ROLE_CATALOG.find(
    (r): r is Extract<typeof r, { kind: "staff" }> =>
      r.kind === "staff" && r.adminRole === role
  );
  if (!catalogEntry) {
    return {
      status: "error",
      message: "Seuls les rôles staff peuvent être modifiés."
    };
  }

  if (role === admin.user.role) {
    return {
      status: "error",
      message: "Vous ne pouvez pas modifier les permissions de votre propre rôle."
    };
  }

  const ops: Array<{
    where: { role_permission: { role: AdminRole; permission: string } };
    create: { role: AdminRole; permission: string; granted: boolean; updatedBy: string };
    update: { granted: boolean; updatedBy: string };
  }> = [];

  for (const [perm, granted] of Object.entries(permissions)) {
    if (!PERMISSIONS.includes(perm as Permission)) continue;
    // Prevent granting permissions the caller does not possess
    if (granted && !callerPerms.has(perm as Permission)) {
      return {
        status: "error",
        message: `Permission refusée : vous ne pouvez pas accorder "${perm}".`
      };
    }
    ops.push({
      where: { role_permission: { role, permission: perm } },
      create: { role, permission: perm, granted, updatedBy: admin.user.id },
      update: { granted, updatedBy: admin.user.id }
    });
  }

  if (ops.length === 0) {
    return { status: "success", message: "Aucune modification." };
  }

  try {
    await prisma.$transaction(
      ops.map((op) => prisma.rolePermissionOverride.upsert(op))
    );

    await prisma.auditLog.create({
      data: {
        userId: admin.user.id,
        action: "ROLE_PERMISSIONS_UPDATED",
        entity: "RolePermissionOverride",
        entityId: role,
        meta: {
          role,
          changedCount: ops.length,
          changes: ops.map((op) => ({
            permission: op.where.role_permission.permission,
            granted: op.create.granted
          }))
        }
      }
    });
  } catch {
    return {
      status: "error",
      message: "Erreur lors de la sauvegarde des permissions."
    };
  }

  revalidatePath(`/admin/roles/${roleKey}`);
  return {
    status: "success",
    message: `${ops.length} permission${ops.length > 1 ? "s" : ""} mise${ops.length > 1 ? "s" : ""} à jour.`
  };
}
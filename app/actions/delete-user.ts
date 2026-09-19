"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";

export type DeleteUserResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function deleteUser(userId: string): Promise<DeleteUserResult> {
  const admin = await requirePermission("users.manage");

  if (!userId) {
    return { status: "error", message: "ID utilisateur manquant." };
  }

  // Prevent self-deletion
  if (userId === admin.user.id) {
    return { status: "error", message: "Vous ne pouvez pas supprimer votre propre compte." };
  }

  const existing = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true },
  });

  if (!existing) {
    return { status: "error", message: "Utilisateur introuvable." };
  }

  // Delete associated sessions first to avoid cascade issues
  await prisma.adminSession.deleteMany({ where: { userId } });

  await prisma.adminUser.delete({ where: { id: userId } });

  await audit({
    userId: admin.user.id,
    action: "user.delete",
    entity: "AdminUser",
    entityId: existing.id,
    meta: { name: existing.name, email: existing.email, role: existing.role },
  });

  revalidatePath("/admin/(protected)/users");
  return { status: "success", message: `Compte de ${existing.name} supprimé.` };
}
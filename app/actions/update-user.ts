"use server";

import { revalidatePath } from "next/cache";
import { AdminRole, AdminStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { hashPassword } from "@/lib/admin/password";
import { audit } from "@/lib/admin/audit";

export type UpdateUserResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function updateUser(formData: FormData): Promise<UpdateUserResult> {
  const admin = await requirePermission("users.manage");

  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "") as AdminRole;
  const status = String(formData.get("status") ?? "") as AdminStatus;

  if (!id || !name || !email || !role || !status) {
    return { status: "error", message: "Tous les champs obligatoires doivent être remplis." };
  }

  const validRoles = Object.values(AdminRole);
  if (!validRoles.includes(role)) {
    return { status: "error", message: "Rôle invalide." };
  }

  const validStatuses = Object.values(AdminStatus);
  if (!validStatuses.includes(status)) {
    return { status: "error", message: "Statut invalide." };
  }

  // Prevent self-deactivation or self-role-change
  if (id === admin.user.id) {
    if (status !== admin.user.status) {
      return { status: "error", message: "Vous ne pouvez pas modifier votre propre statut." };
    }
    if (role !== admin.user.role) {
      return { status: "error", message: "Vous ne pouvez pas modifier votre propre rôle." };
    }
  }

  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing) {
    return { status: "error", message: "Utilisateur introuvable." };
  }

  // Check email uniqueness if changed
  if (email !== existing.email) {
    const emailTaken = await prisma.adminUser.findUnique({ where: { email } });
    if (emailTaken) {
      return { status: "error", message: "Un compte avec cet email existe déjà." };
    }
  }

  const updateData: Record<string, unknown> = { name, email, role, status };

  if (password.length > 0) {
    if (password.length < 6) {
      return { status: "error", message: "Le mot de passe doit contenir au moins 6 caractères." };
    }
    updateData.passwordHash = hashPassword(password);
  }

  await prisma.adminUser.update({ where: { id }, data: updateData });

  await audit({
    userId: admin.user.id,
    action: "user.update",
    entity: "AdminUser",
    entityId: id,
    meta: { name, email, role, status, passwordChanged: password.length > 0 },
  });

  revalidatePath("/admin/(protected)/users");
  return { status: "success", message: "Compte mis à jour." };
}
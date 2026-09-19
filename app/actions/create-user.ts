"use server";

import { revalidatePath } from "next/cache";
import { AdminRole, AdminStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { hashPassword } from "@/lib/admin/password";
import { audit } from "@/lib/admin/audit";

export type CreateUserResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function createUser(formData: FormData): Promise<CreateUserResult> {
  const admin = await requirePermission("users.manage");

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "") as AdminRole;

  if (!name || !email || !password || !role) {
    return { status: "error", message: "Tous les champs sont requis." };
  }

  if (password.length < 6) {
    return { status: "error", message: "Le mot de passe doit contenir au moins 6 caractères." };
  }

  const validRoles = Object.values(AdminRole);
  if (!validRoles.includes(role)) {
    return { status: "error", message: "Rôle invalide." };
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    return { status: "error", message: "Un compte avec cet email existe déjà." };
  }

  const passwordHash = hashPassword(password);

  const user = await prisma.adminUser.create({
    data: {
      name,
      email,
      passwordHash,
      role,
      status: AdminStatus.ACTIVE,
    },
    select: { id: true, name: true, email: true, role: true },
  });

  await audit({
    userId: admin.user.id,
    action: "user.create",
    entity: "AdminUser",
    entityId: user.id,
    meta: { name: user.name, email: user.email, role: user.role },
  });

  revalidatePath("/admin/(protected)/users");
  return { status: "success", message: `Compte créé pour ${user.name}.` };
}
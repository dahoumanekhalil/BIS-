"use server";

import { redirect } from "next/navigation";
import { AdminRole, AdminStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/admin/password";
import { createSession, setSessionCookie } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";

export type RegisterState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function adminRegister(
  _prev: RegisterState,
  formData: FormData
): Promise<RegisterState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const passwordConfirm = String(formData.get("passwordConfirm") ?? "");

  if (!name || !email || !password || !passwordConfirm) {
    return { status: "error", message: "Tous les champs sont requis." };
  }

  if (password.length < 6) {
    return {
      status: "error",
      message: "Le mot de passe doit contenir au moins 6 caractères."
    };
  }

  if (password !== passwordConfirm) {
    return {
      status: "error",
      message: "Les mots de passe ne correspondent pas."
    };
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: "error", message: "Adresse email invalide." };
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    return {
      status: "error",
      message: "Un compte avec cet email existe déjà."
    };
  }

  const passwordHash = hashPassword(password);

  const user = await prisma.adminUser.create({
    data: {
      name,
      email,
      passwordHash,
      role: AdminRole.VIEWER,
      status: AdminStatus.ACTIVE
    },
    select: { id: true, name: true, email: true, role: true }
  });

  await audit({
    userId: user.id,
    action: "auth.register",
    entity: "AdminUser",
    entityId: user.id,
    meta: { name: user.name, email: user.email, role: user.role }
  });

  // Auto-login after registration
  const token = await createSession(user.id);
  await setSessionCookie(token);

  await prisma.adminUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() }
  });

  redirect("/admin/dashboard");
}
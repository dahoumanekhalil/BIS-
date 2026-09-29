"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import {
  readSessionToken,
  requireAdmin,
  revokeOtherAdminSessions
} from "@/lib/admin/auth";
import { hashPassword, verifyPassword } from "@/lib/admin/password";
import { audit } from "@/lib/admin/audit";

// Self-service admin account settings. Authorization here is deliberately
// `requireAdmin()` and NOT `requirePermission(...)`: every authenticated
// admin can manage their OWN account regardless of role — but a caller can
// only ever mutate their own row. Nothing in this file accepts a target
// user id; both actions read `admin.user.id` from the session.
//
// Never touches `role`, `status`, or any relation. Those remain gated by
// `users.manage` in app/actions/update-user.ts.
//
// Never returns `passwordHash` or any other sensitive field to the client.

export type AccountActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

const IDLE: AccountActionState = { status: "idle" };
const MIN_PASSWORD_LEN = 6; // matches lib/admin/password + existing user-management actions

const profileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Le nom est requis.")
    .max(120, "Le nom est trop long."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Adresse email invalide.")
    .max(254, "Adresse email trop longue.")
});

const passwordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, "Mot de passe actuel requis."),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LEN, `Le nouveau mot de passe doit contenir au moins ${MIN_PASSWORD_LEN} caractères.`)
      .max(200, "Mot de passe trop long."),
    confirmPassword: z.string()
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "La confirmation ne correspond pas au nouveau mot de passe."
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ["newPassword"],
    message: "Le nouveau mot de passe doit être différent de l’ancien."
  });

function fieldErrorsOf(
  err: z.ZodError
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.map(String).join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export async function updateProfileAction(
  _prev: AccountActionState,
  formData: FormData
): Promise<AccountActionState> {
  const admin = await requireAdmin();

  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email")
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Vérifiez les informations saisies.",
      fieldErrors: fieldErrorsOf(parsed.error)
    };
  }

  const { name, email } = parsed.data;

  // Uniqueness check only if the email is actually changing — a self-update
  // that keeps the same email must not report "already in use".
  if (email !== admin.user.email) {
    const taken = await prisma.adminUser.findUnique({
      where: { email },
      select: { id: true }
    });
    if (taken && taken.id !== admin.user.id) {
      return {
        status: "error",
        message: "Cette adresse email est déjà utilisée par un autre compte.",
        fieldErrors: { email: "Adresse email déjà utilisée." }
      };
    }
  }

  const noChanges =
    name === admin.user.name && email === admin.user.email;
  if (noChanges) {
    return { status: "success", message: "Aucune modification à enregistrer." };
  }

  try {
    await prisma.adminUser.update({
      where: { id: admin.user.id },
      data: { name, email }
    });
  } catch (err) {
    // Unique-index race — another admin took the address between our check
    // and our update.
    if ((err as { code?: string }).code === "P2002") {
      return {
        status: "error",
        message: "Cette adresse email est déjà utilisée par un autre compte.",
        fieldErrors: { email: "Adresse email déjà utilisée." }
      };
    }
    // Any other DB failure: log server-side, surface a generic message to
    // the browser. Never rethrow a raw Prisma error into the client stream.
    // eslint-disable-next-line no-console
    console.warn(
      "[account.profile.update] unexpected DB error",
      err instanceof Error ? err.name : "unknown"
    );
    return { status: "error", message: "Erreur inattendue. Veuillez réessayer." };
  }

  await audit({
    userId: admin.user.id,
    action: "account.profile.update",
    entity: "AdminUser",
    entityId: admin.user.id,
    meta: {
      emailChanged: email !== admin.user.email,
      nameChanged: name !== admin.user.name
    }
  });

  revalidatePath("/admin/settings/account");
  return { status: "success", message: "Profil mis à jour." };
}

export async function changePasswordAction(
  _prev: AccountActionState,
  formData: FormData
): Promise<AccountActionState> {
  const admin = await requireAdmin();

  const parsed = passwordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword")
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Vérifiez les informations saisies.",
      fieldErrors: fieldErrorsOf(parsed.error)
    };
  }

  const { currentPassword, newPassword } = parsed.data;

  // Re-fetch the hash rather than trusting the session-attached user
  // (session objects can be stale; hash rotation elsewhere shouldn't
  // race this action).
  const row = await prisma.adminUser.findUnique({
    where: { id: admin.user.id },
    select: { passwordHash: true }
  });
  if (!row) {
    // Session referenced a deleted admin — treat as unauthenticated.
    return {
      status: "error",
      message: "Session invalide. Reconnectez-vous."
    };
  }
  if (!verifyPassword(currentPassword, row.passwordHash)) {
    // Do NOT reveal via field-level error whether the account exists.
    // Log the failure so brute-force attempts are auditable.
    await audit({
      userId: admin.user.id,
      action: "account.password.change.failed",
      entity: "AdminUser",
      entityId: admin.user.id,
      meta: { reason: "invalid_current_password" }
    });
    return {
      status: "error",
      message: "Mot de passe actuel incorrect.",
      fieldErrors: { currentPassword: "Mot de passe actuel incorrect." }
    };
  }

  await prisma.adminUser.update({
    where: { id: admin.user.id },
    data: { passwordHash: hashPassword(newPassword) }
  });

  // Revoke every OTHER active session for this admin — if their cookie was
  // stolen or they left a shared workstation logged in, changing the
  // password must lock those sessions out. Keeps THIS request's session
  // alive so the actor's own tab stays authenticated.
  const currentToken = await readSessionToken();
  const revoked = await revokeOtherAdminSessions(admin.user.id, currentToken);

  await audit({
    userId: admin.user.id,
    action: "account.password.change",
    entity: "AdminUser",
    entityId: admin.user.id,
    // Session-count is not sensitive; the raw tokens never leave auth.ts.
    meta: { otherSessionsRevoked: revoked }
  });

  revalidatePath("/admin/settings/account");
  return { status: "success", message: "Mot de passe mis à jour." };
}

// Exported so the client form can type-check against the initial state.
export { IDLE };

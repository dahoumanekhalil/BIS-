"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  createSession,
  setSessionCookie,
  readSessionToken,
  clearSessionCookie,
  invalidateSession
} from "@/lib/admin/auth";
import { verifyPassword } from "@/lib/admin/password";
import { audit } from "@/lib/admin/audit";
import { AdminStatus } from "@prisma/client";

export type SpeakerLoginState =
  | { status: "idle" }
  | { status: "error"; message: string };

const GENERIC_ERROR = {
  status: "error" as const,
  message: "Identifiants invalides."
};

export async function speakerLogin(
  _prev: SpeakerLoginState,
  formData: FormData
): Promise<SpeakerLoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { status: "error", message: "Email et mot de passe requis." };
  }

  // Find admin user by email
  const user = await prisma.adminUser.findUnique({ where: { email } });
  if (!user) return GENERIC_ERROR;
  if (user.status !== AdminStatus.ACTIVE) return GENERIC_ERROR;
  if (!verifyPassword(password, user.passwordHash)) return GENERIC_ERROR;

  // Check if this user is linked to a speaker
  const speaker = await prisma.speaker.findFirst({
    where: { adminUserId: user.id },
    select: { id: true }
  });

  if (!speaker) {
    return {
      status: "error",
      message: "Ce compte n'est pas associé à un intervenant."
    };
  }

  const token = await createSession(user.id);
  await setSessionCookie(token);
  await prisma.adminUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() }
  });
  await audit({
    userId: user.id,
    action: "speaker.login",
    entity: "Speaker",
    entityId: speaker.id
  });

  redirect("/speaker/dashboard");
}

export async function speakerLogout() {
  const token = await readSessionToken();
  if (token) {
    // Phase 15 — `invalidateSession` hashes the raw cookie token
    // internally and returns the userId of the deleted session so we
    // can audit the speaker.logout event after the row is dropped.
    const session = await invalidateSession(token);
    if (session) {
      await audit({
        userId: session.userId,
        action: "speaker.logout",
        entity: "AdminUser",
        entityId: session.userId
      });
    }
  }
  await clearSessionCookie();
  redirect("/speaker/login");
}
"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/admin/password";
import {
  createAccountSession,
  setAccountCookie,
  destroyAccountSession
} from "@/lib/account/auth";
import { endOnboardingSession } from "@/lib/onboarding";
import { accountLoginSchema, accountRegisterSchema } from "@/lib/validations";
import {
  DUMMY_HASH,
  THROTTLED_MESSAGE,
  isBlocked,
  record,
  reset
} from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

export type AccountActionResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

const LOGIN_FAILS_PER_EMAIL = 8;
const LOGIN_FAILS_PER_IP = 20;
const REGISTRATIONS_PER_IP = 5;
const REGISTER_ATTEMPTS_PER_IP = 30;
const REGISTER_ATTEMPTS_PER_EMAIL = 20;

const THROTTLED = {
  ok: false as const,
  message: THROTTLED_MESSAGE
};

function fieldErrorsOf(error: { issues: { path: (string | number)[]; message: string }[] }) {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path.join(".")] = issue.message;
  return out;
}

export async function registerAccount(
  input: unknown
): Promise<AccountActionResult> {
  const parsed = accountRegisterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: fieldErrorsOf(parsed.error)
    };
  }

  const { firstName, lastName, email, password } = parsed.data;

  const ip = await clientIp();
  const ipKey = ip ? `register:ip:${ip}` : null;
  const emailKey = `register:email:${email}`;
  // Counted on every call, unlike ipKey which only counts accounts actually
  // created. Falls back to one shared bucket when no proxy header is present so
  // a missing x-real-ip degrades to a generous global cap, not to no cap.
  const attemptKey = `register:attempt:${ip ?? "shared"}`;
  if (
    isBlocked(ipKey, REGISTRATIONS_PER_IP) ||
    isBlocked(attemptKey, REGISTER_ATTEMPTS_PER_IP) ||
    isBlocked(emailKey, REGISTER_ATTEMPTS_PER_EMAIL)
  ) {
    return THROTTLED;
  }
  record(attemptKey);
  record(emailKey);

  const duplicate = {
    ok: false as const,
    message: "Un compte existe déjà avec cette adresse email.",
    fieldErrors: { email: "Adresse email déjà utilisée" }
  };

  const existing = await prisma.accountUser.findUnique({
    where: { email },
    select: { id: true }
  });
  if (existing) return duplicate;

  let user: { id: string };
  try {
    user = await prisma.accountUser.create({
      data: { firstName, lastName, email, passwordHash: hashPassword(password) },
      select: { id: true }
    });
  } catch (error) {
    // Concurrent signup with the same email won the unique-index race.
    if ((error as { code?: string }).code === "P2002") return duplicate;
    throw error;
  }

  record(ipKey);
  const token = await createAccountSession(user.id, true);
  await setAccountCookie(token, true);
  return { ok: true };
}

export async function loginAccount(
  input: unknown
): Promise<AccountActionResult> {
  const parsed = accountLoginSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: fieldErrorsOf(parsed.error)
    };
  }

  const { email, password, remember } = parsed.data;

  const ip = await clientIp();
  const ipKey = ip ? `login:ip:${ip}` : null;
  const emailKey = `login:email:${email}`;
  if (
    isBlocked(ipKey, LOGIN_FAILS_PER_IP) ||
    isBlocked(emailKey, LOGIN_FAILS_PER_EMAIL)
  ) {
    return THROTTLED;
  }

  // Only failures count, so a busy office behind one NAT egress IP cannot
  // lock itself out by logging in successfully.
  const rejected = () => {
    record(ipKey);
    record(emailKey);
    return { ok: false as const, message: "Email ou mot de passe incorrect." };
  };

  const user = await prisma.accountUser.findUnique({
    where: { email },
    select: { id: true, passwordHash: true }
  });

  if (!user) {
    verifyPassword(password, DUMMY_HASH);
    return rejected();
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return rejected();
  }

  reset(emailKey);
  await prisma.accountUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() }
  });

  const token = await createAccountSession(user.id, remember);
  await setAccountCookie(token, remember);
  return { ok: true };
}

export async function logoutAccount() {
  // Kill any in-flight BIS onboarding wizard state before dropping the auth
  // session. Prevents a next visitor on the same browser (kiosk / shared
  // laptop) from resuming the wizard as the previous user.
  await endOnboardingSession();
  await destroyAccountSession();
  redirect("/");
}

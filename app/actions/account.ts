"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { deleteAccountData } from "@/lib/account/delete-account";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/admin/password";
import {
  createAccountSession,
  setAccountCookie,
  destroyAccountSession,
  requireAccount
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
import { issueEmailVerificationToken } from "@/lib/account/email-verification";
import { sendVerificationEmail } from "@/lib/email/triggers/auth";
import { isEmailRateLimited, RATE_LIMITS } from "@/lib/email/rate-limit";


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

  let user: { id: string; email: string; firstName: string; lastName: string };
  try {
    user = await prisma.accountUser.create({
      data: { firstName, lastName, email, passwordHash: hashPassword(password) },
      select: { id: true, email: true, firstName: true, lastName: true }
    });
  } catch (error) {
    // Concurrent signup with the same email won the unique-index race.
    if ((error as { code?: string }).code === "P2002") return duplicate;
    throw error;
  }

  record(ipKey);

  // NOTE: no Participant / QR is created here. The QR badge is issued
  // automatically once the email is VERIFIED (see
  // consumeEmailVerificationToken), so an unverified signup cannot reserve
  // someone else's (event, email) slot or obtain a credential.

  // Verification email. Failure here MUST NOT roll back the successful
  // signup (spec §26) — the account is usable without verification, and
  // the user can request a new verification link later. We catch every
  // failure defensively so a mail-server outage cannot break registration.
  try {
    const issued = await issueEmailVerificationToken({
      userId: user.id,
      email: user.email
    });
    await sendVerificationEmail({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      rawToken: issued.rawToken,
      expiresAt: issued.expiresAt
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[account] verification email failed to queue", err instanceof Error ? err.message : err);
  }

  const token = await createAccountSession(user.id, true);
  await setAccountCookie(token, true);
  return { ok: true };
}

export type ResendVerificationResult = { ok: boolean; message: string };

const RESENDS_PER_IP = 10;

// Re-send the email-confirmation link to the CURRENT account (identity from
// the session — no client-supplied id/email). Per-IP throttle here plus the
// per-recipient budget inside sendVerificationEmail. Answers are generic:
// nothing about other accounts is ever revealed.
export async function resendVerificationEmail(): Promise<ResendVerificationResult> {
  const account = await requireAccount();

  const current = await prisma.accountUser.findUnique({
    where: { id: account.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      emailVerifiedAt: true
    }
  });
  if (!current) return { ok: false, message: "Compte introuvable." };
  if (current.emailVerifiedAt) {
    return { ok: true, message: "Votre adresse email est déjà confirmée." };
  }

  const ip = await clientIp();
  const ipKey = `resend-verify:ip:${ip ?? "shared"}`;
  if (isBlocked(ipKey, RESENDS_PER_IP)) {
    return { ok: false, message: THROTTLED_MESSAGE };
  }
  record(ipKey);

  // Check the budgets BEFORE writing a token row, so rejected requests
  // cannot pile up live tokens: per-recipient budget (same as the sender)
  // plus a DB-backed 60 s cooldown that survives restarts / many instances.
  if (
    isEmailRateLimited({
      bucket: "verify",
      key: current.email.toLowerCase(),
      limit: RATE_LIMITS.verify
    })
  ) {
    return {
      ok: false,
      message:
        "Trop de demandes pour cette adresse. Réessayez dans quelques minutes."
    };
  }
  const recent = await prisma.emailVerificationToken.findFirst({
    where: {
      userId: current.id,
      usedAt: null,
      createdAt: { gt: new Date(Date.now() - 60_000) }
    },
    select: { id: true }
  });
  if (recent) {
    return {
      ok: false,
      message: "Un lien vient d'être envoyé. Patientez une minute avant de réessayer."
    };
  }

  try {
    const issued = await issueEmailVerificationToken({
      userId: current.id,
      email: current.email
    });
    const sent = await sendVerificationEmail({
      userId: current.id,
      email: current.email,
      firstName: current.firstName,
      lastName: current.lastName,
      rawToken: issued.rawToken,
      expiresAt: issued.expiresAt
    });
    if (!sent.ok) {
      return {
        ok: false,
        message:
          "Trop de demandes pour cette adresse. Réessayez dans quelques minutes."
      };
    }
    return {
      ok: true,
      message: "Lien envoyé. Vérifiez votre boîte email (et les spams)."
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[account] resend verification failed:",
      err instanceof Error ? err.name : "unknown"
    );
    return {
      ok: false,
      message: "Envoi impossible pour le moment. Réessayez plus tard."
    };
  }
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

// ─── Delete my account (store requirement: in-app, self-service) ──────────
//
// Identity comes from the session. The caller must re-enter the PASSWORD and
// type the confirmation word, so a hijacked session cookie or a stray tap
// cannot erase an account. Failed attempts are throttled per account and per
// IP. What is erased / anonymised is described in lib/account/delete-account.ts.

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(200),
  confirm: z.literal("SUPPRIMER")
});

const DELETE_FAILS_PER_ACCOUNT = 5;
const DELETE_FAILS_PER_IP = 20;

export type DeleteAccountActionResult = { ok: false; message: string };

export async function deleteMyAccount(
  input: unknown
): Promise<DeleteAccountActionResult> {
  const account = await requireAccount();

  const parsed = deleteAccountSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Saisissez votre mot de passe et le mot « SUPPRIMER »."
    };
  }

  const ip = await clientIp();
  const acctKey = `delete-account:acct:${account.id}`;
  const ipKey = ip ? `delete-account:ip:${ip}` : null;
  if (isBlocked(acctKey, DELETE_FAILS_PER_ACCOUNT) || isBlocked(ipKey, DELETE_FAILS_PER_IP)) {
    return { ok: false, message: THROTTLED_MESSAGE };
  }

  const row = await prisma.accountUser.findUnique({
    where: { id: account.id },
    select: { passwordHash: true }
  });
  // Same amount of work whether or not the row exists.
  let ok = false;
  if (row) ok = verifyPassword(parsed.data.password, row.passwordHash);
  else verifyPassword(parsed.data.password, DUMMY_HASH);
  if (!ok) {
    record(acctKey);
    record(ipKey);
    return { ok: false, message: "Mot de passe incorrect." };
  }

  try {
    await deleteAccountData(account.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[account] delete failed:",
      err instanceof Error ? err.name : "unknown"
    );
    return {
      ok: false,
      message: "Suppression impossible pour le moment. Aucune donnée n'a été modifiée."
    };
  }

  reset(acctKey);
  await endOnboardingSession();
  await destroyAccountSession(); // cookie (the session row is already gone)
  redirect("/?compte=supprime");
}

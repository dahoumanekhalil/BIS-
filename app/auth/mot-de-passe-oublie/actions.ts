"use server";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { issuePasswordResetToken } from "@/lib/account/password-reset";
import { sendPasswordResetEmail } from "@/lib/email/triggers/auth";
import { audit } from "@/lib/admin/audit";
import { isBlocked, record, THROTTLED_MESSAGE } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

// ─── Forgot-password server action ───────────────────────────────────────
//
// Enumeration-safe: returns a uniform response regardless of whether the
// email matches an AccountUser. Timing is kept roughly uniform by always
// performing the DB lookup and running the token-issue path in the "found"
// branch without leaking anything back to the caller.
//
// Rate limits:
//   • per-email  → issue token at most RATE_LIMITS.passwordReset / hour
//   • per-ip     → blunt anti-scan cap using the shared login limiter
//
// The response text is deliberately generic: "If that address matches an
// account we've sent an email with instructions." The user cannot tell
// whether the email actually landed anywhere.

const REQUEST_PER_IP_LIMIT = 30;

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Adresse email invalide")
});

export type ForgotState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

const UNIFORM_SUCCESS: ForgotState = {
  status: "success",
  message:
    "Si cette adresse est associée à un compte, vous recevrez un email pour réinitialiser votre mot de passe."
};

export async function requestPasswordResetAction(
  _prev: ForgotState,
  formData: FormData
): Promise<ForgotState> {
  const raw = { email: String(formData.get("email") ?? "") };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier l'adresse email saisie.",
      fieldErrors
    };
  }

  const ip = await clientIp();
  const ipKey = ip ? `password-reset:ip:${ip}` : null;
  if (isBlocked(ipKey, REQUEST_PER_IP_LIMIT)) {
    return { status: "error", message: THROTTLED_MESSAGE };
  }
  record(ipKey);

  const user = await prisma.accountUser.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, firstName: true, lastName: true }
  });

  if (!user) {
    // Audit unmatched requests for anti-abuse review, without revealing
    // to the caller.
    await audit({
      userId: null,
      action: "auth.password-reset.request.no-account",
      entity: "AccountUser",
      entityId: undefined as unknown as string,
      meta: { emailDomain: parsed.data.email.split("@")[1] ?? "" }
    }).catch(() => undefined);
    return UNIFORM_SUCCESS;
  }

  const issued = await issuePasswordResetToken({
    userId: user.id,
    requestIp: ip
  });

  const sendResult = await sendPasswordResetEmail({
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    rawToken: issued.rawToken,
    expiresAt: issued.expiresAt
  });

  await audit({
    userId: null,
    action: "auth.password-reset.request",
    entity: "AccountUser",
    entityId: user.id,
    meta: {
      queued: sendResult.ok,
      // NEVER log the raw token; only whether the email was queued.
      rateLimited: sendResult.ok === false && "reason" in sendResult
        ? sendResult.reason === "rate-limited"
        : false
    }
  }).catch(() => undefined);

  return UNIFORM_SUCCESS;
}

"use server";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/admin/password";
import { consumeAndSetPassword } from "@/lib/account/password-reset";
import { sendPasswordChangedNotice } from "@/lib/email/triggers/auth";
import { audit } from "@/lib/admin/audit";
import { isBlocked, record, THROTTLED_MESSAGE } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

// ─── Password-reset consume action ──────────────────────────────────────
//
// Validates the raw token, atomically claims it, writes the new password,
// destroys every AccountSession for the user, and queues a
// "password changed" security notification.
//
// Rate-limited per IP to blunt brute-force enumeration of raw tokens
// (though the token space is 256 bits so brute force is not practical —
// this is defense-in-depth against fuzzing).

const RESET_ATTEMPTS_PER_IP = 20;

const schema = z
  .object({
    token: z.string().trim().min(20).max(200),
    password: z.string().min(8, "Minimum 8 caractères").max(200),
    confirm: z.string()
  })
  .refine((d) => d.password === d.confirm, {
    path: ["confirm"],
    message: "Les mots de passe ne correspondent pas"
  });

export type ResetState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

export async function submitPasswordResetAction(
  _prev: ResetState,
  formData: FormData
): Promise<ResetState> {
  const raw = {
    token: String(formData.get("token") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirm: String(formData.get("confirm") ?? "")
  };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier les champs saisis.",
      fieldErrors
    };
  }

  const ip = await clientIp();
  const ipKey = ip ? `password-reset-consume:ip:${ip}` : null;
  if (isBlocked(ipKey, RESET_ATTEMPTS_PER_IP)) {
    return { status: "error", message: THROTTLED_MESSAGE };
  }
  record(ipKey);

  const result = await consumeAndSetPassword({
    rawToken: parsed.data.token,
    newPasswordHash: hashPassword(parsed.data.password)
  });

  if (!result.ok) {
    // All failure modes collapse to the same message so an attacker
    // cannot tell "wrong token" from "already used" from "expired" from
    // "user gone" by response text alone. Response timing is still
    // roughly uniform because consumeAndSetPassword does the same DB
    // work either way.
    return {
      status: "error",
      message: "Ce lien de réinitialisation n'est plus valide."
    };
  }

  const user = await prisma.accountUser.findUnique({
    where: { id: result.userId },
    select: { id: true, email: true, firstName: true, lastName: true }
  });
  if (user) {
    await sendPasswordChangedNotice({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      changedAt: new Date()
    });
  }

  await audit({
    userId: null,
    action: "auth.password-reset.consumed",
    entity: "AccountUser",
    entityId: result.userId,
    meta: {}
  }).catch(() => undefined);

  return {
    status: "success",
    message:
      "Votre mot de passe a été mis à jour. Vous pouvez maintenant vous connecter."
  };
}

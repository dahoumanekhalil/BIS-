"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import {
  saveSmtpConfig,
  smtpFormSchema,
  getSmtpConfig,
  getSmtpConfigView
} from "@/lib/email/config";
import { verifyConnection } from "@/lib/email/transport";
import { sendAdminTestEmail } from "@/lib/email/triggers/admin";
import { processQueue } from "@/lib/email/worker";

// ─── Admin server actions for /admin/settings/email ─────────────────────
//
// Every action here follows the same pattern:
//
//   1. requirePermission(<perm>) — session-derived actor. Never trust ids
//      from the browser.
//   2. Zod-parse inputs. Backend-authoritative — the browser cannot bypass
//      validation.
//   3. Perform the action + audit it.
//   4. Return a narrow, UI-safe result. Never surface raw SMTP responses
//      or credentials.

export type SaveState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

export async function saveSmtpConfigAction(
  _prev: SaveState,
  formData: FormData
): Promise<SaveState> {
  const { user } = await requirePermission("settings.manage");

  const raw = {
    host: String(formData.get("host") ?? "").trim(),
    port: Number(formData.get("port") ?? 587),
    encryption: String(formData.get("encryption") ?? "starttls"),
    authEnabled: formData.get("authEnabled") === "on",
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
    clearPassword: formData.get("clearPassword") === "on",
    fromEmail: String(formData.get("fromEmail") ?? "").trim(),
    fromName: String(formData.get("fromName") ?? "").trim(),
    replyTo: String(formData.get("replyTo") ?? ""),
    connectionTimeoutMs: Number(formData.get("connectionTimeoutMs") ?? 15000),
    authTimeoutMs: Number(formData.get("authTimeoutMs") ?? 15000),
    maxAttempts: Number(formData.get("maxAttempts") ?? 5),
    contactRecipient: String(formData.get("contactRecipient") ?? ""),
    mode: String(formData.get("mode") ?? "log-only"),
    allowlistDomains: String(formData.get("allowlistDomains") ?? "")
  };

  const parsed = smtpFormSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier les champs marqués.",
      fieldErrors
    };
  }

  try {
    await saveSmtpConfig(parsed.data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[settings.email] save failed", err instanceof Error ? err.message : err);
    return {
      status: "error",
      message:
        "Impossible d'enregistrer la configuration. Vérifiez que la clé de chiffrement EMAIL_SECRET_ENCRYPTION_KEY est correctement définie."
    };
  }

  // Audit — never log the password or the ciphertext. `passwordChanged`
  // captures the intent (rotation / clear / no-change) instead.
  const passwordChanged = parsed.data.clearPassword
    ? "cleared"
    : parsed.data.password
      ? "rotated"
      : "unchanged";
  await audit({
    userId: user.id,
    action: "settings.email.save",
    entity: "SiteContent",
    entityId: "email.smtp",
    meta: {
      host: parsed.data.host,
      port: parsed.data.port,
      encryption: parsed.data.encryption,
      authEnabled: parsed.data.authEnabled,
      hasUsername: Boolean(parsed.data.username),
      passwordChanged,
      fromEmail: parsed.data.fromEmail,
      fromName: parsed.data.fromName,
      hasReplyTo: Boolean(parsed.data.replyTo),
      hasContactRecipient: Boolean(parsed.data.contactRecipient),
      mode: parsed.data.mode
    }
  });

  revalidatePath("/admin/settings");
  revalidatePath("/admin/settings/email");
  return { status: "success", message: "Configuration enregistrée." };
}

export type TestConnectionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function testSmtpConnectionAction(): Promise<TestConnectionState> {
  const { user } = await requirePermission("settings.email.test");
  const cfg = await getSmtpConfig();
  if (!cfg) {
    return {
      status: "error",
      message:
        "Configuration SMTP incomplète. Enregistrez au moins le host et l'expéditeur."
    };
  }
  const result = await verifyConnection(cfg);
  await audit({
    userId: user.id,
    action: result.ok
      ? "settings.email.test-connection.ok"
      : "settings.email.test-connection.failed",
    entity: "SiteContent",
    entityId: "email.smtp",
    meta: {
      host: cfg.host,
      port: cfg.port,
      encryption: cfg.encryption,
      ...(result.ok ? {} : { category: result.category })
    }
  });
  if (result.ok) {
    return {
      status: "success",
      message: "Connexion SMTP réussie."
    };
  }
  return { status: "error", message: result.message };
}

export type SendTestState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

const testRecipientSchema = z
  .string()
  .trim()
  .email("Adresse email invalide");

export async function sendTestEmailAction(
  _prev: SendTestState,
  formData: FormData
): Promise<SendTestState> {
  const { user } = await requirePermission("settings.email.test");

  const parsed = testRecipientSchema.safeParse(formData.get("recipient") ?? "");
  if (!parsed.success) {
    return { status: "error", message: "Adresse email invalide." };
  }

  const result = await sendAdminTestEmail({
    adminId: user.id,
    adminName: user.name,
    recipient: parsed.data
  });

  if (result.ok) {
    revalidatePath("/admin/settings/email");
    return {
      status: "success",
      message: "Email de test envoyé. Vérifiez la boîte de réception."
    };
  }

  const reasonMessage: Record<
    Exclude<typeof result.reason, undefined>,
    string
  > = {
    "not-configured":
      "Configuration SMTP incomplète. Enregistrez au moins le host et l'expéditeur.",
    "rate-limited":
      "Trop d'emails de test envoyés récemment. Réessayez plus tard.",
    "invalid-recipient": "Adresse email invalide.",
    "log-only":
      "Le mode « log-only » est actif. L'email a été journalisé mais aucun envoi SMTP n'a été réalisé.",
    off: "Le mode email est actuellement désactivé (OFF).",
    "send-failed": result.message ?? "Échec d'envoi. Vérifiez la configuration SMTP."
  };
  revalidatePath("/admin/settings/email");
  return {
    status: "error",
    message: reasonMessage[result.reason]
  };
}

export type RunWorkerState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function runEmailWorkerAction(): Promise<RunWorkerState> {
  const { user } = await requirePermission("settings.email.test");
  const result = await processQueue();
  await audit({
    userId: user.id,
    action: "settings.email.worker.run",
    entity: "EmailMessage",
    entityId: null as unknown as string,
    meta: result
  });
  revalidatePath("/admin/settings/email");
  return {
    status: "success",
    message:
      `Tick terminé — ${result.processed} traité(s), ` +
      `${result.sent} envoyé(s), ${result.retried} en attente de retry, ` +
      `${result.failed} échec(s)` +
      (result.cleanedStale > 0
        ? `, ${result.cleanedStale} anciens messages invalidés.`
        : ".")
  };
}

// Expose the current view for the server component. Kept here so the
// client component doesn't accidentally call a lib module directly.
export async function loadSmtpView() {
  await requirePermission("settings.manage");
  return getSmtpConfigView();
}

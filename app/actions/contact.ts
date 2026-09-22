"use server";

import { contactSchema } from "@/lib/validations";
import { sendContactRelay } from "@/lib/email/triggers/contact";
import { clientIp } from "@/lib/client-ip";
import { audit } from "@/lib/admin/audit";

export type ContactState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

export async function sendContactMessage(
  _prev: ContactState,
  formData: FormData
): Promise<ContactState> {
  const raw = {
    name: formData.get("name") ?? "",
    email: formData.get("email") ?? "",
    organization: formData.get("organization") ?? "",
    reason: formData.get("reason") ?? "general",
    subject: formData.get("subject") ?? "",
    message: formData.get("message") ?? ""
  };

  const parsed = contactSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors
    };
  }

  const ip = await clientIp();
  // Delivery is best-effort. If email is not configured (no SMTP host) or
  // the contact recipient is empty, we still show success to the user so
  // the contact page keeps working during setup — but we AUDIT the miss
  // so the admin sees that submissions arrived without being delivered.
  const result = await sendContactRelay({
    name: parsed.data.name,
    email: parsed.data.email,
    organization: parsed.data.organization || null,
    reason: parsed.data.reason,
    subject: parsed.data.subject,
    message: parsed.data.message,
    requestIp: ip ?? null
  });

  await audit({
    userId: null,
    action: "contact.submit",
    entity: "SiteContent",
    entityId: "email.smtp",
    meta: {
      queued: result.ok,
      reason: result.ok ? "queued" : result.reason
    }
  }).catch(() => undefined);

  if (!result.ok && result.reason === "rate-limited") {
    return {
      status: "error",
      message:
        "Trop de messages envoyés depuis cette adresse. Merci de réessayer plus tard."
    };
  }

  // Uniform "received" — surface a warning to the ops via audit, not to
  // the user. Preserves prior UX where the form always shows success.
  return {
    status: "success",
    message:
      "Message reçu. L'équipe BIS 2026 reviendra vers vous sous 48 heures ouvrées."
  };
}

"use server";

import { contactSchema } from "@/lib/validations";

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

  // TODO: wire real email delivery (Resend / Postmark / SES / SMTP).
  // For now we log the payload server-side so nothing is silently faked.
  // eslint-disable-next-line no-console
  console.log("[contact] new message", parsed.data);

  return {
    status: "success",
    message:
      "Message reçu. L'équipe BIS 2026 reviendra vers vous sous 48 heures ouvrées."
  };
}

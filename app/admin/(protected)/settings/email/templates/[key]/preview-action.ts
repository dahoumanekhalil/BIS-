"use server";

import { requirePermission } from "@/lib/admin/auth";
import { renderDbTemplate } from "@/lib/email/templates/db-render";
import { getEmailBranding } from "@/lib/email/templates/branding";
import { sampleVars } from "@/lib/email/templates/registry";
import { validateTemplatePayload } from "@/lib/email/templates/service";

// ─── Server-side preview action ──────────────────────────────────────────
//
// Rendering runs on the server so the sanitizer applies to admin HTML
// exactly as it will at real send time — the client never sees an
// unsanitized preview.

export type PreviewResult =
  | { ok: true; html: string; text: string; subject: string; warnings: string[] }
  | { ok: false; message: string };

export async function previewTemplateAction(input: {
  subject: string;
  preheader: string;
  htmlBody: string;
  textBody: string;
  useHeader: boolean;
  useFooter: boolean;
}): Promise<PreviewResult> {
  await requirePermission("settings.email.templates");

  const errors = validateTemplatePayload({
    subject: input.subject,
    htmlBody: input.htmlBody,
    textBody: input.textBody,
    preheader: input.preheader
  });
  const blocking = errors.filter(
    (e) => e.code === "html-dangerous" || e.code === "subject-empty"
  );
  if (blocking.length > 0) {
    return {
      ok: false,
      message: blocking.map((e) => "• " + e.message).join("\n")
    };
  }
  const warnings = errors
    .filter((e) => e.code === "unknown-variable")
    .map((e) => e.message);

  const branding = await getEmailBranding();
  const rendered = renderDbTemplate({
    subject: input.subject,
    preheader: input.preheader || null,
    htmlBody: input.htmlBody,
    textBody: input.textBody,
    useHeader: input.useHeader,
    useFooter: input.useFooter,
    branding,
    vars: sampleVars()
  });
  return {
    ok: true,
    html: rendered.html,
    text: rendered.text,
    subject: rendered.subject,
    warnings
  };
}

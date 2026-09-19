import "server-only";

import { prisma } from "@/lib/db";
import { EmailStatus } from "@prisma/client";
import { EMAIL_TEMPLATES } from "@/lib/admin/email-templates";
import { renderEmail, type EmailVars } from "@/lib/email/render";

/**
 * Queue an outbound branded email using an existing template key.
 *
 * Reuses the admin `EmailMessage` audit trail — do NOT create a second
 * outbound path. The email lands in the same queue admin operators see.
 *
 * The `participantId` link is best-effort (nullable): visitor / company
 * registrations link back to a Participant row; application flows do not,
 * because Application ≠ Participant.
 */
export async function queueTemplatedEmail({
  templateKey,
  to,
  toName,
  vars,
  participantId
}: {
  templateKey: string;
  to: string;
  toName?: string;
  vars: EmailVars;
  participantId?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const template = EMAIL_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) {
    return { ok: false, reason: `Unknown template: ${templateKey}` };
  }

  const rendered = renderEmail({
    subject: template.subject,
    content: template.content,
    vars
  });

  const record = await prisma.emailMessage.create({
    data: {
      participantId: participantId ?? null,
      sentByUserId: null, // system-queued (no admin operator)
      toEmail: to,
      toName: toName ?? null,
      subject: rendered.subject,
      body: rendered.text,
      html: rendered.html,
      templateKey: template.key,
      status: EmailStatus.QUEUED
    }
  });

  return { ok: true, id: record.id };
}

export const EVENT_VARS: Pick<EmailVars, "eventDate" | "eventVenue"> = {
  eventDate: "15 – 17 novembre 2026",
  eventVenue: "CIC Alger"
};

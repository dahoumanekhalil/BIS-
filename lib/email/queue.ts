import "server-only";

import { prisma } from "@/lib/db";
import { EmailStatus, Prisma } from "@prisma/client";
import { EMAIL_TEMPLATES } from "@/lib/admin/email-templates";
import { renderEmail, type EmailVars } from "@/lib/email/render";
import { renderDbTemplate } from "@/lib/email/templates/db-render";
import { getEmailBranding } from "@/lib/email/templates/branding";
import { kickWorkerAsync } from "@/lib/email/worker";

/**
 * Queue an outbound branded email using an existing template key.
 *
 * Reuses the admin `EmailMessage` audit trail — do NOT create a second
 * outbound path. The email lands in the same queue admin operators see.
 *
 * The `participantId` link is best-effort (nullable): visitor / company
 * registrations link back to a Participant row; application flows do not,
 * because Application ≠ Participant.
 *
 * Idempotency (added by Email Infrastructure Phase):
 *   Callers that fire on state transitions (e.g. room-registration PAID,
 *   password reset) should pass a deterministic `idempotencyKey`. The DB
 *   has a partial UNIQUE index on `EmailMessage(idempotencyKey)`, so a
 *   duplicate emission returns the already-queued row instead of creating
 *   a second one.
 */
export async function queueTemplatedEmail({
  templateKey,
  to,
  toName,
  vars,
  participantId,
  idempotencyKey,
  locale
}: {
  templateKey: string;
  to: string;
  toName?: string;
  vars: EmailVars;
  participantId?: string | null;
  idempotencyKey?: string | null;
  locale?: string;
}): Promise<
  | { ok: true; id: string; deduped: boolean }
  | { ok: false; reason: string }
> {
  // Idempotency short-circuit — cheaper than catching P2002 and returning
  // the already-queued row.
  if (idempotencyKey) {
    const existing = await prisma.emailMessage.findUnique({
      where: { idempotencyKey },
      select: { id: true }
    });
    if (existing) {
      return { ok: true, id: existing.id, deduped: true };
    }
  }

  // Prefer an active DB template with matching key (admin override), fall
  // back to the code catalog. A missing key in BOTH is a hard error.
  const dbOverride = await prisma.emailTemplate.findFirst({
    where: { key: templateKey, isActive: true }
  });
  const codeTemplate = EMAIL_TEMPLATES.find((t) => t.key === templateKey);
  if (!dbOverride && !codeTemplate) {
    return { ok: false, reason: `Unknown template: ${templateKey}` };
  }

  const rendered = dbOverride
    ? renderDbTemplate({
        subject: dbOverride.subject,
        preheader: dbOverride.preheader,
        htmlBody: dbOverride.htmlBody,
        textBody: dbOverride.textBody,
        useHeader: dbOverride.useHeader,
        useFooter: dbOverride.useFooter,
        branding: await getEmailBranding(),
        vars
      })
    : renderEmail({
        subject: codeTemplate!.subject,
        content: codeTemplate!.content,
        vars
      });

  try {
    const record = await prisma.emailMessage.create({
      data: {
        participantId: participantId ?? null,
        sentByUserId: null, // system-queued (no admin operator)
        toEmail: to,
        toName: toName ?? null,
        subject: rendered.subject,
        body: rendered.text,
        html: rendered.html,
        templateKey: templateKey,
        status: EmailStatus.QUEUED,
        idempotencyKey: idempotencyKey ?? null,
        locale: locale ?? "fr",
        // Fire immediately on next worker tick.
        nextAttemptAt: null
      }
    });
    kickWorkerAsync();
    return { ok: true, id: record.id, deduped: false };
  } catch (err) {
    // A racing double-insert on the same idempotencyKey landed first. Return
    // the winning row rather than the caller thinking the queue is broken.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      idempotencyKey
    ) {
      const existing = await prisma.emailMessage.findUnique({
        where: { idempotencyKey },
        select: { id: true }
      });
      if (existing) return { ok: true, id: existing.id, deduped: true };
    }
    throw err;
  }
}

export const EVENT_VARS: Pick<EmailVars, "eventDate" | "eventVenue"> = {
  eventDate: "3 – 5 janvier 2017",
  eventVenue: "CIC Alger"
};

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { EmailStatus } from "@prisma/client";
import {
  EMAIL_TEMPLATES,
  composeEmailContent
} from "@/lib/admin/email-templates";
import { renderEmail, type EmailVars } from "@/lib/email/render";

const schema = z.object({
  subject: z.string().trim().min(2, "Sujet requis").max(200),
  body: z.string().trim().min(10, "Message trop court").max(20000),
  templateKey: z.string().trim().max(60).optional().or(z.literal(""))
});

export type SendState =
  | { status: "idle" }
  | { status: "success"; message: string; emailId: string; mailtoUrl: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

export async function sendEmail(
  participantId: string,
  _prev: SendState,
  formData: FormData
): Promise<SendState> {
  const { user } = await requirePermission("registrants.email");

  const raw = {
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
    templateKey: String(formData.get("templateKey") ?? "")
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier le sujet et le corps du message.",
      fieldErrors
    };
  }

  const participant = await prisma.participant.findUnique({
    where: { id: participantId }
  });
  if (!participant) {
    return { status: "error", message: "Inscrit introuvable." };
  }

  // Build the branded HTML + plain text from the composed content.
  const template = parsed.data.templateKey
    ? EMAIL_TEMPLATES.find((t) => t.key === parsed.data.templateKey)
    : undefined;

  // Payment-removal Phase 3: paymentAmount/paymentRef removed from the
  // template variable set alongside the schema drop.
  const vars: EmailVars = {
    firstName: participant.firstName,
    lastName: participant.lastName,
    fullName: `${participant.firstName} ${participant.lastName}`,
    email: participant.email,
    tier: (participant.tier ?? "").replace("_", " "),
    gate: participant.gate ?? "",
    ticketCode: participant.ticketCode ?? "",
    eventDate: "3 – 5 janvier 2017",
    eventVenue: "CIC Alger"
  };

  const content = composeEmailContent({
    template,
    bodyText: parsed.data.body
  });
  const rendered = renderEmail({
    subject: parsed.data.subject,
    content,
    vars
  });

  const record = await prisma.emailMessage.create({
    data: {
      participantId: participant.id,
      sentByUserId: user.id,
      toEmail: participant.email,
      toName: `${participant.firstName} ${participant.lastName}`,
      subject: rendered.subject,
      body: rendered.text,
      html: rendered.html,
      templateKey: parsed.data.templateKey || null,
      status: EmailStatus.QUEUED
    }
  });

  await audit({
    userId: user.id,
    action: "email.queue",
    entity: "Participant",
    entityId: participant.id,
    meta: {
      emailId: record.id,
      subject: rendered.subject,
      templateKey: parsed.data.templateKey || null
    }
  });

  revalidatePath(`/admin/registrants/${participant.id}`);
  revalidatePath(`/admin/registrants/${participant.id}/email`);
  revalidatePath(`/admin/audit-log`);

  // mailto: uses the plain-text version so the recipient's mail client
  // doesn't get a raw HTML dump when the operator uses the fallback.
  const mailtoUrl = `mailto:${encodeURIComponent(participant.email)}?subject=${encodeURIComponent(rendered.subject)}&body=${encodeURIComponent(rendered.text)}`;

  return {
    status: "success",
    message:
      "Message préparé avec succès. Ajouté à la file d'envoi et journalisé dans l'audit log.",
    emailId: record.id,
    mailtoUrl
  };
}

export async function markEmailSent(id: string) {
  await requirePermission("registrants.email");
  await prisma.emailMessage.update({
    where: { id },
    data: { status: EmailStatus.SENT, sentAt: new Date() }
  });
  redirect(
    `/admin/registrants/${(await prisma.emailMessage.findUnique({ where: { id }, select: { participantId: true } }))?.participantId ?? ""}`
  );
}

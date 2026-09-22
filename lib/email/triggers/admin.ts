import "server-only";

import { randomBytes } from "crypto";
import { getSmtpConfig } from "@/lib/email/config";
import { renderEmail } from "@/lib/email/render";
import { EMAIL_TEMPLATES } from "@/lib/admin/email-templates";
import { sendMail } from "@/lib/email/transport";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import { EmailStatus } from "@prisma/client";
import {
  isEmailRateLimited,
  recordEmailAttempt,
  RATE_LIMITS
} from "@/lib/email/rate-limit";

// Admin-facing "Send test email" action. Deliberately bypasses the worker
// queue and calls the transport directly so an admin gets an immediate
// synchronous success/failure result while diagnosing SMTP config.
// The outcome is still written to the EmailMessage outbox so the send is
// audited in the same place as all other emails.

export type AdminTestEmailInput = {
  adminId: string;
  adminName: string;
  recipient: string;
};

export type AdminTestEmailResult =
  | { ok: true; providerMsgId: string | null; emailId: string }
  | {
      ok: false;
      reason:
        | "not-configured"
        | "rate-limited"
        | "invalid-recipient"
        | "log-only"
        | "off"
        | "send-failed";
      message?: string;
      emailId?: string;
    };

export async function sendAdminTestEmail(
  input: AdminTestEmailInput
): Promise<AdminTestEmailResult> {
  const cfg = await getSmtpConfig();
  if (!cfg) return { ok: false, reason: "not-configured" };

  // Per-admin cap. Prevents an admin (or a compromised admin account)
  // turning the SMTP relay into a spam source via looped test sends.
  const bucket = { bucket: "test-send" as const, key: input.adminId };
  if (isEmailRateLimited({ ...bucket, limit: RATE_LIMITS.testSend })) {
    return { ok: false, reason: "rate-limited" };
  }

  const template = EMAIL_TEMPLATES.find((t) => t.key === "admin-test-email");
  if (!template) {
    return { ok: false, reason: "send-failed", message: "Missing test template." };
  }

  const rendered = renderEmail({
    subject: template.subject,
    content: template.content,
    vars: {
      adminName: input.adminName,
      issuedAt: new Date().toISOString()
    }
  });

  // Write an outbox row before we call the transport so an admin can see
  // the attempt in the audit trail even if the process dies mid-send.
  const outboxId =
    "test_" + randomBytes(8).toString("hex");
  const record = await prisma.emailMessage.create({
    data: {
      participantId: null,
      sentByUserId: input.adminId,
      toEmail: input.recipient,
      toName: null,
      subject: rendered.subject,
      body: rendered.text,
      html: rendered.html,
      templateKey: template.key,
      status: EmailStatus.QUEUED,
      idempotencyKey: outboxId,
      locale: "fr"
    }
  });

  // In log-only mode, mark the row SENT with provider=log-only and skip
  // the transport. This lets an admin verify the queue/rendering pipeline
  // even when SMTP is deliberately disabled in dev.
  if (cfg.mode === "log-only") {
    await prisma.emailMessage.update({
      where: { id: record.id },
      data: {
        status: EmailStatus.SENT,
        sentAt: new Date(),
        provider: "log-only",
        attemptCount: 1
      }
    });
    await audit({
      userId: input.adminId,
      action: "email.test.log-only",
      entity: "EmailMessage",
      entityId: record.id,
      meta:
        cfg.provider === "resend"
          ? { to: input.recipient, provider: "resend" }
          : { to: input.recipient, provider: "smtp", host: cfg.host }
    });
    recordEmailAttempt(bucket);
    return { ok: false, reason: "log-only", emailId: record.id };
  }

  if (cfg.mode === "off") {
    await prisma.emailMessage.update({
      where: { id: record.id },
      data: {
        status: EmailStatus.FAILED,
        lastError: "Email mode is OFF.",
        errorMessage: "Email mode is OFF.",
        attemptCount: 1
      }
    });
    return { ok: false, reason: "off", emailId: record.id };
  }

  const result = await sendMail(cfg, {
    to: input.recipient,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    idempotencyKey: outboxId
  });

  recordEmailAttempt(bucket);

  if (result.ok) {
    await prisma.emailMessage.update({
      where: { id: record.id },
      data: {
        status: EmailStatus.SENT,
        sentAt: new Date(),
        provider: cfg.provider,
        providerMsgId: result.providerMsgId,
        attemptCount: 1
      }
    });
    await audit({
      userId: input.adminId,
      action: "email.test.sent",
      entity: "EmailMessage",
      entityId: record.id,
      meta:
        cfg.provider === "resend"
          ? {
              to: input.recipient,
              provider: "resend",
              providerMsgId: result.providerMsgId
            }
          : {
              to: input.recipient,
              provider: "smtp",
              host: cfg.host,
              port: cfg.port,
              providerMsgId: result.providerMsgId
            }
    });
    return { ok: true, providerMsgId: result.providerMsgId, emailId: record.id };
  }

  await prisma.emailMessage.update({
    where: { id: record.id },
    data: {
      status: EmailStatus.FAILED,
      lastError: result.message.slice(0, 500),
      errorMessage: result.message.slice(0, 500),
      attemptCount: 1
    }
  });
  await audit({
    userId: input.adminId,
    action: "email.test.failed",
    entity: "EmailMessage",
    entityId: record.id,
    meta:
      cfg.provider === "resend"
        ? {
            to: input.recipient,
            provider: "resend",
            category: result.category
          }
        : {
            to: input.recipient,
            provider: "smtp",
            host: cfg.host,
            port: cfg.port,
            category: result.category
          }
  });
  return {
    ok: false,
    reason: "send-failed",
    message: result.message,
    emailId: record.id
  };
}

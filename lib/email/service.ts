import "server-only";

import { EmailStatus, type EmailMessage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import {
  getSmtpConfig,
  isRecipientAllowedInEnvironment,
  type SmtpConfig
} from "./config";
import { sendMail, type SendResult } from "./transport";

// ─── Delivery outcomes ───────────────────────────────────────────────────

type Outcome =
  | { kind: "sent"; providerMsgId: string | null }
  | { kind: "log-only" }
  | { kind: "off" }
  | { kind: "blocked-by-allowlist" }
  | { kind: "retryable"; message: string }
  | { kind: "permanent"; message: string }
  | { kind: "not-configured" };

// Exponential backoff, capped at 1 hour. Schedule the next attempt from
// `now`, not from `createdAt`, so a re-enqueued row after a long DB outage
// does not spam the SMTP server catching up.
function backoffMs(attemptCount: number): number {
  const base = 30_000; // 30 s
  const capped = Math.min(60 * 60 * 1000, base * 2 ** Math.max(0, attemptCount - 1));
  const jitter = Math.floor(Math.random() * 5_000);
  return capped + jitter;
}

/**
 * Attempt to deliver a single outbox row. Handles config-off, log-only,
 * dev allowlist, retryable vs permanent failure, and writes the outcome
 * back to the row atomically. NEVER throws — the caller (worker) is not
 * expected to try/catch.
 */
export async function sendOutboxRow(row: EmailMessage): Promise<Outcome> {
  const cfg = await getSmtpConfig();
  if (!cfg) {
    await markPermanent(row, "Email not configured — no SMTP host set.");
    return { kind: "not-configured" };
  }

  if (cfg.mode === "off") {
    await markPermanent(row, "Email mode is OFF.");
    return { kind: "off" };
  }

  if (cfg.mode === "log-only") {
    await markSentLogOnly(row);
    return { kind: "log-only" };
  }

  // cfg.mode === "live"
  if (!isRecipientAllowedInEnvironment(row.toEmail, cfg)) {
    await markPermanent(
      row,
      "Recipient blocked by non-production allowlist (EMAIL_ALLOWLIST)."
    );
    return { kind: "blocked-by-allowlist" };
  }

  const result: SendResult = await sendMail(cfg, {
    to: row.toEmail,
    toName: row.toName,
    subject: row.subject,
    text: row.body,
    html: row.html,
    // Forward the queue's stable idempotency key to the provider layer.
    // Resend uses it as its own request idempotency key so a retried
    // outbox claim of the same row cannot double-deliver. SMTP has no
    // equivalent and simply ignores the field.
    idempotencyKey: row.idempotencyKey ?? null
  });

  if (result.ok) {
    await markSentLive(row, cfg, result.providerMsgId);
    return { kind: "sent", providerMsgId: result.providerMsgId };
  }

  if (result.retryable && row.attemptCount + 1 < row.maxAttempts) {
    await markRetry(row, result.message);
    return { kind: "retryable", message: result.message };
  }

  await markPermanent(row, result.message);
  return { kind: "permanent", message: result.message };
}

/* ------------------------------ WRITERS ------------------------------ */

async function markSentLive(
  row: EmailMessage,
  cfg: SmtpConfig,
  providerMsgId: string | null
): Promise<void> {
  await prisma.emailMessage.update({
    where: { id: row.id },
    data: {
      status: EmailStatus.SENT,
      sentAt: new Date(),
      attemptCount: row.attemptCount + 1,
      nextAttemptAt: null,
      lastError: null,
      provider: cfg.provider,
      providerMsgId,
      errorMessage: null
    }
  });
  await audit({
    userId: null,
    action: "email.sent",
    entity: "EmailMessage",
    entityId: row.id,
    meta:
      cfg.provider === "resend"
        ? {
            templateKey: row.templateKey,
            to: row.toEmail,
            provider: "resend",
            providerMsgId
          }
        : {
            templateKey: row.templateKey,
            to: row.toEmail,
            provider: "smtp",
            host: cfg.host,
            port: cfg.port,
            encryption: cfg.encryption,
            providerMsgId
          }
  });
}

async function markSentLogOnly(row: EmailMessage): Promise<void> {
  await prisma.emailMessage.update({
    where: { id: row.id },
    data: {
      status: EmailStatus.SENT,
      sentAt: new Date(),
      attemptCount: row.attemptCount + 1,
      nextAttemptAt: null,
      lastError: null,
      provider: "log-only",
      providerMsgId: null,
      errorMessage: null
    }
  });
  await audit({
    userId: null,
    action: "email.log-only",
    entity: "EmailMessage",
    entityId: row.id,
    meta: {
      templateKey: row.templateKey,
      to: row.toEmail
    }
  });
}

async function markRetry(row: EmailMessage, reason: string): Promise<void> {
  const nextAt = new Date(Date.now() + backoffMs(row.attemptCount + 1));
  await prisma.emailMessage.update({
    where: { id: row.id },
    data: {
      status: EmailStatus.QUEUED,
      attemptCount: row.attemptCount + 1,
      nextAttemptAt: nextAt,
      lastError: reason.slice(0, 500)
    }
  });
}

async function markPermanent(row: EmailMessage, reason: string): Promise<void> {
  await prisma.emailMessage.update({
    where: { id: row.id },
    data: {
      status: EmailStatus.FAILED,
      attemptCount: row.attemptCount + 1,
      nextAttemptAt: null,
      lastError: reason.slice(0, 500),
      errorMessage: reason.slice(0, 500)
    }
  });
  await audit({
    userId: null,
    action: "email.failed",
    entity: "EmailMessage",
    entityId: row.id,
    meta: {
      templateKey: row.templateKey,
      to: row.toEmail,
      reason: reason.slice(0, 200)
    }
  }).catch(() => undefined);
}

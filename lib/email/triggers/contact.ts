import "server-only";

import { createHash } from "crypto";
import { queueTemplatedEmail } from "@/lib/email/queue";
import { getSmtpConfig } from "@/lib/email/config";
import {
  isEmailRateLimited,
  recordEmailAttempt,
  RATE_LIMITS
} from "@/lib/email/rate-limit";

const REASON_LABEL: Record<string, string> = {
  general: "Question générale",
  sponsor: "Partenariat / sponsor",
  media: "Presse / média",
  speaker: "Intervention",
  registration: "Inscription",
  other: "Autre"
};

// Truncate to avoid a giant contact message blowing up the outbox row.
// The full text is still visible to the recipient in the plain-text body,
// but the DB row stays reasonable.
const MAX_MSG_LENGTH = 4000;

export type SendContactRelayInput = {
  name: string;
  email: string;
  organization: string | null;
  reason: string;
  subject: string;
  message: string;
  requestIp: string | null;
};

export type ContactRelayResult =
  | { ok: true; deduped: boolean }
  | { ok: false; reason: "rate-limited" | "no-recipient" | "not-configured" | string };

/**
 * Send a contact-form submission to the configured `contact.recipient`.
 * Returns `no-recipient` when the admin has not set one — the caller should
 * treat this as a soft failure (log server-side, still show "received" to
 * the user). This preserves the current UX behaviour where a submitted form
 * always shows success, while making it obvious in the audit log that the
 * message never went anywhere.
 */
export async function sendContactRelay(
  input: SendContactRelayInput
): Promise<ContactRelayResult> {
  const cfg = await getSmtpConfig();
  if (!cfg) return { ok: false, reason: "not-configured" };
  if (!cfg.contactRecipient) return { ok: false, reason: "no-recipient" };

  // Per-IP throttle. Falls back to shared bucket when no IP is available,
  // matching the pattern in app/actions/account.ts.
  const bucket = {
    bucket: "contact" as const,
    key: input.requestIp ?? "shared"
  };
  if (isEmailRateLimited({ ...bucket, limit: RATE_LIMITS.contact })) {
    return { ok: false, reason: "rate-limited" };
  }

  const trimmedMessage = input.message.slice(0, MAX_MSG_LENGTH);
  // Idempotency: hash the request payload so a rapid double-submit of the
  // same form dedupes, but a legitimate second message with different
  // content fires again.
  const bodyHash = createHash("sha256")
    .update(
      [input.email, input.subject, trimmedMessage, input.reason].join("|")
    )
    .digest("hex")
    .slice(0, 16);
  const bucketMinute = Math.floor(Date.now() / (60 * 1000));

  const result = await queueTemplatedEmail({
    templateKey: "contact-form-relay",
    to: cfg.contactRecipient,
    idempotencyKey: `contact:${bodyHash}:${bucketMinute}`,
    vars: {
      contactName: input.name,
      contactEmail: input.email,
      contactOrganization: input.organization ?? "—",
      contactReason: REASON_LABEL[input.reason] ?? input.reason,
      contactSubject: input.subject,
      contactMessage: trimmedMessage
    }
  });

  if (result.ok) recordEmailAttempt(bucket);
  return result;
}

import "server-only";

import { Resend } from "resend";
import type { SmtpConfig } from "../config";
import type {
  SendMessage,
  SendResult,
  TransportErrorCategory,
  VerifyResult
} from "./types";

// ─── Resend provider ─────────────────────────────────────────────────────
//
// Wraps the official `resend` SDK. The SDK returns `{ data, error }` for
// every call; we classify the error and produce a normalized SendResult
// / VerifyResult so the worker never needs to know a provider-specific
// error shape.
//
// The API key MUST live in cfg.resendApiKey — never logged, never included
// in the response payload, never rendered in the admin UI. A missing key
// is surfaced as a plain "auth" failure so the operator sees "configure
// the API key" instead of a stack trace.

type ResendErrorLike = {
  name?: string | null;
  statusCode?: number | null;
  message?: string | null;
};

// Resend error names we care about. Reference: docs.resend.com/api-reference/errors
//
// Historically we grouped `validation_error` under "invalid key" — that was
// wrong. `validation_error` is Resend's generic bucket and by far its most
// common trigger is "the From domain is not verified", which is a payload
// problem, not an auth problem. Classifying it as `recipient` (permanent)
// prevents the worker from burning retries on an operator-configuration
// error AND surfaces a message the admin can actually act on.
const RESEND_AUTH_ERROR_NAMES = new Set([
  "invalid_api_key",
  "missing_api_key",
  "unauthorized"
]);

// Restricted / "sending-only" keys deliberately can't call domains.list();
// treating this as success means "test connection" works for the
// recommended-production key type.
const RESEND_RESTRICTED_KEY_NAMES = new Set([
  "restricted_api_key",
  "not_enough_permissions"
]);

const RESEND_RECIPIENT_ERROR_NAMES = new Set([
  "invalid_from_address",
  "invalid_to_address",
  // Every observed 403 "domain not verified" response from Resend ships
  // under this generic name. Grouping it here yields a helpful French
  // message and marks the send permanent so the worker stops retrying.
  "validation_error"
]);

function classifyResend(err: ResendErrorLike | null | undefined): TransportErrorCategory {
  if (!err) return "unknown";
  const name = (err.name ?? "").toString().toLowerCase();
  const status = err.statusCode ?? 0;
  if (RESEND_AUTH_ERROR_NAMES.has(name) || status === 401) return "auth";
  if (RESEND_RECIPIENT_ERROR_NAMES.has(name) || status === 403 || status === 422) {
    return "recipient";
  }
  if (status === 429 || status >= 500) return "network"; // retryable
  return "unknown";
}

function resendMessage(category: TransportErrorCategory): string {
  switch (category) {
    case "auth":
      return "Échec d'authentification Resend. Vérifiez la clé API et sa portée (sending / domain).";
    case "recipient":
      return (
        "Resend a rejeté l'envoi : le domaine de l'expéditeur n'est pas vérifié, " +
        "ou l'adresse d'envoi est invalide. Ajoutez et vérifiez votre domaine sur " +
        "https://resend.com/domains, puis utilisez une adresse « from » sur ce " +
        "domaine (Resend n'autorise pas les envois depuis gmail.com / outlook.com / etc.)."
      );
    case "network":
      return "Erreur temporaire du fournisseur Resend. Le message sera retenté.";
    case "timeout":
      return "Resend a mis trop de temps à répondre.";
    case "tls":
    case "unknown":
    default:
      return "Échec de l'envoi via Resend. Vérifiez la configuration puis réessayez.";
  }
}

/**
 * Verify that the configured Resend API key is accepted by the API.
 * Uses `domains.list()` because it's the cheapest authenticated call and
 * works for full-access keys. Restricted (sending-only) keys deliberately
 * cannot list domains — that response is treated as SUCCESS on the
 * grounds that the key IS valid, just scoped down for production use.
 */
export async function verifyResend(cfg: SmtpConfig): Promise<VerifyResult> {
  if (!cfg.resendApiKey) {
    return {
      ok: false,
      message: "Clé API Resend absente. Enregistrez-la avant de tester.",
      category: "auth"
    };
  }
  const resend = new Resend(cfg.resendApiKey);
  try {
    const { error } = await resend.domains.list();
    if (!error) return { ok: true };
    const name = (error.name ?? "").toLowerCase();
    if (RESEND_RESTRICTED_KEY_NAMES.has(name)) {
      // Sending-only key. Valid — send will still work.
      return { ok: true };
    }
    const category = classifyResend(error);
    return { ok: false, message: resendMessage(category), category };
  } catch {
    // Network / DNS / abort — never leak the underlying stack.
    return { ok: false, message: resendMessage("network"), category: "network" };
  }
}

export async function sendViaResend(
  cfg: SmtpConfig,
  message: SendMessage
): Promise<SendResult> {
  if (!cfg.resendApiKey) {
    return {
      ok: false,
      message: "Clé API Resend absente.",
      category: "auth",
      retryable: false
    };
  }
  const resend = new Resend(cfg.resendApiKey);
  // Compose the From line RFC-2822-style so nodemailer-formatted "Name <email>"
  // works identically on both providers.
  const from = cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail;
  const to = message.toName
    ? `${message.toName} <${message.to}>`
    : message.to;
  try {
    const { data, error } = await resend.emails.send(
      {
        from,
        to,
        subject: message.subject,
        text: message.text,
        html: message.html ?? undefined,
        replyTo: cfg.replyTo ?? undefined,
        headers: message.headers
      },
      // Resend accepts an idempotency key at the request layer so a
      // retried claim of the same outbox row cannot cause a double-send.
      message.idempotencyKey
        ? { idempotencyKey: message.idempotencyKey }
        : undefined
    );
    if (error) {
      const category = classifyResend(error);
      return {
        ok: false,
        message: resendMessage(category),
        category,
        // auth / recipient are permanent; everything else is transient.
        retryable: category !== "auth" && category !== "recipient"
      };
    }
    return { ok: true, providerMsgId: data?.id ?? null };
  } catch {
    return {
      ok: false,
      message: resendMessage("network"),
      category: "network",
      retryable: true
    };
  }
}

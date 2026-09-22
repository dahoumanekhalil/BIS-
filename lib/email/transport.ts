import "server-only";

import nodemailer, { type Transporter, type SendMailOptions } from "nodemailer";
import type { SmtpConfig } from "./config";

// ─── SMTP transport factory ──────────────────────────────────────────────
//
// Wraps nodemailer with the project's provider-agnostic SmtpConfig shape.
// Every call to `sendMail`/`verifyConnection` MUST go through this module
// — no direct nodemailer usage anywhere else in the codebase — so the SMTP
// password never leaks into another abstraction layer that might log it.
//
// The transporter is not cached across requests. Nodemailer's pooling is
// per-transporter, and a cached instance would defeat the "config change
// takes effect immediately" property of the admin settings page.

function toTransportOptions(cfg: SmtpConfig) {
  const secure = cfg.encryption === "ssl";
  const requireStarttls = cfg.encryption === "starttls";
  return {
    host: cfg.host,
    port: cfg.port,
    secure,
    requireTLS: requireStarttls,
    ignoreTLS: cfg.encryption === "none",
    connectionTimeout: cfg.connectionTimeoutMs,
    greetingTimeout: cfg.connectionTimeoutMs,
    socketTimeout: cfg.connectionTimeoutMs,
    // nodemailer's default `disableFileAccess` is false; we set it true so
    // attachments cannot reference local files. Belt-and-braces — no
    // codepath in this app builds attachments today.
    disableFileAccess: true,
    disableUrlAccess: true,
    auth:
      cfg.authEnabled && cfg.username
        ? {
            user: cfg.username,
            pass: cfg.password ?? ""
          }
        : undefined
  } as const;
}

/**
 * Build a fresh transporter from the given config. Never logs credentials.
 */
export function buildTransporter(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport(toTransportOptions(cfg));
}

/**
 * Attempt to establish a connection and (when auth is enabled) authenticate.
 * Returns a boolean success + a sanitized error message on failure.
 *
 * We deliberately strip any SMTP server chatter that might contain the
 * username or contain internal server info. The admin UI must not display
 * raw SMTP responses.
 */
export async function verifyConnection(cfg: SmtpConfig): Promise<
  | { ok: true }
  | { ok: false; message: string; category: TransportErrorCategory }
> {
  const transporter = buildTransporter(cfg);
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    const category = classify(err);
    return { ok: false, message: friendlyMessage(category), category };
  } finally {
    transporter.close();
  }
}

export type TransportErrorCategory =
  | "auth"
  | "network"
  | "tls"
  | "timeout"
  | "recipient"
  | "unknown";

function classify(err: unknown): TransportErrorCategory {
  const code = (err as { code?: string; responseCode?: number })?.code;
  const responseCode = (err as { responseCode?: number })?.responseCode;
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534) return "auth";
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ENOTFOUND") return "network";
  if (code === "ETIMEDOUT" || code === "ESOCKET") return "timeout";
  if (code === "EPROTOCOL" || code === "ETLS") return "tls";
  if (
    responseCode === 550 ||
    responseCode === 553 ||
    responseCode === 554
  ) return "recipient";
  return "unknown";
}

function friendlyMessage(category: TransportErrorCategory): string {
  switch (category) {
    case "auth":
      return "Échec de l'authentification SMTP. Vérifiez le nom d'utilisateur et le mot de passe.";
    case "network":
      return "Impossible de joindre le serveur SMTP. Vérifiez le host et le port.";
    case "timeout":
      return "Le serveur SMTP a mis trop de temps à répondre. Vérifiez la connectivité réseau.";
    case "tls":
      return "Échec de la négociation TLS. Vérifiez le mode de chiffrement (STARTTLS / SSL / aucun).";
    case "recipient":
      return "Le serveur SMTP a rejeté le destinataire. Vérifiez l'adresse d'envoi et l'expéditeur.";
    case "unknown":
    default:
      return "Échec de connexion SMTP. Vérifiez la configuration puis réessayez.";
  }
}

export type SendResult =
  | { ok: true; providerMsgId: string | null }
  | {
      ok: false;
      message: string;
      category: TransportErrorCategory;
      retryable: boolean;
    };

/**
 * Send a single message. The caller (email service) is responsible for
 * writing outcome fields to the outbox row. This function is intentionally
 * dumb — it does not touch the DB.
 *
 * Retryability rule of thumb:
 *   • auth / recipient    → NOT retryable (config or address is wrong).
 *   • network / timeout   → retryable (transient).
 *   • tls / unknown       → retryable-once (may be transient).
 */
export async function sendMail(
  cfg: SmtpConfig,
  message: {
    to: string;
    toName?: string | null;
    subject: string;
    html?: string | null;
    text: string;
    headers?: Record<string, string>;
  }
): Promise<SendResult> {
  const transporter = buildTransporter(cfg);
  try {
    const opts: SendMailOptions = {
      from: message.toName
        ? { name: cfg.fromName, address: cfg.fromEmail }
        : { name: cfg.fromName, address: cfg.fromEmail },
      to: message.toName
        ? { name: message.toName, address: message.to }
        : message.to,
      subject: message.subject,
      text: message.text,
      html: message.html ?? undefined,
      replyTo: cfg.replyTo ?? undefined,
      headers: message.headers
    };
    const info = await transporter.sendMail(opts);
    return { ok: true, providerMsgId: info.messageId ?? null };
  } catch (err) {
    const category = classify(err);
    return {
      ok: false,
      message: friendlyMessage(category),
      category,
      retryable: category === "network" || category === "timeout" || category === "tls" || category === "unknown"
    };
  } finally {
    transporter.close();
  }
}

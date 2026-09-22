import "server-only";

import nodemailer, { type Transporter, type SendMailOptions } from "nodemailer";
import type { SmtpConfig } from "../config";
import type {
  SendMessage,
  SendResult,
  TransportErrorCategory,
  VerifyResult
} from "./types";

// ─── SMTP provider (nodemailer) ──────────────────────────────────────────
//
// Historic transport. This module contains the nodemailer plumbing that
// used to live in `lib/email/transport.ts` — the dispatcher now sits in
// `transport.ts` (re-exporting from `providers/index.ts`) so every caller
// keeps its existing import path.
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

export function buildTransporter(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport(toTransportOptions(cfg));
}

export async function verifySmtp(cfg: SmtpConfig): Promise<VerifyResult> {
  const transporter = buildTransporter(cfg);
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    const category = classify(err);
    return { ok: false, message: smtpMessage(category), category };
  } finally {
    transporter.close();
  }
}

export async function sendViaSmtp(
  cfg: SmtpConfig,
  message: SendMessage
): Promise<SendResult> {
  const transporter = buildTransporter(cfg);
  try {
    const opts: SendMailOptions = {
      from: { name: cfg.fromName, address: cfg.fromEmail },
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
      message: smtpMessage(category),
      category,
      retryable:
        category === "network" ||
        category === "timeout" ||
        category === "tls" ||
        category === "unknown"
    };
  } finally {
    transporter.close();
  }
}

function classify(err: unknown): TransportErrorCategory {
  const code = (err as { code?: string; responseCode?: number })?.code;
  const responseCode = (err as { responseCode?: number })?.responseCode;
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534) return "auth";
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ENOTFOUND") return "network";
  if (code === "ETIMEDOUT" || code === "ESOCKET") return "timeout";
  if (code === "EPROTOCOL" || code === "ETLS") return "tls";
  if (responseCode === 550 || responseCode === 553 || responseCode === 554) return "recipient";
  return "unknown";
}

function smtpMessage(category: TransportErrorCategory): string {
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

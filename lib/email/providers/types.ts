import "server-only";

// ─── Cross-provider transport types ──────────────────────────────────────
//
// Every provider (SMTP, Resend, …) implements the same two operations:
//
//   • verify(cfg)        → does the provider accept our credentials?
//   • send(cfg, message) → deliver one message, return a normalized result.
//
// The dispatcher in `providers/index.ts` picks the implementation based on
// `cfg.provider`. Callers (email service, admin trigger) MUST use the
// dispatcher — never a provider module directly — so provider selection
// remains a single choke-point.

export type TransportErrorCategory =
  | "auth"
  | "network"
  | "tls"
  | "timeout"
  | "recipient"
  | "unknown";

export type VerifyResult =
  | { ok: true }
  | { ok: false; message: string; category: TransportErrorCategory };

export type SendMessage = {
  to: string;
  toName?: string | null;
  subject: string;
  html?: string | null;
  text: string;
  headers?: Record<string, string>;
  // Reused as the provider-level idempotency key when the provider supports
  // one (Resend does; SMTP does not — nodemailer emits a random Message-ID).
  // The application-level dedupe still lives in `EmailMessage.idempotencyKey`
  // (see lib/email/queue.ts), so this is a belt-and-braces guard against a
  // double-delivery when the same outbox row is claimed twice.
  idempotencyKey?: string | null;
};

export type SendResult =
  | { ok: true; providerMsgId: string | null }
  | {
      ok: false;
      message: string;
      category: TransportErrorCategory;
      retryable: boolean;
    };

// Human-readable sanitized error text. Providers MUST NOT leak raw server
// responses, headers, or credentials through this string — the admin UI
// surfaces it directly.
export function friendlyMessage(category: TransportErrorCategory): string {
  switch (category) {
    case "auth":
      return "Échec de l'authentification. Vérifiez les identifiants du fournisseur.";
    case "network":
      return "Impossible de joindre le fournisseur email. Vérifiez la connectivité réseau.";
    case "timeout":
      return "Le fournisseur email a mis trop de temps à répondre.";
    case "tls":
      return "Échec de la négociation TLS.";
    case "recipient":
      return "Le fournisseur email a rejeté le destinataire ou l'expéditeur.";
    case "unknown":
    default:
      return "Échec de l'envoi. Vérifiez la configuration puis réessayez.";
  }
}

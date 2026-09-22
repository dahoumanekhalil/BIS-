import "server-only";

import type { SmtpConfig } from "../config";
import type { SendMessage, SendResult, VerifyResult } from "./types";
import { sendViaSmtp, verifySmtp } from "./smtp";
import { sendViaResend, verifyResend } from "./resend";

// ─── Provider dispatcher ─────────────────────────────────────────────────
//
// Single choke-point that routes every send / verify call to the active
// provider. The rest of the codebase imports `sendMail` / `verifyConnection`
// from `lib/email/transport` (a thin re-export of these functions), so
// swapping or adding a provider is a one-file change here.
//
// Callers MUST NOT bypass this dispatcher — doing so would let a feature
// silently pin itself to one provider and defeat the abstraction.

export async function verifyProviderConnection(
  cfg: SmtpConfig
): Promise<VerifyResult> {
  switch (cfg.provider) {
    case "resend":
      return verifyResend(cfg);
    case "smtp":
    default:
      return verifySmtp(cfg);
  }
}

export async function sendViaProvider(
  cfg: SmtpConfig,
  message: SendMessage
): Promise<SendResult> {
  switch (cfg.provider) {
    case "resend":
      return sendViaResend(cfg, message);
    case "smtp":
    default:
      return sendViaSmtp(cfg, message);
  }
}

// Re-export common types so consumers of the dispatcher don't have to
// reach into the sibling files.
export type { SendMessage, SendResult, VerifyResult } from "./types";

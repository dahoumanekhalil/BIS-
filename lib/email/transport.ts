import "server-only";

import type { SmtpConfig } from "./config";
import {
  sendViaProvider,
  verifyProviderConnection
} from "./providers";
import type { SendMessage, SendResult, VerifyResult } from "./providers/types";

// ─── Transport facade ────────────────────────────────────────────────────
//
// Historically this file wrapped nodemailer directly. Providers now live
// under `lib/email/providers/*` and this module is a thin re-export so
// every existing importer (`lib/email/service.ts`, `lib/email/triggers/
// admin.ts`, admin actions) keeps its import path. Add a new provider by
// editing `providers/index.ts`, not this file.

export type { TransportErrorCategory } from "./providers/types";
export type SendResultType = SendResult; // legacy alias kept exported
// The imports below are re-exported so callers that used the old
// `import { SendResult, VerifyResult } from "./transport"` keep working.
export type { SendMessage, SendResult, VerifyResult };

export async function verifyConnection(cfg: SmtpConfig): Promise<VerifyResult> {
  return verifyProviderConnection(cfg);
}

export async function sendMail(
  cfg: SmtpConfig,
  message: SendMessage
): Promise<SendResult> {
  return sendViaProvider(cfg, message);
}

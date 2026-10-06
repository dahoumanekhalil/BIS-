"use server";

import { requireAccount } from "@/lib/account/auth";

// ─── Subscriber QR policy ────────────────────────────────────────────────
//
// A subscriber has ONE persistent QR and can only VIEW it (server-rendered
// on /compte/badge). Subscribers can NOT regenerate, rotate, replace,
// revoke or create a credential — that is an administrative operation
// (`regenerateBadgeAsAdminAction`, permission `badge.regenerate`).
//
// This export is intentionally kept as a hard-denying stub (instead of being
// deleted) so that a replayed or crafted call to the former self-service
// action gets an explicit business error rather than an opaque failure. It
// performs NO credential mutation, imports no badge service, and writes
// nothing (no audit write: an authenticated caller could otherwise flood the
// audit table by looping on it).

export type BadgeGenerationResult = {
  ok: false;
  reason: "FORBIDDEN";
  message: string;
};

export async function generateOrRotateMyBadge(): Promise<BadgeGenerationResult> {
  await requireAccount();
  return {
    ok: false,
    reason: "FORBIDDEN",
    message:
      "Votre QR code est permanent et ne peut pas être régénéré. Contactez l'équipe BIS si vous pensez qu'il doit être remplacé."
  };
}

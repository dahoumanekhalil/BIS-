import "server-only";

import { prisma } from "@/lib/db";
import type { Participant } from "@prisma/client";
import type { CurrentAccount } from "@/lib/account/auth";
import { issueBadgeCredential } from "@/lib/badge";
import { BadgeError } from "@/lib/badge/errors";
import { audit } from "@/lib/admin/audit";

// Shared server helpers for the new role-based registration flows.
//
// Every role flow (Visitor / Speaker / Sponsor / Partner / Content Creator)
// funnels through the same three steps:
//   1. ensureParticipantForAccount — reuse or create the Participant tied
//      to the AccountUser for the current event. Never duplicates.
//   2. ensureActiveBadge — eagerly issue a BadgeCredential if the
//      participant does not yet have one. Idempotent + race-safe.
//   3. Role-specific business logic (Application creation, participation
//      choice, etc.) — belongs to the caller.
//
// This module is intentionally small. All decisions about *which* fields
// to write on the Participant + *which* Application to create belong to
// the role-specific server action.

export type EnsureResult =
  | { kind: "ready"; participant: Participant }
  | { kind: "conflict" }
  | { kind: "no-event" };

/**
 * Reuse the AccountUser's existing Participant (matched by
 * `accountUserId`) or create a fresh one. Never matches on email alone
 * (that would let a malicious signup hijack a legacy anonymous
 * Participant — the claim flow in `lib/account/email-verification.ts`
 * is the only path that binds an anonymous Participant to an
 * AccountUser, and only after email-ownership proof).
 *
 * Race-safe: if two concurrent requests both try to bootstrap the
 * Participant, the DB `@@unique([eventId, email])` catches the loser
 * and we re-fetch by `accountUserId`.
 */
export async function ensureParticipantForAccount(
  account: CurrentAccount
): Promise<EnsureResult> {
  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (!event) return { kind: "no-event" };

  const existing = await prisma.participant.findFirst({
    where: { eventId: event.id, accountUserId: account.id }
  });
  if (existing) return { kind: "ready", participant: existing };

  try {
    const created = await prisma.participant.create({
      data: {
        eventId: event.id,
        accountUserId: account.id,
        firstName: account.firstName,
        lastName: account.lastName,
        email: account.email,
        phone: null,
        country: "Algérie",
        registrationType: "ATTENDEE",
        status: "REGISTERED",
        profile: "VISITOR"
      }
    });
    return { kind: "ready", participant: created };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      // Either a concurrent request from the same AccountUser just created
      // the Participant (safe to re-fetch) or an anonymous Participant
      // already claims this (eventId, email) pair. The anonymous case is
      // the "conflict" surface — the claim flow handles binding.
      const raced = await prisma.participant.findFirst({
        where: { eventId: event.id, accountUserId: account.id }
      });
      if (raced) return { kind: "ready", participant: raced };
      return { kind: "conflict" };
    }
    throw err;
  }
}

/**
 * First issuance only. Ensure a Participant that has NO credential history
 * gets its persistent ACTIVE BadgeCredential. Idempotent — if one already
 * exists, or the participant has any history (revoked), this does nothing.
 * Errors are swallowed and logged: issuance must NEVER be the reason a
 * registration action fails (/compte/badge retries first issuance).
 *
 * SECURITY: the raw token is deliberately discarded here. It is derived
 * again (identically) on demand by the auth-gated /compte/badge page.
 */
export async function ensureActiveBadge(participantId: string): Promise<void> {
  // The QR is issued only AFTER the account's email is verified. A
  // participant bound to an unverified account gets nothing yet; issuance
  // happens when the verification link is consumed. Participants with no
  // account (admin-created / legacy anonymous) are not gated.
  const owner = await prisma.participant.findUnique({
    where: { id: participantId },
    select: {
      accountUserId: true,
      accountUser: { select: { emailVerifiedAt: true } }
    }
  });
  if (!owner) return;
  if (owner.accountUserId && !owner.accountUser?.emailVerifiedAt) return;

  const existing = await prisma.badgeCredential.findFirst({
    where: { participantId, status: "ACTIVE" },
    select: { id: true }
  });
  if (existing) return;

  try {
    await issueBadgeCredential(participantId);
  } catch (err) {
    if (
      err instanceof BadgeError &&
      (err.code === "ACTIVE_EXISTS" || err.code === "HISTORY_EXISTS")
    ) {
      // ACTIVE_EXISTS: concurrent issue won the race — nothing to do.
      // HISTORY_EXISTS: the participant has credential history (e.g. an
      // admin revoked it). Registration must NEVER silently re-issue —
      // only an administrator may replace a revoked credential.
      return;
    }
    // Non-fatal: audit and swallow. /compte/badge retries the first
    // issuance on the next visit (it never replaces an existing one).
    // eslint-disable-next-line no-console
    console.warn(
      "[register] ensureActiveBadge failed (non-fatal):",
      err instanceof BadgeError ? err.code : "unexpected"
    );
    await audit({
      action: "badge.issue.failed",
      entity: "Participant",
      entityId: participantId,
      meta: { reason: err instanceof BadgeError ? err.code : "unexpected" }
    }).catch(() => undefined);
  }
}

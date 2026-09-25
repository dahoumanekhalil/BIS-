import "server-only";

import { cache } from "react";
import { prisma } from "@/lib/db";
import type { CurrentAccount } from "@/lib/account/auth";

// Loads the current AccountUser's Participant row along with just the fields
// the /compte tree needs. React's `cache()` dedupes the call across a single
// server render, so the layout + every child page share one DB round-trip.
//
// SECURITY — we deliberately do NOT `select` internal secrets even where a
// call site would ignore them: no `passwordHash`, no `tokenHash`, no session
// tokens, no other participants' rows. Every field returned from here is
// safe to surface in the attendee UI.
//
// The returned Participant may be null: an AccountUser can exist without a
// Participant if they signed up but never touched /register. Callers must
// handle that case.
export const getParticipantForAccount = cache(async (accountId: string) => {
  return prisma.participant.findFirst({
    where: { accountUserId: accountId },
    orderBy: { createdAt: "desc" },
    select: {
      // Internal id — used only server-side (e.g. to scope CheckIn queries
      // by ownership). MUST NOT be rendered into the attendee-facing DOM.
      id: true,
      // Identity fields the attendee can already see about themselves —
      // safe to surface.
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      country: true,
      organization: true,
      jobTitle: true,
      companyIndustry: true,
      companyWebsite: true,
      companySize: true,

      // Registration state.
      // Payment-removal Phase 3: `paymentStatus` removed alongside the
      // Prisma column drop.
      registrationType: true,
      participationChoice: true,
      profile: true,
      status: true,
      createdAt: true,
      // Phase 18 — attendee badge role variants read from `tier`.
      // Additive whitelist entry; never exposes sensitive fields.
      tier: true,

      // Ticket surface — attendee-visible.
      ticketCode: true,
      // Phase 19 — human-readable text check-in code. Displayed on
      // the attendee's own badge (own participant, safe surface).
      // Never rendered in cross-participant queries and never in
      // audit metadata.
      checkinCode: true,
      checkedInAt: true,

      // Active credential — status only. tokenHash is deliberately NOT
      // selected. Only ACTIVE is included so the UI does not have to filter
      // through revoked history.
      credentials: {
        where: { status: "ACTIVE" },
        take: 1,
        select: { status: true, issuedAt: true, expiresAt: true }
      },

      // Room access matrix — TRI-STATE semantics (do not filter here):
      //   • row present, granted=true  → authorized
      //   • row present, granted=false → explicitly denied / revoked
      //   • no row at all              → not granted (default deny)
      //
      // Callers MUST distinguish "row with granted=false" from "no row" —
      // both mean access is refused today, but they reflect different
      // administrative history. Filtering to granted=true here would
      // collapse the two into one state and silently paint every ungranted
      // point as if it had never been considered.
      accessPermissions: {
        select: { accessPointId: true, granted: true }
      },

      // Professional applications submitted by this participant.
      applications: {
        select: {
          type: true,
          status: true,
          reviewedAt: true,
          createdAt: true
          // reviewNotes is admin-facing and MUST NOT be exposed here.
        },
        orderBy: { createdAt: "desc" }
      }
    }
  });
});

export type ComptePageParticipant = NonNullable<
  Awaited<ReturnType<typeof getParticipantForAccount>>
>;

// Loaded once per request via cache(): all AccessPoints in display order.
// Server components use this to render the per-participant matrix.
//
// Sub-Phase D — the room registration UI needs `admissionMode` +
// `priceMinor` + `currency` to render the FREE vs PAID controls. These
// are additive whitelist entries; nothing sensitive is exposed
// (priceMinor + currency are already visible on the admin spaces page,
// and the attendee needs the price to make an informed decision).
export const listAccessPoints = cache(async () => {
  return prisma.accessPoint.findMany({
    where: { active: true },
    orderBy: [{ type: "asc" }, { order: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      admissionMode: true,
      priceMinor: true,
      currency: true
    }
  });
});

// Sub-Phase D — attendee-facing snapshot of the participant's room
// registrations. Returned by the compte context alongside the access
// matrix so the UI can render:
//   • FREE room, no registration    → "S'inscrire" button
//   • FREE room, FREE_CONFIRMED     → "Inscrit" state
//   • PAID room, no registration    → "Réserver — <price>" button
//   • PAID room, PENDING_PAYMENT    → "En attente de paiement" state
//   • PAID room, PAID               → "Inscription confirmée" state
//   • terminal states (CANCELLED / REFUNDED / PAYMENT_FAILED /
//     EXPIRED) → surfaced with a "Réinscrire" call (REFUNDED excepted
//     — the state machine refuses reactivation there).
//
// Whitelist select — snapshot only. No paymentRef (that is a
// trusted-provider identifier the attendee has no reason to see), no
// audit metadata, no admin fields.
export const listMyRoomRegistrations = cache(
  async (participantId: string) => {
    return prisma.roomRegistration.findMany({
      where: { participantId },
      select: {
        accessPointId: true,
        status: true,
        priceMinorSnapshot: true,
        currencySnapshot: true,
        registeredAt: true,
        paidAt: true,
        cancelledAt: true,
        refundedAt: true,
        failedAt: true,
        expiresAt: true
      }
    });
  }
);

export type MyRoomRegistration = Awaited<
  ReturnType<typeof listMyRoomRegistrations>
>[number];

// Attendee-facing CheckIn history (Phase 6). Scoped strictly by
// participantId — the caller MUST pass an id already resolved server-side
// from the current session (never from a client-supplied value). React's
// `cache()` dedupes across a single request render.
//
// SECURITY:
//   • Query is `where: { participantId }`. There is no code path in this
//     function that reads a URL / query-string / form input.
//   • Select whitelist deliberately excludes: `id`, `participantId`,
//     `operatorId`, `credentialId`, `ticketCode`, `gate` (legacy), and
//     `reason` (admin-facing free text that may include internal notes).
//   • Bounded by `take: BOUND`. An attendee is expected to have far fewer
//     scan events than this over a 3-day event, but the cap guards
//     against unbounded rendering costs on the server.
//
// A CheckIn with `accessPoint = null` is a legacy scan (pre-Phase-1) —
// UI callers should render a neutral label; DO NOT infer or invent an
// access point from the legacy `gate` string.
const CHECKIN_HISTORY_BOUND = 50;

export const getCheckInHistoryForParticipant = cache(
  async (participantId: string) => {
    return prisma.checkIn.findMany({
      where: { participantId },
      orderBy: { scannedAt: "desc" },
      take: CHECKIN_HISTORY_BOUND,
      select: {
        scannedAt: true,
        result: true,
        accessPoint: {
          select: { slug: true, name: true, type: true }
        }
      }
    });
  }
);

export type CheckInHistoryItem = Awaited<
  ReturnType<typeof getCheckInHistoryForParticipant>
>[number];

// Bundle everything the /compte tree needs into one cached call. Convenient
// for pages that need multiple pieces without threading the AccountUser id
// through every helper.
//
// Sub-Phase D — includes `roomRegistrations` when a Participant exists so
// the room-registration UI can render per-room state without a second
// round-trip. When no Participant is bound to the account, the list is
// an empty array (nothing to render).
export const getCompteContext = cache(async (account: CurrentAccount) => {
  const [participant, accessPoints] = await Promise.all([
    getParticipantForAccount(account.id),
    listAccessPoints()
  ]);
  const roomRegistrations = participant
    ? await listMyRoomRegistrations(participant.id)
    : [];
  return { account, participant, accessPoints, roomRegistrations };
});

export type CompteContext = Awaited<ReturnType<typeof getCompteContext>>;

// Tri-state helper is defined in a react-free companion file so tests can
// import it under plain Node (without Next.js's React runtime). Re-exported
// here so consumers who already pull from `participant.ts` don't need a
// second import statement.
export { accessStateFor, type AccessState } from "./access-state";

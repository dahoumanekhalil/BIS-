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
      registrationType: true,
      participationChoice: true,
      profile: true,
      status: true,
      paymentStatus: true,
      createdAt: true,

      // Ticket surface — attendee-visible.
      ticketCode: true,
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
export const listAccessPoints = cache(async () => {
  return prisma.accessPoint.findMany({
    where: { active: true },
    orderBy: [{ type: "asc" }, { order: "asc" }],
    select: { id: true, slug: true, name: true, type: true }
  });
});

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
export const getCompteContext = cache(async (account: CurrentAccount) => {
  const [participant, accessPoints] = await Promise.all([
    getParticipantForAccount(account.id),
    listAccessPoints()
  ]);
  return { account, participant, accessPoints };
});

export type CompteContext = Awaited<ReturnType<typeof getCompteContext>>;

// Tri-state helper is defined in a react-free companion file so tests can
// import it under plain Node (without Next.js's React runtime). Re-exported
// here so consumers who already pull from `participant.ts` don't need a
// second import statement.
export { accessStateFor, type AccessState } from "./access-state";

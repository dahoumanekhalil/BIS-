import "server-only";

import { prisma } from "@/lib/db";
import {
  PaymentStatus,
  RegistrationStatus,
  type RegistrationTier
} from "@prisma/client";

export async function getAdminOverview() {
  const [
    totalRegistrants,
    checkedIn,
    pending,
    cancelled,
    paid,
    unpaid,
    tierCounts,
    revenueAgg,
    gateCounts,
    recentRegistrants,
    recentCheckIns,
    upcomingSessions,
    speakerCount,
    sponsorCount
  ] = await Promise.all([
    prisma.participant.count(),
    prisma.participant.count({ where: { checkedInAt: { not: null } } }),
    // "En attente de confirmation" — post-refactor this reads the new
    // REGISTERED status. Legacy PENDING rows are counted alongside during
    // the transition window so the dashboard count stays continuous while
    // scripts/migrate-pending-to-registered.ts runs on prod.
    prisma.participant.count({
      where: {
        status: {
          in: [RegistrationStatus.REGISTERED, RegistrationStatus.PENDING]
        }
      }
    }),
    prisma.participant.count({
      where: { status: RegistrationStatus.CANCELLED }
    }),
    prisma.participant.count({ where: { paymentStatus: PaymentStatus.PAID } }),
    prisma.participant.count({
      where: { paymentStatus: { in: [PaymentStatus.UNPAID, PaymentStatus.PENDING] } }
    }),
    prisma.participant.groupBy({
      by: ["tier"],
      _count: { _all: true }
    }),
    prisma.participant.aggregate({
      _sum: { paymentAmount: true },
      where: { paymentStatus: PaymentStatus.PAID }
    }),
    prisma.participant.groupBy({
      by: ["checkedInGate"],
      _count: { _all: true },
      where: { checkedInAt: { not: null } }
    }),
    prisma.participant.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        tier: true,
        paymentStatus: true,
        status: true,
        createdAt: true
      }
    }),
    prisma.checkIn.findMany({
      orderBy: { scannedAt: "desc" },
      take: 6,
      include: {
        participant: {
          select: { firstName: true, lastName: true, tier: true }
        }
      }
    }),
    prisma.session.findMany({
      where: { startsAt: { gte: new Date("2027-01-01") } },
      orderBy: { startsAt: "asc" },
      take: 4,
      include: { space: true }
    }),
    prisma.speaker.count(),
    prisma.partner.count()
  ]);

  const tierMap = new Map<RegistrationTier | null, number>();
  for (const row of tierCounts) tierMap.set(row.tier, row._count._all);

  const gateMap = new Map<string | null, number>();
  for (const row of gateCounts) gateMap.set(row.checkedInGate, row._count._all);

  return {
    totalRegistrants,
    checkedIn,
    pending,
    cancelled,
    paid,
    unpaid,
    revenue: revenueAgg._sum.paymentAmount ?? 0,
    tierCounts: tierMap,
    gateCounts: gateMap,
    recentRegistrants,
    recentCheckIns,
    upcomingSessions,
    speakerCount,
    sponsorCount
  };
}

// Payment-removal Phase 2: the `payment` filter has been removed from
// the admin registrants list. `paymentRef` is also no longer used as
// a search key. The Prisma columns still exist as legacy storage.
export type RegistrantFilters = {
  q?: string;
  tier?: RegistrationTier | "ALL";
  status?: RegistrationStatus | "ALL";
  gate?: string | "ALL";
  page?: number;
  pageSize?: number;
};

export async function listRegistrants(filters: RegistrantFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));

  const where: NonNullable<
    Parameters<typeof prisma.participant.findMany>[0]
  >["where"] = {};

  if (filters.q) {
    where.OR = [
      { firstName: { contains: filters.q, mode: "insensitive" } },
      { lastName: { contains: filters.q, mode: "insensitive" } },
      { email: { contains: filters.q, mode: "insensitive" } },
      { ticketCode: { contains: filters.q, mode: "insensitive" } }
    ];
  }
  if (filters.tier && filters.tier !== "ALL") where.tier = filters.tier;
  if (filters.status && filters.status !== "ALL") where.status = filters.status;
  if (filters.gate && filters.gate !== "ALL") where.gate = filters.gate;

  const [items, total] = await Promise.all([
    prisma.participant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        tier: true,
        gate: true,
        status: true,
        checkedInAt: true,
        createdAt: true,
        ticketCode: true
      }
    }),
    prisma.participant.count({ where })
  ]);

  return { items, total, page, pageSize };
}

export async function getRegistrant(id: string) {
  return prisma.participant.findUnique({
    where: { id },
    // Phase 19 note — `checkinCode` is on Participant and returned by
    // the default findUnique select, so no additional wiring is
    // required on this include. The registrant detail page reads
    // r.checkinCode directly.
    include: {
      checkIns: {
        orderBy: { scannedAt: "desc" },
        // Phase 16 — join AccessPoint so the registrant history can
        // show the human-readable point name (e.g. "Salle 03") in
        // addition to the legacy `gate` string. Whitelist select —
        // no admin-internal fields (createdAt/updatedAt) leak here.
        include: {
          operator: { select: { name: true, email: true } },
          accessPoint: {
            select: { slug: true, name: true, type: true, active: true }
          }
        },
        take: 20
      }
    }
  });
}

// Phase 9 — resolve an AccessPoint from its URL slug for the scanner
// route. Returns null when the slug does not resolve — the caller MUST
// treat that as a clean refusal (notFound) rather than fabricating a
// point. `active` is returned as-is so the caller can render a specific
// "disabled" refusal state distinct from "not found".
//
// SECURITY: whitelist select — id/slug/name/type/active only. No
// relations, no counts, no timestamps needed at this call site. Every
// scanner request re-hits this helper (no in-process cache), so a slug
// rename or a deactivation takes effect immediately.
export async function getAccessPointBySlug(slug: string) {
  return prisma.accessPoint.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      active: true
    }
  });
}

// Phase 8 — Access-points administration list.
//
// Returns every AccessPoint in the DB (active AND inactive; admins need to
// see deactivated points so they can re-enable them) with the counts of
// linked rows that gate destructive operations:
//   • checkInCount   — protects slug rename AND full delete
//   • permissionCount — protects full delete (Cascade would wipe grant
//                      history for this point)
//
// The counts feed the UI's Enable/Disable/Rename/Delete affordances and
// the server actions re-verify them before mutating — the UI number is
// UX only.
export async function getAccessPointsWithUsage() {
  const rows = await prisma.accessPoint.findMany({
    orderBy: [{ type: "asc" }, { order: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      active: true,
      order: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { checkIns: true, permissions: true }
      }
    }
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    type: r.type,
    active: r.active,
    order: r.order,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    checkInCount: r._count.checkIns,
    permissionCount: r._count.permissions
  }));
}

// Sub-Phase E — Admin room-registrations panel loader.
//
// Returns every RoomRegistration for a participant, joined to its
// AccessPoint (name/slug/admission mode/price/currency/active) and the
// current ParticipantAccess row for the same pair. The panel displays
// each registration's status, frozen price snapshot, lifecycle dates,
// plus whether the corresponding room access is currently effective
// AND whether that access is owned by REGISTRATION or ADMIN (Sub-Phase
// D's ownership boundary). The service actions remain the trusted
// authorization boundary — this loader is read-only.
//
// SECURITY: whitelist select. Internal counters, `updatedAt`, and any
// PII beyond what Participant/AccessPoint already exposes are excluded.
// `RoomPaymentEvent` history is NOT joined here — the AuditLog and the
// existing /logs page cover per-transition history without dumping raw
// provider references into the panel.
export async function getRegistrantRoomRegistrations(participantId: string) {
  const [registrations, permissions] = await Promise.all([
    prisma.roomRegistration.findMany({
      where: { participantId },
      orderBy: [{ registeredAt: "desc" }],
      select: {
        id: true,
        status: true,
        priceMinorSnapshot: true,
        currencySnapshot: true,
        paymentRef: true,
        registeredAt: true,
        paidAt: true,
        cancelledAt: true,
        refundedAt: true,
        failedAt: true,
        expiresAt: true,
        accessPoint: {
          select: {
            id: true,
            slug: true,
            name: true,
            admissionMode: true,
            active: true
          }
        }
      }
    }),
    prisma.participantAccess.findMany({
      where: { participantId },
      select: { accessPointId: true, granted: true, source: true }
    })
  ]);

  const permMap = new Map(
    permissions.map((p) => [p.accessPointId, p] as const)
  );
  return registrations.map((r) => ({
    id: r.id,
    status: r.status,
    priceMinorSnapshot: r.priceMinorSnapshot,
    currencySnapshot: r.currencySnapshot,
    paymentRef: r.paymentRef,
    registeredAt: r.registeredAt,
    paidAt: r.paidAt,
    cancelledAt: r.cancelledAt,
    refundedAt: r.refundedAt,
    failedAt: r.failedAt,
    expiresAt: r.expiresAt,
    accessPoint: r.accessPoint,
    access: permMap.get(r.accessPoint.id) ?? null
  }));
}

export type AdminRoomRegistrationRow = Awaited<
  ReturnType<typeof getRegistrantRoomRegistrations>
>[number];

// Phase 7 — admin access-control context for the registrant detail page.
// Returns everything the Badge panel + Access matrix need in a single
// server round-trip, and NEVER selects `BadgeCredential.tokenHash`.
//
// Security notes:
//   • `tokenHash` is deliberately omitted from the credential select —
//     the admin surface only needs status/timestamps, not the raw hash.
//   • Access permissions include `granted` so the tri-state (granted /
//     denied / unassigned) admin UI is possible.
//   • AccessPoint list is fetched separately so the UI can render every
//     seeded point, even ones with no ParticipantAccess row yet.
export async function getRegistrantAccessContext(participantId: string) {
  const [activeCredential, permissions, accessPoints] = await Promise.all([
    prisma.badgeCredential.findFirst({
      where: { participantId, status: "ACTIVE" },
      select: {
        id: true,
        status: true,
        issuedAt: true,
        expiresAt: true
      }
    }),
    prisma.participantAccess.findMany({
      where: { participantId },
      select: {
        accessPointId: true,
        granted: true,
        grantedAt: true,
        revokedAt: true
      }
    }),
    prisma.accessPoint.findMany({
      where: { active: true },
      orderBy: [{ type: "asc" }, { order: "asc" }],
      select: { id: true, slug: true, name: true, type: true }
    })
  ]);
  return { activeCredential, permissions, accessPoints };
}

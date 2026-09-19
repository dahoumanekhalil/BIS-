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
    prisma.participant.count({ where: { status: RegistrationStatus.PENDING } }),
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
      where: { startsAt: { gte: new Date("2026-01-01") } },
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

export type RegistrantFilters = {
  q?: string;
  tier?: RegistrationTier | "ALL";
  status?: RegistrationStatus | "ALL";
  payment?: PaymentStatus | "ALL";
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
      { ticketCode: { contains: filters.q, mode: "insensitive" } },
      { paymentRef: { contains: filters.q, mode: "insensitive" } }
    ];
  }
  if (filters.tier && filters.tier !== "ALL") where.tier = filters.tier;
  if (filters.status && filters.status !== "ALL") where.status = filters.status;
  if (filters.payment && filters.payment !== "ALL")
    where.paymentStatus = filters.payment;
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
        paymentStatus: true,
        paymentAmount: true,
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

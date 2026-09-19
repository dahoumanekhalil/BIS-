import "server-only";

import { prisma } from "@/lib/db";
import type { CheckInResult, Prisma } from "@prisma/client";

// Phase 16 — global scan-history query used by /admin/scan/history.
//
// Reads CheckIn (the canonical scan-event source; ParticipantAccess is
// per-room *permission*, NOT event history — never conflated here).
// Every projection is a whitelist select — no rawToken, no tokenHash,
// no passwordHash, no session material, no payment metadata. Sensitive
// admin-only free-text fields like `reason` are surfaced because the
// audience is already `checkin.view`-authorised admin operators.
//
// BOUNDS:
//   • Default page size: 50 rows.
//   • Hard maximum: 200 rows (`HISTORY_MAX`). A hostile query-string
//     cannot push the DB into rendering thousands of rows.
//   • Ordered `scannedAt desc` so recent activity is always the first
//     rows the browser paints.

const DEFAULT_TAKE = 50;
const HISTORY_MAX = 200;
const MIN_SEARCH_CHARS = 2;
const MAX_SEARCH_CHARS = 80;

export type ScanHistoryFilters = {
  from?: Date;
  to?: Date;
  accessPointId?: string;
  result?: CheckInResult;
  operatorId?: string;
  q?: string;
};

export async function getScanHistory(
  filters: ScanHistoryFilters,
  take = DEFAULT_TAKE
) {
  const takeN = Math.min(Math.max(take, 1), HISTORY_MAX);

  const where: Prisma.CheckInWhereInput = {};

  if (filters.from || filters.to) {
    where.scannedAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {})
    };
  }
  if (filters.accessPointId) where.accessPointId = filters.accessPointId;
  if (filters.result) where.result = filters.result;
  if (filters.operatorId) where.operatorId = filters.operatorId;

  if (filters.q) {
    const q = filters.q.trim();
    if (q.length >= MIN_SEARCH_CHARS && q.length <= MAX_SEARCH_CHARS) {
      where.participant = {
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { ticketCode: { contains: q, mode: "insensitive" } }
        ]
      };
    }
  }

  return prisma.checkIn.findMany({
    where,
    orderBy: { scannedAt: "desc" },
    take: takeN,
    select: {
      id: true,
      scannedAt: true,
      result: true,
      reason: true,
      // Legacy string field — kept for pre-Phase-1 rows that have no
      // accessPointId. Never rendered as authoritative identity — the
      // joined AccessPoint below is preferred.
      gate: true,
      accessPoint: {
        select: { id: true, slug: true, name: true, type: true }
      },
      participant: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          tier: true
        }
      },
      operator: {
        select: { id: true, name: true, email: true }
      }
    }
  });
}

// Facets used by the filter form. Same whitelist discipline.
export async function getScanHistoryFacets() {
  const [points, operators] = await Promise.all([
    prisma.accessPoint.findMany({
      orderBy: [{ type: "asc" }, { order: "asc" }],
      select: { id: true, slug: true, name: true, type: true, active: true }
    }),
    prisma.adminUser.findMany({
      where: { checkIns: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    })
  ]);
  return { points, operators };
}

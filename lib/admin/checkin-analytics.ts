import "server-only";

import { prisma } from "@/lib/db";
import {
  AccessPointType,
  CheckInResult,
  type Prisma
} from "@prisma/client";

// Check-in & Attendance Analytics — server-side aggregations.
//
// Contract & discipline:
//   • CheckIn is the ONLY source of truth for attendance. ParticipantAccess
//     answers "is authorised", CheckIn answers "actually entered".
//   • "Unique visitors" = COUNT(DISTINCT participantId) restricted to
//     result = VALID (and MAIN_ENTRANCE / a given ROOM depending on the
//     metric). ALREADY_CHECKED_IN / CANCELLED / UNKNOWN / WRONG_GATE /
//     WRONG_TIME are NEVER counted as visitors — they surface only in
//     operational rejection breakdowns.
//   • "Scans" = COUNT(CheckIn) rows matching the where clause. Never
//     conflated with visitors.
//   • All projections are whitelist `select`s — no rawToken, no
//     tokenHash, no passwordHash, no session material, no payment
//     amounts.
//   • Bounded row counts on any findMany that hydrates rows to the
//     browser (recent activity, detailed table). Aggregates use
//     groupBy / count so a large CheckIn table doesn't blow memory.

// Filter validation caps — deliberately narrow. Callers pass Zod-
// validated primitives; these caps are the second line of defence.
const RECENT_ACTIVITY_MAX = 30;
const DETAILED_TABLE_MAX = 200;
const HOURLY_ROWS_HARD_MAX = 200_000; // sanity cap for the bucket scan
const SPACE_DETAIL_ACTIVITY_MAX = 40; // per-space detail recent activity cap

// Event timezone. BIS 2027 takes place in Algiers (CIC Alger, 15–17
// Nov 2027), UTC+1. Every hour-of-day bucket, "today" / "yesterday"
// preset, and formatted hour label uses this timezone. Never
// `Date.getHours()` — that reads server-local time (typically UTC in
// prod), which drifts the "peak hour" by one hour and straddles
// midnight the wrong way.
export const EVENT_TIMEZONE = "Africa/Algiers";

// Returns the Africa/Algiers hour (0..23) of a Date.
export function algiersHour(d: Date): number {
  // `Intl.DateTimeFormat` is the only reliable Node-and-browser way
  // to project a Date into a fixed IANA zone without pulling a
  // dependency. `hour12: false` guarantees a 0..23 string.
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: EVENT_TIMEZONE,
    hour: "2-digit",
    hour12: false
  }).format(d);
  const n = parseInt(s, 10);
  // Defensive — Intl can return "24" at midnight in some locales.
  return Number.isFinite(n) ? ((n % 24) + 24) % 24 : 0;
}

export type CheckinAnalyticsFilters = {
  // Inclusive lower bound. Undefined → "no lower bound".
  from?: Date;
  // Inclusive upper bound. Undefined → "no upper bound".
  to?: Date;
  // Scope for the "detailed activity" section only. The KPI row and
  // space grid always show the un-scoped view (that's the whole point
  // of a comparison dashboard).
  accessPointId?: string;
  // Scope for the "detailed activity" section only. Same rationale.
  result?: CheckInResult;
};

// Common Prisma where clause built from the date range. Applied to
// every metric so a "today only" filter is consistent everywhere.
function dateWhere(f: CheckinAnalyticsFilters): Prisma.CheckInWhereInput {
  const w: Prisma.CheckInWhereInput = {};
  if (f.from || f.to) {
    w.scannedAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lte: f.to } : {})
    };
  }
  return w;
}

// ─── AccessPoint catalog ──────────────────────────────────────────
// Loaded once per page render; drives all "iterate active spaces"
// logic. Never hardcoded — an admin who creates room-06 sees it here
// on the very next request.

export type AccessPointRow = {
  id: string;
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  order: number;
};

export async function listAccessPointsForAnalytics(): Promise<
  AccessPointRow[]
> {
  return prisma.accessPoint.findMany({
    orderBy: [{ type: "asc" }, { order: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      active: true,
      order: true
    }
  });
}

// ─── Main entrance metrics ─────────────────────────────────────────

export type MainEntranceMetrics = {
  // COUNT(DISTINCT participantId) WHERE result=VALID AND accessPoint.type=MAIN_ENTRANCE
  uniqueVisitors: number;
  // COUNT(CheckIn) WHERE result=VALID AND accessPoint.type=MAIN_ENTRANCE.
  // Equals uniqueVisitors (main entrance is single-VALID per participant)
  // but kept as a separate field so the semantics stay explicit at the UI.
  validScans: number;
  // Repeat scans at the main entrance surface as ALREADY_CHECKED_IN.
  repeatScans: number;
  // Denied at the main entrance for any reason (unpaid, cancelled,
  // PA_REVOKED, badge invalid, badge revoked, badge expired, wrong
  // access point, …). Aggregated so operational review has a single
  // "issues" pane.
  deniedScans: number;
};

export async function getMainEntranceMetrics(
  f: CheckinAnalyticsFilters
): Promise<MainEntranceMetrics> {
  const dateW = dateWhere(f);

  const mainW: Prisma.CheckInWhereInput = {
    ...dateW,
    accessPoint: { is: { type: AccessPointType.MAIN_ENTRANCE } }
  };

  const [uniqueRows, validScans, repeatScans, allAtMain] = await Promise.all([
    // COUNT DISTINCT participantId via groupBy(participantId).
    prisma.checkIn.groupBy({
      by: ["participantId"],
      where: {
        ...mainW,
        result: CheckInResult.VALID,
        participantId: { not: null }
      }
    }),
    prisma.checkIn.count({
      where: { ...mainW, result: CheckInResult.VALID }
    }),
    prisma.checkIn.count({
      where: { ...mainW, result: CheckInResult.ALREADY_CHECKED_IN }
    }),
    prisma.checkIn.count({ where: mainW })
  ]);

  const uniqueVisitors = uniqueRows.length;
  // "denied" = every non-VALID, non-ALREADY_CHECKED_IN result. Neutral
  // wording; a per-reason breakdown is provided by getResultBreakdown.
  const deniedScans = Math.max(0, allAtMain - validScans - repeatScans);

  return { uniqueVisitors, validScans, repeatScans, deniedScans };
}

// ─── Per-space (ROOM + MAIN_ENTRANCE) breakdown ────────────────────

export type SpaceMetrics = {
  accessPointId: string;
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  uniqueVisitors: number;
  validScans: number;
  // Number of ALREADY_CHECKED_IN rows at this AP. Meaningful for
  // MAIN_ENTRANCE only — the Phase 11 room validator never emits
  // ALREADY_CHECKED_IN (rooms allow repeat entry, C1 = A). For rooms
  // this is essentially always 0. UI consumers should prefer
  // `repeatEntries` below, which encodes the correct semantics per
  // access-point type.
  alreadyCheckedInScans: number;
  // Unified "repeat entries" metric — the right thing to display in
  // the UI regardless of AP type.
  //   MAIN_ENTRANCE → `alreadyCheckedInScans` (the atomic-claim guard
  //     is the only way a repeat scan appears on the main entrance;
  //     `validScans === uniqueVisitors` by validator contract).
  //   ROOM         → `validScans - uniqueVisitors` (rooms emit fresh
  //     VALID rows on every entry; the mathematical repeat count is
  //     the right definition per master-doc §28).
  // See Phase 21 audit finding A2.
  repeatEntries: number;
  deniedScans: number;
  totalScans: number;
  lastScanAt: Date | null;
  // Peak 1-hour bucket. Uses Africa/Algiers wall-clock hours.
  // Undefined when there are no valid scans for this space in the
  // window.
  peakHour?: number;
  peakHourCount?: number;
};

export async function getSpaceMetrics(
  f: CheckinAnalyticsFilters,
  points: AccessPointRow[]
): Promise<SpaceMetrics[]> {
  const dateW = dateWhere(f);

  // One groupBy over (accessPointId, participantId, result) — bounded
  // by the date filter. Materialises pair-level data we fold into
  // per-space counts in JS. Prisma cannot express COUNT DISTINCT + a
  // second dimension in a single query, so this is the cleanest path
  // that stays within the ORM.
  const grouped = await prisma.checkIn.groupBy({
    by: ["accessPointId", "participantId", "result"],
    where: { ...dateW, accessPointId: { not: null } },
    _count: { _all: true }
  });

  // Also pull the last-scanned timestamp per access point, and the
  // hourly peak. Kept as separate queries so each stays index-friendly
  // (@@index([accessPointId, scannedAt])).
  const lastByPoint = new Map<string, Date>();
  const lastRows = await prisma.checkIn.groupBy({
    by: ["accessPointId"],
    where: { ...dateW, accessPointId: { not: null }, result: CheckInResult.VALID },
    _max: { scannedAt: true }
  });
  for (const r of lastRows) {
    if (r.accessPointId && r._max.scannedAt) {
      lastByPoint.set(r.accessPointId, r._max.scannedAt);
    }
  }

  // Peak hour bucket per space — a bounded scan of just the valid
  // scans in the window (whitelist select: scannedAt + accessPointId
  // only). The RECENT_ACTIVITY_MAX / DETAILED_TABLE_MAX bounds do NOT
  // apply here — this is a stream aggregate, not a materialised list.
  // We still cap defensively.
  const validForPeak = await prisma.checkIn.findMany({
    where: { ...dateW, accessPointId: { not: null }, result: CheckInResult.VALID },
    orderBy: { scannedAt: "asc" },
    take: HOURLY_ROWS_HARD_MAX,
    select: { accessPointId: true, scannedAt: true }
  });

  const hourlyBuckets = new Map<string, Map<number, number>>(); // apId → hour → count
  for (const r of validForPeak) {
    if (!r.accessPointId) continue;
    // Africa/Algiers wall-clock hour (event timezone). See §Phase 21
    // audit finding A1.
    const hour = algiersHour(r.scannedAt);
    let m = hourlyBuckets.get(r.accessPointId);
    if (!m) {
      m = new Map();
      hourlyBuckets.set(r.accessPointId, m);
    }
    m.set(hour, (m.get(hour) ?? 0) + 1);
  }

  // Roll up groupBy rows into per-AP counters.
  type Counters = {
    unique: Set<string>;
    validScans: number;
    alreadyCheckedInScans: number;
    deniedScans: number;
    totalScans: number;
  };
  const counters = new Map<string, Counters>();
  const ensure = (id: string): Counters => {
    let c = counters.get(id);
    if (!c) {
      c = {
        unique: new Set(),
        validScans: 0,
        alreadyCheckedInScans: 0,
        deniedScans: 0,
        totalScans: 0
      };
      counters.set(id, c);
    }
    return c;
  };

  for (const row of grouped) {
    if (!row.accessPointId) continue;
    const c = ensure(row.accessPointId);
    const n = row._count._all;
    c.totalScans += n;

    if (row.result === CheckInResult.VALID) {
      c.validScans += n;
      if (row.participantId) c.unique.add(row.participantId);
    } else if (row.result === CheckInResult.ALREADY_CHECKED_IN) {
      c.alreadyCheckedInScans += n;
    } else {
      c.deniedScans += n;
    }
  }

  return points.map((p) => {
    const c = counters.get(p.id);
    const uniqueVisitors = c ? c.unique.size : 0;
    const validScans = c ? c.validScans : 0;
    const alreadyCheckedInScans = c ? c.alreadyCheckedInScans : 0;
    const deniedScans = c ? c.deniedScans : 0;
    const totalScans = c ? c.totalScans : 0;

    // Type-appropriate repeat-entries metric — see Phase 21 audit A2.
    const repeatEntries =
      p.type === AccessPointType.MAIN_ENTRANCE
        ? alreadyCheckedInScans
        : Math.max(0, validScans - uniqueVisitors);

    // Peak hour
    const hm = hourlyBuckets.get(p.id);
    let peakHour: number | undefined;
    let peakHourCount: number | undefined;
    if (hm && hm.size > 0) {
      for (const [h, count] of hm) {
        if (peakHourCount === undefined || count > peakHourCount) {
          peakHour = h;
          peakHourCount = count;
        }
      }
    }

    return {
      accessPointId: p.id,
      slug: p.slug,
      name: p.name,
      type: p.type,
      active: p.active,
      uniqueVisitors,
      validScans,
      alreadyCheckedInScans,
      repeatEntries,
      deniedScans,
      totalScans,
      lastScanAt: lastByPoint.get(p.id) ?? null,
      peakHour,
      peakHourCount
    };
  });
}

// ─── Hourly traffic ─────────────────────────────────────────────────

export type HourlyBucket = {
  hour: number; // 0..23
  uniqueVisitors: number; // distinct participants who had a VALID scan in this hour AT THE MAIN ENTRANCE
  validScans: number; // count of VALID scans in this hour (across ALL access points)
};

export async function getHourlyTraffic(
  f: CheckinAnalyticsFilters
): Promise<HourlyBucket[]> {
  const dateW = dateWhere(f);
  // Whitelist projection — just what's needed for bucketing.
  const rows = await prisma.checkIn.findMany({
    where: { ...dateW, result: CheckInResult.VALID },
    orderBy: { scannedAt: "asc" },
    take: HOURLY_ROWS_HARD_MAX,
    select: {
      scannedAt: true,
      participantId: true,
      accessPoint: { select: { type: true } }
    }
  });

  const buckets = new Map<number, { unique: Set<string>; validScans: number }>();
  for (let h = 0; h < 24; h++) {
    buckets.set(h, { unique: new Set(), validScans: 0 });
  }

  for (const r of rows) {
    // Africa/Algiers wall-clock hour (event timezone). See §Phase 21
    // audit finding A1.
    const h = algiersHour(r.scannedAt);
    const b = buckets.get(h)!;
    b.validScans += 1;
    if (
      r.participantId &&
      r.accessPoint?.type === AccessPointType.MAIN_ENTRANCE
    ) {
      b.unique.add(r.participantId);
    }
  }

  const result: HourlyBucket[] = [];
  for (let h = 0; h < 24; h++) {
    const b = buckets.get(h)!;
    result.push({
      hour: h,
      uniqueVisitors: b.unique.size,
      validScans: b.validScans
    });
  }
  return result;
}

// ─── Cross-space coverage ─────────────────────────────────────────
// "How many participants visited exactly K rooms?" and the derived
// full-exhibition metric ("visited every currently active ROOM").
// Uses only ROOM access points — the MAIN_ENTRANCE is measured
// separately.

export type CoverageBucket = {
  spacesVisited: number; // K ROOMs (0..activeRoomCount)
  uniqueVisitors: number;
};

export type CoverageResult = {
  activeRoomCount: number;
  buckets: CoverageBucket[]; // 0..activeRoomCount inclusive
  fullExhibitionVisitors: number; // participants with VALID at EVERY active room
};

export async function getSpaceCoverage(
  f: CheckinAnalyticsFilters,
  points: AccessPointRow[]
): Promise<CoverageResult> {
  const dateW = dateWhere(f);
  const activeRooms = points.filter(
    (p) => p.active && p.type === AccessPointType.ROOM
  );
  const activeRoomIds = new Set(activeRooms.map((p) => p.id));

  if (activeRoomIds.size === 0) {
    return {
      activeRoomCount: 0,
      buckets: [{ spacesVisited: 0, uniqueVisitors: 0 }],
      fullExhibitionVisitors: 0
    };
  }

  // (accessPointId, participantId) distinct pairs restricted to
  // active-room VALID scans. Prisma groupBy uses no COUNT DISTINCT
  // second dimension, so we fold in JS.
  const pairs = await prisma.checkIn.groupBy({
    by: ["accessPointId", "participantId"],
    where: {
      ...dateW,
      result: CheckInResult.VALID,
      participantId: { not: null },
      accessPointId: { in: Array.from(activeRoomIds) }
    }
  });

  const perParticipant = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!p.participantId || !p.accessPointId) continue;
    let s = perParticipant.get(p.participantId);
    if (!s) {
      s = new Set();
      perParticipant.set(p.participantId, s);
    }
    s.add(p.accessPointId);
  }

  const totalActive = activeRoomIds.size;
  const bucketCounts = new Map<number, number>();
  for (let k = 0; k <= totalActive; k++) bucketCounts.set(k, 0);

  let fullVisitors = 0;
  for (const set of perParticipant.values()) {
    const k = set.size;
    bucketCounts.set(k, (bucketCounts.get(k) ?? 0) + 1);
    if (k === totalActive) fullVisitors += 1;
  }

  const buckets: CoverageBucket[] = [];
  for (let k = 0; k <= totalActive; k++) {
    buckets.push({ spacesVisited: k, uniqueVisitors: bucketCounts.get(k) ?? 0 });
  }

  return {
    activeRoomCount: totalActive,
    buckets,
    fullExhibitionVisitors: fullVisitors
  };
}

// ─── Result & reason breakdown (operational review) ───────────────
// Used for the "denied scans / problems" section. Groups by result
// AND reason so operators can spot patterns (a spike of
// PA_NOT_GRANTED at Salle 03 means somebody's grant list is missing).

export type ResultBreakdownRow = {
  accessPointId: string | null;
  result: CheckInResult;
  reason: string | null;
  count: number;
};

export async function getResultBreakdown(
  f: CheckinAnalyticsFilters
): Promise<ResultBreakdownRow[]> {
  const dateW = dateWhere(f);
  // This is the "denied / operational problems" surface — VALID is
  // never a denial. The `f.result` filter is intentionally IGNORED
  // here (see Phase 21 audit A3): applying it would silently empty
  // the section when the operator narrows the dashboard to VALID
  // only. `f.accessPointId` remains applied because scoping "problems
  // at Salle 03" is a legitimate operational drill-down.
  const where: Prisma.CheckInWhereInput = {
    ...dateW,
    result: { not: CheckInResult.VALID }
  };
  if (f.accessPointId) where.accessPointId = f.accessPointId;

  const rows = await prisma.checkIn.groupBy({
    by: ["accessPointId", "result", "reason"],
    where,
    _count: { _all: true },
    orderBy: [{ result: "asc" }]
  });

  return rows.map((r) => ({
    accessPointId: r.accessPointId,
    result: r.result,
    reason: r.reason,
    count: r._count._all
  }));
}

// ─── Recent activity ──────────────────────────────────────────────
// Bounded list of the most recent VALID scans. Whitelist projection —
// first name + last-name initial + tier + AP name + time + result.
// No email, no phone, no ticketCode, no credentialId, no rawToken.

export type RecentActivityRow = {
  id: string;
  scannedAt: Date;
  result: CheckInResult;
  reason: string | null;
  accessPoint: {
    id: string;
    name: string;
    type: AccessPointType;
  } | null;
  participant: {
    firstName: string;
    lastNameInitial: string;
    tier: string | null;
  } | null;
};

export async function getRecentActivity(
  f: CheckinAnalyticsFilters,
  take = RECENT_ACTIVITY_MAX
): Promise<RecentActivityRow[]> {
  const dateW = dateWhere(f);
  const takeN = Math.min(Math.max(take, 1), RECENT_ACTIVITY_MAX);
  // The "Dernières entrées" section always shows successful entries.
  // A `f.result` narrowed to a denial would previously flip this list
  // into denial rows while keeping the SUCCESS label — see Phase 21
  // audit A4. The Journal détaillé (detailed table) is the correct
  // surface for filtered arbitrary results.
  const where: Prisma.CheckInWhereInput = {
    ...dateW,
    result: CheckInResult.VALID
  };
  if (f.accessPointId) where.accessPointId = f.accessPointId;

  const rows = await prisma.checkIn.findMany({
    where,
    orderBy: { scannedAt: "desc" },
    take: takeN,
    select: {
      id: true,
      scannedAt: true,
      result: true,
      reason: true,
      accessPoint: {
        select: { id: true, name: true, type: true }
      },
      participant: {
        select: {
          firstName: true,
          lastName: true,
          tier: true
        }
      }
    }
  });

  return rows.map((r) => ({
    id: r.id,
    scannedAt: r.scannedAt,
    result: r.result,
    reason: r.reason,
    accessPoint: r.accessPoint,
    participant: r.participant
      ? {
          firstName: r.participant.firstName,
          lastNameInitial: (r.participant.lastName?.[0] ?? "").toUpperCase(),
          tier: r.participant.tier as string | null
        }
      : null
  }));
}

// ─── Operator activity ────────────────────────────────────────────
// Per-operator counts. Same permission gates the whole page, so
// visibility is not an issue at the operator-count level. Never
// exposes operator email.

export type OperatorActivityRow = {
  operatorId: string;
  name: string;
  totalScans: number;
  validScans: number;
  deniedScans: number;
};

export async function getOperatorActivity(
  f: CheckinAnalyticsFilters
): Promise<OperatorActivityRow[]> {
  const dateW = dateWhere(f);
  const where: Prisma.CheckInWhereInput = {
    ...dateW,
    operatorId: { not: null }
  };
  if (f.accessPointId) where.accessPointId = f.accessPointId;

  const rows = await prisma.checkIn.groupBy({
    by: ["operatorId", "result"],
    where,
    _count: { _all: true }
  });

  const byOp = new Map<
    string,
    { total: number; valid: number; denied: number }
  >();
  for (const r of rows) {
    if (!r.operatorId) continue;
    let cur = byOp.get(r.operatorId);
    if (!cur) {
      cur = { total: 0, valid: 0, denied: 0 };
      byOp.set(r.operatorId, cur);
    }
    const n = r._count._all;
    cur.total += n;
    if (r.result === CheckInResult.VALID) cur.valid += n;
    else if (r.result !== CheckInResult.ALREADY_CHECKED_IN) cur.denied += n;
  }

  if (byOp.size === 0) return [];

  const users = await prisma.adminUser.findMany({
    where: { id: { in: Array.from(byOp.keys()) } },
    select: { id: true, name: true }
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  const out: OperatorActivityRow[] = [];
  for (const [operatorId, c] of byOp) {
    out.push({
      operatorId,
      name: nameById.get(operatorId) ?? "—",
      totalScans: c.total,
      validScans: c.valid,
      deniedScans: c.denied
    });
  }
  out.sort((a, b) => b.validScans - a.validScans);
  return out;
}

// ─── Detailed table (bounded) ─────────────────────────────────────
// The filterable footer table. Same discipline as scan-history-query:
// hard row cap, whitelist projection.

export type DetailedRow = {
  id: string;
  scannedAt: Date;
  result: CheckInResult;
  reason: string | null;
  accessPoint: { id: string; name: string; type: AccessPointType } | null;
  participant: { firstName: string; lastNameInitial: string } | null;
  operator: { id: string; name: string } | null;
};

export async function getDetailedRows(
  f: CheckinAnalyticsFilters,
  take = DETAILED_TABLE_MAX
): Promise<DetailedRow[]> {
  const dateW = dateWhere(f);
  const takeN = Math.min(Math.max(take, 1), DETAILED_TABLE_MAX);
  const where: Prisma.CheckInWhereInput = { ...dateW };
  if (f.accessPointId) where.accessPointId = f.accessPointId;
  if (f.result) where.result = f.result;

  const rows = await prisma.checkIn.findMany({
    where,
    orderBy: { scannedAt: "desc" },
    take: takeN,
    select: {
      id: true,
      scannedAt: true,
      result: true,
      reason: true,
      accessPoint: { select: { id: true, name: true, type: true } },
      participant: { select: { firstName: true, lastName: true } },
      operator: { select: { id: true, name: true } }
    }
  });

  return rows.map((r) => ({
    id: r.id,
    scannedAt: r.scannedAt,
    result: r.result,
    reason: r.reason,
    accessPoint: r.accessPoint,
    participant: r.participant
      ? {
          firstName: r.participant.firstName,
          lastNameInitial: (r.participant.lastName?.[0] ?? "").toUpperCase()
        }
      : null,
    operator: r.operator
  }));
}

// ─── Unified fetch ────────────────────────────────────────────────
// One-shot loader used by the page. Parallelises everything.

export type CheckinAnalyticsPayload = {
  accessPoints: AccessPointRow[];
  main: MainEntranceMetrics;
  spaces: SpaceMetrics[];
  hourly: HourlyBucket[];
  coverage: CoverageResult;
  breakdown: ResultBreakdownRow[];
  recent: RecentActivityRow[];
  operators: OperatorActivityRow[];
  detailed: DetailedRow[];
  generatedAt: Date;
};

export async function getCheckinAnalytics(
  f: CheckinAnalyticsFilters,
  // Optional: caller may pre-load the AccessPoint catalog (used by the
  // page to validate accessPointId before parallelising queries). If
  // omitted we load it here — the two-caller shape stays consistent.
  preloadedPoints?: AccessPointRow[]
): Promise<CheckinAnalyticsPayload> {
  const accessPoints =
    preloadedPoints ?? (await listAccessPointsForAnalytics());

  const [main, spaces, hourly, coverage, breakdown, recent, operators, detailed] =
    await Promise.all([
      getMainEntranceMetrics(f),
      getSpaceMetrics(f, accessPoints),
      getHourlyTraffic(f),
      getSpaceCoverage(f, accessPoints),
      getResultBreakdown(f),
      getRecentActivity(f),
      getOperatorActivity(f),
      getDetailedRows(f)
    ]);

  return {
    accessPoints,
    main,
    spaces,
    hourly,
    coverage,
    breakdown,
    recent,
    operators,
    detailed,
    generatedAt: new Date()
  };
}

// ─── Per-space detail (Phase 21) ──────────────────────────────────
// Powers `/admin/scan/analytics/[access-point-slug]`.
// Not a substitute for `/admin/scan/history` — that surface remains
// the raw scan log. This one aggregates.

export type SpaceHourlyBucket = {
  hour: number; // 0..23 Africa/Algiers
  uniqueVisitors: number; // distinct participants with a VALID scan in this hour AT THIS AP
  validScans: number; // count of VALID scans in this hour AT THIS AP
};

// Aggregated tier / participation-type / registration-type breakdown
// for the participants who visited this AP with VALID entries.
// COUNT DISTINCT participants per bucket — a participant with three
// VALID scans at the same room shows up ONCE in the tier column.
// The three source columns are cross-tabulations of the same set of
// unique visitors — a participant is counted once per axis they have
// a non-null value in.
export type SpaceVisitorBreakdown = {
  // key = tier / choice / type string, count = distinct participants.
  byTier: Array<{ key: string; count: number }>;
  byParticipationChoice: Array<{ key: string; count: number }>;
  byRegistrationType: Array<{ key: string; count: number }>;
  byProfile: Array<{ key: string; count: number }>;
};

export type SpaceOverview = {
  accessPointId: string;
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  uniqueVisitors: number;
  validScans: number;
  repeatEntries: number;
  deniedScans: number;
  totalScans: number;
  firstEntryAt: Date | null;
  lastEntryAt: Date | null;
  peakHour?: number;
  peakHourCount?: number;
};

export type SpaceRecentEntryRow = {
  id: string;
  scannedAt: Date;
  result: CheckInResult;
  reason: string | null;
  participant: {
    firstName: string;
    lastNameInitial: string;
    tier: string | null;
  } | null;
  operator: { name: string } | null;
};

export type SpaceDetailPayload = {
  overview: SpaceOverview;
  hourly: SpaceHourlyBucket[];
  breakdown: SpaceVisitorBreakdown;
  denied: ResultBreakdownRow[]; // scoped to this AP
  recent: SpaceRecentEntryRow[]; // ≤ SPACE_DETAIL_ACTIVITY_MAX rows
  // Share of unique main-entrance visitors that also visited this
  // space (a number in [0, 1] with no denominator surprise — if the
  // denominator is zero, `share` is null).
  shareOfSalon: number | null;
  generatedAt: Date;
};

// Resolve an AccessPoint by slug for the detail page. Whitelist
// select. Returns null for unknown slug — the caller MUST refuse
// (notFound) rather than fabricate a point.
export async function resolveAccessPointBySlug(
  slug: string
): Promise<AccessPointRow | null> {
  return prisma.accessPoint.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      active: true,
      order: true
    }
  });
}

export async function getSpaceDetail(
  point: AccessPointRow,
  f: CheckinAnalyticsFilters
): Promise<SpaceDetailPayload> {
  const dateW = dateWhere(f);
  const apW: Prisma.CheckInWhereInput = {
    ...dateW,
    accessPointId: point.id
  };

  const [
    grouped,
    firstRow,
    lastRow,
    validAtPoint,
    denied,
    recent,
    mainUnique
  ] = await Promise.all([
    // participant-level (unique + valid) counts
    prisma.checkIn.groupBy({
      by: ["participantId", "result"],
      where: apW,
      _count: { _all: true }
    }),
    // first / last entry
    prisma.checkIn.findFirst({
      where: { ...apW, result: CheckInResult.VALID },
      orderBy: { scannedAt: "asc" },
      select: { scannedAt: true }
    }),
    prisma.checkIn.findFirst({
      where: { ...apW, result: CheckInResult.VALID },
      orderBy: { scannedAt: "desc" },
      select: { scannedAt: true }
    }),
    // valid scans with the fields needed to build the hourly buckets
    // and the visitor breakdown. Whitelist select — NO email, NO
    // phone, NO ticketCode, NO credential material.
    prisma.checkIn.findMany({
      where: { ...apW, result: CheckInResult.VALID },
      orderBy: { scannedAt: "asc" },
      take: HOURLY_ROWS_HARD_MAX,
      select: {
        scannedAt: true,
        participantId: true,
        participant: {
          select: {
            tier: true,
            registrationType: true,
            participationChoice: true,
            profile: true
          }
        }
      }
    }),
    // denied breakdown scoped to this AP
    getResultBreakdown({ ...f, accessPointId: point.id }),
    // recent activity scoped to this AP
    prisma.checkIn.findMany({
      where: { ...apW, result: CheckInResult.VALID },
      orderBy: { scannedAt: "desc" },
      take: SPACE_DETAIL_ACTIVITY_MAX,
      select: {
        id: true,
        scannedAt: true,
        result: true,
        reason: true,
        participant: {
          select: { firstName: true, lastName: true, tier: true }
        },
        operator: { select: { name: true } }
      }
    }),
    // For "% du salon" — unique main entrance visitors in the same
    // window. Prisma cannot COUNT DISTINCT so we groupBy.
    prisma.checkIn.groupBy({
      by: ["participantId"],
      where: {
        ...dateW,
        result: CheckInResult.VALID,
        participantId: { not: null },
        accessPoint: { is: { type: AccessPointType.MAIN_ENTRANCE } }
      }
    })
  ]);

  // Roll up the grouped result rows into counters.
  let uniqueVisitors = 0;
  let validScans = 0;
  let alreadyCheckedIn = 0;
  let deniedScans = 0;
  let totalScans = 0;
  const validParticipants = new Set<string>();
  for (const g of grouped) {
    const n = g._count._all;
    totalScans += n;
    if (g.result === CheckInResult.VALID) {
      validScans += n;
      if (g.participantId) validParticipants.add(g.participantId);
    } else if (g.result === CheckInResult.ALREADY_CHECKED_IN) {
      alreadyCheckedIn += n;
    } else {
      deniedScans += n;
    }
  }
  uniqueVisitors = validParticipants.size;

  const repeatEntries =
    point.type === AccessPointType.MAIN_ENTRANCE
      ? alreadyCheckedIn
      : Math.max(0, validScans - uniqueVisitors);

  // Hourly buckets — Africa/Algiers wall-clock.
  const buckets = new Map<number, { unique: Set<string>; validScans: number }>();
  for (let h = 0; h < 24; h++) {
    buckets.set(h, { unique: new Set(), validScans: 0 });
  }
  for (const r of validAtPoint) {
    const h = algiersHour(r.scannedAt);
    const b = buckets.get(h)!;
    b.validScans += 1;
    if (r.participantId) b.unique.add(r.participantId);
  }
  const hourly: SpaceHourlyBucket[] = [];
  let peakHour: number | undefined;
  let peakHourCount: number | undefined;
  for (let h = 0; h < 24; h++) {
    const b = buckets.get(h)!;
    hourly.push({
      hour: h,
      uniqueVisitors: b.unique.size,
      validScans: b.validScans
    });
    if (peakHourCount === undefined || b.validScans > peakHourCount) {
      peakHourCount = b.validScans;
      peakHour = h;
    }
  }
  if (peakHourCount === 0) {
    peakHour = undefined;
    peakHourCount = undefined;
  }

  // Visitor breakdown — COUNT DISTINCT participants per bucket.
  // `validAtPoint` may repeat a participant across multiple scans;
  // we bucket by participantId to keep the count distinct.
  const seenParticipants = new Map<
    string,
    {
      tier: string | null;
      registrationType: string | null;
      participationChoice: string | null;
      profile: string | null;
    }
  >();
  for (const r of validAtPoint) {
    if (!r.participantId || seenParticipants.has(r.participantId)) continue;
    seenParticipants.set(r.participantId, {
      tier: r.participant?.tier ?? null,
      registrationType: r.participant?.registrationType ?? null,
      participationChoice: r.participant?.participationChoice ?? null,
      profile: r.participant?.profile ?? null
    });
  }
  const tally = (
    pick: (
      p: {
        tier: string | null;
        registrationType: string | null;
        participationChoice: string | null;
        profile: string | null;
      }
    ) => string | null
  ) => {
    const counts = new Map<string, number>();
    for (const v of seenParticipants.values()) {
      const key = pick(v);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  };
  const breakdown: SpaceVisitorBreakdown = {
    byTier: tally((p) => p.tier),
    byParticipationChoice: tally((p) => p.participationChoice),
    byRegistrationType: tally((p) => p.registrationType),
    byProfile: tally((p) => p.profile)
  };

  const overview: SpaceOverview = {
    accessPointId: point.id,
    slug: point.slug,
    name: point.name,
    type: point.type,
    active: point.active,
    uniqueVisitors,
    validScans,
    repeatEntries,
    deniedScans,
    totalScans,
    firstEntryAt: firstRow?.scannedAt ?? null,
    lastEntryAt: lastRow?.scannedAt ?? null,
    peakHour,
    peakHourCount
  };

  const mainUniqueCount = mainUnique.length;
  const shareOfSalon =
    mainUniqueCount > 0 && point.type === AccessPointType.ROOM
      ? uniqueVisitors / mainUniqueCount
      : null;

  const recentMapped: SpaceRecentEntryRow[] = recent.map((r) => ({
    id: r.id,
    scannedAt: r.scannedAt,
    result: r.result,
    reason: r.reason,
    participant: r.participant
      ? {
          firstName: r.participant.firstName,
          lastNameInitial: (r.participant.lastName?.[0] ?? "").toUpperCase(),
          tier: r.participant.tier as string | null
        }
      : null,
    operator: r.operator ? { name: r.operator.name } : null
  }));

  return {
    overview,
    hourly,
    breakdown,
    denied,
    recent: recentMapped,
    shareOfSalon,
    generatedAt: new Date()
  };
}

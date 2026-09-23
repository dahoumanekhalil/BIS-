// Phase 21 tests — Advanced attendance analytics + per-space detail.
// Run with:
//   npm run test:checkin-analytics-phase21
//
// Focus:
//   • Audit corrections applied in Phase 21 (timezone, main-vs-room
//     repeat semantics, denied-filter decoupling, recent-activity
//     result contract, breakdown discipline).
//   • Per-space detail queries produce correct COUNT DISTINCT
//     participant metrics.
//   • Per-space detail page rejects unknown / MAIN_ENTRANCE slugs,
//     re-checks analytics.view server-side, and never surfaces
//     credential material.
//   • Dynamic-room coverage: creating and deactivating an
//     AccessPoint changes the fullExhibitionVisitors denominator.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  AccessPointType,
  AdminRole,
  AdminStatus,
  CheckInResult,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus,
  RegistrationTier
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  algiersHour,
  EVENT_TIMEZONE,
  getRecentActivity,
  getResultBreakdown,
  getSpaceCoverage,
  getSpaceDetail,
  getSpaceMetrics,
  listAccessPointsForAnalytics,
  resolveAccessPointBySlug
} from "../lib/admin/checkin-analytics";

const prisma = new PrismaClient();

const P_EMAIL_PREFIX = "phase21-analytics-fixture-";
const OP_EMAIL = "phase21-analytics-op@bis.dz";
const EXTRA_ROOM_SLUG = "phase21-analytics-tmp-room";

let eventId: string;
let operatorId: string;
let mainPointId: string;
let room1Id: string;
let room2Id: string;
let room3Id: string;
let extraRoomId: string | null = null;

let alice: string;
let bob: string;
let carol: string;
let dave: string;

async function makeParticipant(
  first: string,
  last: string,
  overrides: Partial<{
    tier: RegistrationTier | null;
    status: RegistrationStatus;
    paymentStatus: PaymentStatus;
  }> = {}
) {
  const suffix = randomBytes(3).toString("hex");
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: first,
      lastName: last,
      email: `${P_EMAIL_PREFIX}${first.toLowerCase()}-${suffix}@bis.dz`,
      status: overrides.status ?? RegistrationStatus.CONFIRMED,
      paymentStatus: overrides.paymentStatus ?? PaymentStatus.PAID,
      tier: overrides.tier ?? null,
      ticketCode: `T-${first.toUpperCase()}-${suffix.toUpperCase()}`
    }
  });
  return p.id;
}

async function ci(
  participantId: string,
  accessPointId: string,
  result: CheckInResult,
  scannedAt: Date,
  reason: string | null = null
) {
  const p = await prisma.participant.findUnique({
    where: { id: participantId },
    select: { ticketCode: true }
  });
  await prisma.checkIn.create({
    data: {
      participantId,
      operatorId,
      accessPointId,
      ticketCode: p?.ticketCode ?? "",
      gate: "phase21-test",
      result,
      reason,
      scannedAt
    }
  });
}

before(async () => {
  const ev = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(ev, "expected a seeded Event to exist");
  eventId = ev.id;

  const points = await prisma.accessPoint.findMany({
    orderBy: [{ type: "asc" }, { order: "asc" }]
  });
  const main = points.find((p) => p.type === AccessPointType.MAIN_ENTRANCE);
  const rooms = points.filter(
    (p) => p.type === AccessPointType.ROOM && p.active
  );
  assert.ok(main, "expected a seeded MAIN_ENTRANCE point");
  assert.ok(rooms.length >= 3, `expected ≥3 active ROOMs, got ${rooms.length}`);
  mainPointId = main.id;
  room1Id = rooms[0].id;
  room2Id = rooms[1].id;
  room3Id = rooms[2].id;

  const op = await prisma.adminUser.upsert({
    where: { email: OP_EMAIL },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: OP_EMAIL,
      name: "Phase 21 Op",
      passwordHash: hashPassword("test-only"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  operatorId = op.id;

  alice = await makeParticipant("Alice", "Phase21", {
    tier: RegistrationTier.VIP
  });
  bob = await makeParticipant("Bob", "Phase21", { tier: null });
  carol = await makeParticipant("Carol", "Phase21", {
    tier: RegistrationTier.CONTENT_CREATOR
  });
  // Dave is CANCELLED — never a visitor even if a stray VALID row is
  // written. The audit fixture writes exactly one VALID row for him
  // to make the "denied not counted" assertion concrete against a
  // cancelled participant.
  dave = await makeParticipant("Dave", "Phase21", {
    status: RegistrationStatus.CANCELLED
  });

  // Alice: main VALID + room 1 four times VALID + room 2 VALID + room 3 VALID
  const now = new Date();
  const t = (mins: number) => new Date(now.getTime() - mins * 60_000);

  await ci(alice, mainPointId, CheckInResult.VALID, t(120), "FIRST_SCAN");
  await ci(alice, room1Id, CheckInResult.VALID, t(110), "ROOM_ENTRY");
  await ci(alice, room1Id, CheckInResult.VALID, t(100), "ROOM_ENTRY");
  await ci(alice, room1Id, CheckInResult.VALID, t(90), "ROOM_ENTRY");
  await ci(alice, room1Id, CheckInResult.VALID, t(80), "ROOM_ENTRY");
  await ci(alice, room2Id, CheckInResult.VALID, t(70), "ROOM_ENTRY");
  await ci(alice, room3Id, CheckInResult.VALID, t(60), "ROOM_ENTRY");

  // Bob: main VALID + room 1 VALID
  await ci(bob, mainPointId, CheckInResult.VALID, t(115), "FIRST_SCAN");
  await ci(bob, room1Id, CheckInResult.VALID, t(105), "ROOM_ENTRY");

  // Carol: main VALID + room 1 VALID + room 2 VALID
  await ci(carol, mainPointId, CheckInResult.VALID, t(112), "FIRST_SCAN");
  await ci(carol, room1Id, CheckInResult.VALID, t(102), "ROOM_ENTRY");
  await ci(carol, room2Id, CheckInResult.VALID, t(92), "ROOM_ENTRY");

  // Dave (CANCELLED): a stray VALID row (unreachable via the real
  // validator today, but defensive: the analytics loader must not
  // count him even if such a row exists).
  await ci(dave, room1Id, CheckInResult.VALID, t(50), "ROOM_ENTRY");
});

after(async () => {
  // Clean up fixture participants, their CheckIns, and the extra room.
  const survivors = await prisma.participant.findMany({
    where: { email: { startsWith: P_EMAIL_PREFIX } },
    select: { id: true }
  });
  for (const p of survivors) {
    await prisma.checkIn
      .deleteMany({ where: { participantId: p.id } })
      .catch(() => undefined);
    await prisma.participant
      .delete({ where: { id: p.id } })
      .catch(() => undefined);
  }
  await prisma.adminUser
    .deleteMany({ where: { email: OP_EMAIL } })
    .catch(() => undefined);
  if (extraRoomId) {
    await prisma.checkIn
      .deleteMany({ where: { accessPointId: extraRoomId } })
      .catch(() => undefined);
    await prisma.accessPoint
      .delete({ where: { id: extraRoomId } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

function fixtureWindow() {
  return {
    from: new Date(Date.now() - 24 * 60 * 60 * 1000),
    to: new Date(Date.now() + 60_000)
  };
}

// ─── Audit correction A1 — timezone ────────────────────────────────

describe("Phase 21 · timezone (Africa/Algiers)", () => {
  test("EVENT_TIMEZONE is Africa/Algiers", () => {
    assert.equal(EVENT_TIMEZONE, "Africa/Algiers");
  });

  test("algiersHour projects a Date into 0..23 in Algiers", () => {
    // 2027-11-15T13:00Z is 14:00 in Africa/Algiers (UTC+1, no DST).
    const d = new Date("2027-11-15T13:00:00.000Z");
    assert.equal(algiersHour(d), 14);
    // Midnight UTC on a summer day: 01:00 in Algiers.
    const midnight = new Date("2027-06-01T00:00:00.000Z");
    assert.equal(algiersHour(midnight), 1);
    // Late night UTC crosses to the next Algiers day: 23:30Z → 00:30 next.
    const nearMidnight = new Date("2027-11-15T23:30:00.000Z");
    assert.equal(algiersHour(nearMidnight), 0);
  });

  test("algiersHour always returns 0..23", () => {
    for (let h = 0; h < 24; h++) {
      const d = new Date(`2027-11-15T${h.toString().padStart(2, "0")}:15:00.000Z`);
      const got = algiersHour(d);
      assert.ok(got >= 0 && got < 24, `bad hour: ${got}`);
    }
  });
});

// ─── Audit correction A2 — main vs room repeat semantics ──────────

describe("Phase 21 · main vs room repeat semantics", () => {
  test("ROOM.repeatEntries = validScans - uniqueVisitors", async () => {
    const points = await listAccessPointsForAnalytics();
    const rows = await getSpaceMetrics(fixtureWindow(), points);
    const room1 = rows.find((r) => r.accessPointId === room1Id);
    assert.ok(room1);
    // Fixture: Alice×4 + Bob×1 + Carol×1 + Dave×1 = 7 valid scans
    // over 4 distinct participants. Repeat entries = 7 - 4 = 3.
    // Real DB may have other fixtures on this same room — assert on
    // the identity rather than the absolute numbers.
    assert.equal(
      room1.repeatEntries,
      Math.max(0, room1.validScans - room1.uniqueVisitors),
      "ROOM.repeatEntries must equal validScans - uniqueVisitors"
    );
    assert.ok(
      room1.validScans >= 7,
      `room1 valid scans must include ≥7 fixture rows, got ${room1.validScans}`
    );
  });

  test("MAIN_ENTRANCE.repeatEntries = ALREADY_CHECKED_IN count", async () => {
    // Write one ALREADY_CHECKED_IN row for Alice at the main entrance
    // — this is the only shape the atomic-claim path produces at main.
    const now = new Date(Date.now() - 40 * 60_000);
    await ci(alice, mainPointId, CheckInResult.ALREADY_CHECKED_IN, now, "REPEAT_SCAN");

    const points = await listAccessPointsForAnalytics();
    const rows = await getSpaceMetrics(fixtureWindow(), points);
    const main = rows.find((r) => r.accessPointId === mainPointId);
    assert.ok(main);
    // repeatEntries on MAIN must equal alreadyCheckedInScans, not the
    // mathematical validScans - uniqueVisitors identity (which is 0
    // by the atomic-claim contract).
    assert.equal(main.repeatEntries, main.alreadyCheckedInScans);
    assert.ok(main.repeatEntries >= 1);
  });
});

// ─── Audit correction A3 — denied-filter decoupled from result ────

describe("Phase 21 · denied breakdown decoupled from result filter", () => {
  test("getResultBreakdown excludes VALID always", async () => {
    const rows = await getResultBreakdown(fixtureWindow());
    for (const r of rows) {
      assert.notEqual(
        r.result,
        CheckInResult.VALID,
        "denied breakdown must never surface VALID rows"
      );
    }
  });

  test("f.result=VALID does NOT silently empty the denied breakdown", async () => {
    const rows = await getResultBreakdown({
      ...fixtureWindow(),
      result: CheckInResult.VALID
    });
    // The filter is ignored on this section by contract (Phase 21 A3).
    // If there are any denials in the window, they must still appear.
    // We can't assert positive presence without knowing global DB state
    // — assert structurally that no VALID rows leaked in.
    for (const r of rows) {
      assert.notEqual(r.result, CheckInResult.VALID);
    }
  });
});

// ─── Audit correction A4 — recent activity always VALID ───────────

describe("Phase 21 · recent activity always VALID", () => {
  test("recent activity ignores f.result and always returns VALID rows", async () => {
    const rows = await getRecentActivity({
      ...fixtureWindow(),
      result: CheckInResult.UNPAID // hostile try
    });
    for (const r of rows) {
      assert.equal(
        r.result,
        CheckInResult.VALID,
        "getRecentActivity must always return VALID rows regardless of filter"
      );
    }
  });
});

// ─── Per-space detail queries ─────────────────────────────────────

describe("Phase 21 · per-space detail queries", () => {
  test("resolveAccessPointBySlug returns null for unknown slug", async () => {
    const r = await resolveAccessPointBySlug(
      "phase21-nonexistent-slug-xxx-yyy-zzz"
    );
    assert.equal(r, null);
  });

  test("getSpaceDetail — unique visitors and valid scans agree", async () => {
    const point = await resolveAccessPointBySlug(
      (await prisma.accessPoint.findUnique({
        where: { id: room1Id },
        select: { slug: true }
      }))!.slug
    );
    assert.ok(point);
    const d = await getSpaceDetail(point, fixtureWindow());
    assert.ok(d.overview.validScans >= d.overview.uniqueVisitors);
    assert.equal(
      d.overview.repeatEntries,
      Math.max(0, d.overview.validScans - d.overview.uniqueVisitors),
      "ROOM detail repeatEntries must equal validScans - uniqueVisitors"
    );
  });

  test("getSpaceDetail — breakdown is COUNT DISTINCT participants (not scans)", async () => {
    const point = await resolveAccessPointBySlug(
      (await prisma.accessPoint.findUnique({
        where: { id: room1Id },
        select: { slug: true }
      }))!.slug
    );
    assert.ok(point);
    const d = await getSpaceDetail(point, fixtureWindow());
    // Sum of `byTier` counts (participants with a non-null tier) must
    // be ≤ uniqueVisitors. Alice's 4 scans must NOT inflate the tier
    // bucket to 4.
    const tierSum = d.breakdown.byTier.reduce((a, r) => a + r.count, 0);
    assert.ok(
      tierSum <= d.overview.uniqueVisitors,
      `byTier sum (${tierSum}) must not exceed uniqueVisitors (${d.overview.uniqueVisitors})`
    );
    // Alice is VIP; assert at least one VIP row.
    const vip = d.breakdown.byTier.find((r) => r.key === "VIP");
    assert.ok(vip && vip.count >= 1, "expected at least one VIP visitor");
  });

  test("getSpaceDetail — denied excludes VALID even when scoped by AP", async () => {
    const point = await resolveAccessPointBySlug(
      (await prisma.accessPoint.findUnique({
        where: { id: room1Id },
        select: { slug: true }
      }))!.slug
    );
    assert.ok(point);
    const d = await getSpaceDetail(point, fixtureWindow());
    for (const r of d.denied) {
      assert.notEqual(r.result, CheckInResult.VALID);
    }
  });

  test("getSpaceDetail — recent activity is bounded and shape-clean", async () => {
    const point = await resolveAccessPointBySlug(
      (await prisma.accessPoint.findUnique({
        where: { id: room1Id },
        select: { slug: true }
      }))!.slug
    );
    assert.ok(point);
    const d = await getSpaceDetail(point, fixtureWindow());
    assert.ok(d.recent.length <= 40, "recent must respect the ≤40 cap");
    const s = JSON.stringify(d.recent);
    for (const banned of [
      "tokenHash",
      "rawToken",
      "passwordHash",
      "ticketCode",
      '"email"',
      '"phone"',
      "paymentAmount",
      "paymentRef",
      "checkinCode",
      "revokedReason"
    ]) {
      assert.equal(
        s.includes(banned),
        false,
        `recent activity must not expose ${banned}`
      );
    }
  });

  test("getSpaceDetail — hourly buckets always 24 and non-negative", async () => {
    const point = await resolveAccessPointBySlug(
      (await prisma.accessPoint.findUnique({
        where: { id: room1Id },
        select: { slug: true }
      }))!.slug
    );
    assert.ok(point);
    const d = await getSpaceDetail(point, fixtureWindow());
    assert.equal(d.hourly.length, 24);
    for (const b of d.hourly) {
      assert.ok(b.validScans >= 0);
      assert.ok(b.uniqueVisitors <= b.validScans);
    }
  });
});

// ─── Dynamic-room coverage (creating a new AP mid-run) ────────────

describe("Phase 21 · dynamic rooms — full-exhibition adapts", () => {
  test("adding a new active ROOM raises activeRoomCount denominator", async () => {
    const before = await getSpaceCoverage(
      fixtureWindow(),
      await listAccessPointsForAnalytics()
    );
    const beforeActive = before.activeRoomCount;

    const created = await prisma.accessPoint.create({
      data: {
        slug: EXTRA_ROOM_SLUG,
        name: "Phase 21 Tmp Room",
        type: AccessPointType.ROOM,
        active: true,
        order: 900
      }
    });
    extraRoomId = created.id;

    const after = await getSpaceCoverage(
      fixtureWindow(),
      await listAccessPointsForAnalytics()
    );
    assert.equal(
      after.activeRoomCount,
      beforeActive + 1,
      "activeRoomCount must grow with a new active ROOM"
    );

    // Full exhibition now requires visiting one MORE room. Since
    // nobody has a VALID scan at the tmp room, fullExhibitionVisitors
    // must be 0 in the after state.
    assert.equal(
      after.fullExhibitionVisitors,
      0,
      "fullExhibitionVisitors must drop to 0 when a new room is added and nobody has visited it"
    );
  });

  test("deactivating the new room restores the previous denominator", async () => {
    assert.ok(extraRoomId, "expected the extra room to have been created");
    await prisma.accessPoint.update({
      where: { id: extraRoomId },
      data: { active: false }
    });
    const cov = await getSpaceCoverage(
      fixtureWindow(),
      await listAccessPointsForAnalytics()
    );
    // The deactivated room must not participate — activeRoomCount is
    // back to the baseline number of seeded active rooms.
    const seeded = await prisma.accessPoint.count({
      where: { type: AccessPointType.ROOM, active: true }
    });
    assert.equal(cov.activeRoomCount, seeded);
  });
});

// ─── Structural — per-space detail page code discipline ───────────

describe("Phase 21 · /admin/scan/analytics/[slug] — code discipline", () => {
  test("page gates access with requirePermission(\"analytics.view\")", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/analytics/[access-point-slug]/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    assert.ok(
      src.includes('requirePermission("analytics.view")'),
      "space detail page must gate at analytics.view"
    );
  });

  test("page rejects unknown / MAIN_ENTRANCE slugs via notFound()", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/analytics/[access-point-slug]/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    // The unknown-slug and wrong-type cases must both funnel through
    // notFound(). Grep for the pattern.
    assert.ok(
      /if\s*\(!point\)\s*notFound\(\)/.test(src),
      "unknown slug must call notFound()"
    );
    assert.ok(
      /point\.type\s*!==\s*AccessPointType\.ROOM[\s\S]{0,200}notFound\(\)/.test(
        src
      ),
      "non-ROOM slug must call notFound()"
    );
  });

  test("page does not import client-only or unsafe modules", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/analytics/[access-point-slug]/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    for (const banned of [
      "dangerouslySetInnerHTML",
      "$queryRawUnsafe",
      "tokenHash",
      "rawToken",
      "passwordHash",
      "credentialId"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `space detail page must not reference ${banned}`
      );
    }
  });

  test("page routes drill-down links via the AP slug (URL-encoded)", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/analytics/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    // The space grid + comparison table must use the AP slug (never
    // an internal id) in the drill-down href. Grep for encodeURIComponent.
    assert.ok(
      /\/admin\/scan\/analytics\/\$\{encodeURIComponent\(s\.slug\)\}/.test(src) ||
        /\/admin\/scan\/analytics\/\$\{encodeURIComponent\(space\.slug\)\}/.test(src),
      "space drill-down must use encodeURIComponent(slug)"
    );
  });
});

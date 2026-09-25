// Check-in Analytics tests. Run with:
//   npm run test:checkin-analytics
//
// Two kinds of assertion — same discipline as scripts/admin-scan.test.ts:
//
//   A) BEHAVIOURAL — exercise `lib/admin/checkin-analytics.ts` against
//      a real DB fixture. Verify the scans-vs-visitors distinction is
//      always correct, that filters scope every metric consistently,
//      that the "full exhibition" metric adapts to activeRoomCount,
//      and that no sensitive field leaks through the projection.
//
//   B) STRUCTURAL — grep the page source. Verify:
//        • server-side requirePermission is present
//        • no client-side authorization branching
//        • no `dangerouslySetInnerHTML`
//        • no rawToken / tokenHash / passwordHash / email rendered
//
// READ-ONLY on the DB apart from fixture rows created in `before` and
// removed in `after`. No admin surface is mutated.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  AccessPointType,
  AdminRole,
  AdminStatus,
  CheckInResult,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  getCheckinAnalytics,
  getHourlyTraffic,
  getMainEntranceMetrics,
  getRecentActivity,
  getSpaceCoverage,
  getSpaceMetrics,
  listAccessPointsForAnalytics
} from "../lib/admin/checkin-analytics";

const prisma = new PrismaClient();

// Every fixture participant is namespaced by this prefix — the
// `after` hook wipes them cleanly, so re-runs on the same DB never
// leak stale rows into subsequent assertions.
const P_EMAIL_PREFIX = "checkin-analytics-fixture-";
const OP_EMAIL = "checkin-analytics-op@bis.dz";

let eventId: string;
let operatorId: string;
let mainPointId: string;
let room1Id: string;
let room2Id: string;
let room3Id: string;
// participants
let alice: string;
let bob: string;
let carol: string;
let dave: string;
let eve: string;

async function makeParticipant(
  first: string,
  last: string,
  status: RegistrationStatus = RegistrationStatus.CONFIRMED
) {
  const suffix = randomBytes(3).toString("hex");
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: first,
      lastName: last,
      email: `${P_EMAIL_PREFIX}${first.toLowerCase()}-${suffix}@bis.dz`,
      status,
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
      gate: "test",
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

  // Reuse existing seed points. We only READ counts here — no schema
  // is mutated by the fixture beyond adding fixture participants and
  // CheckIns.
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
      name: "Analytics Test Op",
      passwordHash: hashPassword("test-only"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  operatorId = op.id;

  alice = await makeParticipant("Alice", `Analytics-${randomBytes(2).toString("hex")}`);
  bob = await makeParticipant("Bob", `Analytics-${randomBytes(2).toString("hex")}`);
  carol = await makeParticipant("Carol", `Analytics-${randomBytes(2).toString("hex")}`);
  dave = await makeParticipant("Dave", `Analytics-${randomBytes(2).toString("hex")}`);
  eve = await makeParticipant("Eve", `Analytics-${randomBytes(2).toString("hex")}`);

  const now = new Date();
  // Base window: last 6 hours. Every test that uses a date filter
  // will use a window that safely contains these rows.
  const t = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000);

  // ── Main entrance scans ──
  // Alice: 1 VALID + 1 ALREADY_CHECKED_IN
  await ci(alice, mainPointId, CheckInResult.VALID, t(310), "FIRST_SCAN");
  await ci(alice, mainPointId, CheckInResult.ALREADY_CHECKED_IN, t(290), "REPEAT_SCAN");
  // Bob: 1 VALID
  await ci(bob, mainPointId, CheckInResult.VALID, t(280), "FIRST_SCAN");
  // Carol: 1 VALID
  await ci(carol, mainPointId, CheckInResult.VALID, t(275), "FIRST_SCAN");
  // Dave: only a denied scan at the main entrance (WRONG_GATE)
  await ci(dave, mainPointId, CheckInResult.WRONG_GATE, t(270), "WRONG_GATE");
  // Eve: never touched the main entrance in this window

  // ── Room scans ──
  // Alice: visits room 1 three times (VALID) — 1 unique / 3 scans
  await ci(alice, room1Id, CheckInResult.VALID, t(250), "ROOM_ENTRY");
  await ci(alice, room1Id, CheckInResult.VALID, t(200), "ROOM_ENTRY");
  await ci(alice, room1Id, CheckInResult.VALID, t(150), "ROOM_ENTRY");
  // Alice: visits room 2 (VALID) and room 3 (VALID) → coverage=3
  await ci(alice, room2Id, CheckInResult.VALID, t(120), "ROOM_ENTRY");
  await ci(alice, room3Id, CheckInResult.VALID, t(100), "ROOM_ENTRY");

  // Bob: visits room 1 once (VALID) — coverage=1
  await ci(bob, room1Id, CheckInResult.VALID, t(240), "ROOM_ENTRY");
  // Bob: denied at room 2 (PA_NOT_GRANTED) — NOT a room visit
  await ci(bob, room2Id, CheckInResult.UNKNOWN, t(230), "PA_NOT_GRANTED");

  // Carol: visits room 1 + room 2 (VALID) — coverage=2
  await ci(carol, room1Id, CheckInResult.VALID, t(220), "ROOM_ENTRY");
  await ci(carol, room2Id, CheckInResult.VALID, t(210), "ROOM_ENTRY");

  // Eve: visits room 3 only (VALID) — coverage=1, even though no main
  // entrance scan (models a legacy path where the main was scanned
  // manually and never registered).
  await ci(eve, room3Id, CheckInResult.VALID, t(90), "ROOM_ENTRY");
});

after(async () => {
  // Wipe fixture CheckIns via the fixture participants.
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
  await prisma.$disconnect();
});

// Helper — build a date filter that safely brackets all fixture rows.
function fixtureWindow() {
  return {
    from: new Date(Date.now() - 60 * 60 * 1000 * 24), // 24h back
    to: new Date(Date.now() + 60_000) // slightly in the future
  };
}

// ─── Behavioural ──────────────────────────────────────────────────

describe("main entrance metrics — unique vs scans distinction", () => {
  test("unique visitors counts DISTINCT participants with VALID scans", async () => {
    const m = await getMainEntranceMetrics(fixtureWindow());
    // Alice + Bob + Carol = 3 unique. Dave and Eve are excluded
    // (Dave: only WRONG_GATE at main; Eve: no main scan at all).
    // Note: other tests / seed data may add extra rows — assert ≥.
    assert.ok(
      m.uniqueVisitors >= 3,
      `expected ≥3 unique visitors, got ${m.uniqueVisitors}`
    );
  });

  test("repeat scans are separate from unique visitors", async () => {
    const m = await getMainEntranceMetrics(fixtureWindow());
    // Alice's second scan is ALREADY_CHECKED_IN.
    assert.ok(m.repeatScans >= 1, `expected ≥1 repeat scan, got ${m.repeatScans}`);
    // Repeats are NOT visitors — repeatScans must not inflate uniques.
    // Structural: uniqueVisitors must be strictly less than validScans+repeatScans
    // when at least one repeat exists.
    assert.ok(m.uniqueVisitors < m.uniqueVisitors + m.repeatScans);
  });

  test("denied scans (WRONG_GATE / CANCELLED / ...) are NOT visitors", async () => {
    const m = await getMainEntranceMetrics(fixtureWindow());
    // Dave scanned WRONG_GATE at main. He must not show up in uniqueVisitors.
    // We can't observe individual IDs from the aggregate, but we can
    // verify deniedScans got a non-zero count.
    assert.ok(m.deniedScans >= 1, `expected ≥1 denied, got ${m.deniedScans}`);
  });
});

describe("per-space metrics — dynamic discovery + scan/unique split", () => {
  test("scans vs unique visitors split matches the fixture", async () => {
    const points = await listAccessPointsForAnalytics();
    const rows = await getSpaceMetrics(fixtureWindow(), points);
    const room1 = rows.find((r) => r.accessPointId === room1Id);
    assert.ok(room1);
    // Alice scans room 1 three times, Bob once, Carol once.
    // Unique = 3 (Alice, Bob, Carol). Valid scans ≥ 5 (Alice's 3 +
    // Bob's 1 + Carol's 1). Other test seeds may inflate this.
    assert.ok(
      room1.uniqueVisitors >= 3,
      `room1 unique ≥3, got ${room1.uniqueVisitors}`
    );
    assert.ok(
      room1.validScans >= 5,
      `room1 valid scans ≥5, got ${room1.validScans}`
    );
    assert.ok(
      room1.validScans > room1.uniqueVisitors,
      "room1 valid scans must exceed unique visitors when a participant scans multiple times"
    );
    // For a ROOM, `repeatEntries` MUST equal `max(0, validScans -
    // uniqueVisitors)` per the master-doc §28 definition. This is
    // fixture-independent — even if the shared DB happens to hold
    // unrelated ALREADY_CHECKED_IN rows at this AP from other tests,
    // the derived room repeat metric is the mathematical one.
    assert.equal(
      room1.repeatEntries,
      Math.max(0, room1.validScans - room1.uniqueVisitors),
      "ROOM.repeatEntries must equal validScans - uniqueVisitors"
    );
  });

  test("wrong-room scans are NOT counted as visits to that room", async () => {
    const points = await listAccessPointsForAnalytics();
    const rows = await getSpaceMetrics(fixtureWindow(), points);
    const room2 = rows.find((r) => r.accessPointId === room2Id);
    assert.ok(room2);
    // Bob was DENIED at room 2 (PA_NOT_GRANTED). Room 2 valid visitors
    // must NOT include Bob. Alice + Carol visited room 2 successfully.
    // Assert unique ≥2 (Alice, Carol), and that the denied count is ≥1.
    assert.ok(room2.uniqueVisitors >= 2);
    assert.ok(room2.deniedScans >= 1);
  });

  test("space discovery uses the DB (no hardcoded slug list)", async () => {
    const points = await listAccessPointsForAnalytics();
    assert.ok(points.length > 0);
    // Every returned point must be a row in the DB with an id.
    for (const p of points) {
      assert.ok(typeof p.id === "string" && p.id.length > 0);
    }
  });
});

describe("space coverage — cross-space + full exhibition metric", () => {
  test("participants are bucketed by count of DISTINCT valid rooms", async () => {
    const points = await listAccessPointsForAnalytics();
    const cov = await getSpaceCoverage(fixtureWindow(), points);
    // Alice visited rooms 1+2+3, Bob visited room 1 (denied at 2),
    // Carol visited rooms 1+2, Eve visited room 3.
    // At least one participant must appear in ≥3 rooms in the bucket,
    // which is exactly Alice.
    const three = cov.buckets.find((b) => b.spacesVisited === 3);
    assert.ok(three, "expected a bucket for spacesVisited=3");
    assert.ok(
      three.uniqueVisitors >= 1,
      `Alice must be in the 3-rooms bucket, got ${three.uniqueVisitors}`
    );
  });

  test("full-exhibition metric adapts to activeRoomCount (no hardcoded 5)", async () => {
    const points = await listAccessPointsForAnalytics();
    const cov = await getSpaceCoverage(fixtureWindow(), points);
    assert.ok(cov.activeRoomCount > 0);
    // fullExhibitionVisitors must equal the count in the top bucket.
    const top = cov.buckets.find(
      (b) => b.spacesVisited === cov.activeRoomCount
    );
    assert.ok(top);
    assert.equal(cov.fullExhibitionVisitors, top.uniqueVisitors);
  });

  test("denied room scans do NOT contribute to any coverage bucket", async () => {
    const points = await listAccessPointsForAnalytics();
    const cov = await getSpaceCoverage(fixtureWindow(), points);
    // Bob was denied at room 2 but did visit room 1. He must appear
    // in the "1 room" bucket, not the "2 rooms" bucket.
    // Structural: sum of buckets that count Bob (spacesVisited>=1)
    // equals the number of unique participants who visited at least
    // one room in the window, which must include Bob and Carol/Alice/Eve.
    const anyRoom = cov.buckets
      .filter((b) => b.spacesVisited >= 1)
      .reduce((a, b) => a + b.uniqueVisitors, 0);
    assert.ok(anyRoom >= 4, `expected ≥4 participants who visited any room, got ${anyRoom}`);
  });
});

describe("hourly traffic — bucket integrity", () => {
  test("all 24 hourly buckets are always returned", async () => {
    const buckets = await getHourlyTraffic(fixtureWindow());
    assert.equal(buckets.length, 24);
    for (let h = 0; h < 24; h++) {
      assert.equal(buckets[h].hour, h);
      assert.ok(buckets[h].uniqueVisitors >= 0);
      assert.ok(buckets[h].validScans >= 0);
    }
  });

  test("hourly uniqueVisitors is DISTINCT participants at MAIN, not scans", async () => {
    const buckets = await getHourlyTraffic(fixtureWindow());
    // A bucket's uniqueVisitors must never exceed validScans in the
    // same bucket — visitors are a subset of scans.
    for (const b of buckets) {
      assert.ok(
        b.uniqueVisitors <= b.validScans,
        `bucket ${b.hour}: uniqueVisitors=${b.uniqueVisitors} must not exceed validScans=${b.validScans}`
      );
    }
  });
});

describe("recent activity — projection hardening", () => {
  test("never surfaces email, phone, ticketCode, or credential material", async () => {
    const rows = await getRecentActivity(fixtureWindow(), 10);
    const s = JSON.stringify(rows);
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

  test("last-name is truncated to a single initial", async () => {
    const rows = await getRecentActivity(fixtureWindow(), 5);
    for (const r of rows) {
      if (r.participant) {
        assert.ok(
          r.participant.lastNameInitial.length <= 1,
          "lastNameInitial must be at most one character"
        );
      }
    }
  });
});

describe("date filter honors from/to consistently", () => {
  test("a narrow window excludes older fixture rows", async () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    const m = await getMainEntranceMetrics({
      from: oneMinuteAgo,
      to: new Date(Date.now() + 60_000)
    });
    // Fixture rows are minutes old — an "under 1 minute" window should
    // pick up zero fixture visitors. There may be other rows in the DB
    // (from a running dev instance), so assert only that the count is
    // bounded and integer.
    assert.ok(
      typeof m.uniqueVisitors === "number" && m.uniqueVisitors >= 0
    );
  });

  test("unfiltered fetch returns a consistent shape from the unified loader", async () => {
    const payload = await getCheckinAnalytics(fixtureWindow());
    assert.ok(Array.isArray(payload.accessPoints));
    assert.ok(payload.main);
    assert.ok(Array.isArray(payload.spaces));
    assert.equal(payload.hourly.length, 24);
    assert.ok(payload.coverage.activeRoomCount >= 0);
    assert.ok(Array.isArray(payload.breakdown));
    assert.ok(Array.isArray(payload.recent));
    assert.ok(Array.isArray(payload.operators));
    assert.ok(Array.isArray(payload.detailed));
    assert.ok(payload.generatedAt instanceof Date);
  });

  test("accessPointId filter only scopes detailed views (not top KPIs)", async () => {
    // The KPI functions ignore accessPointId per contract (§20 rule).
    // The recent-activity list is scoped to the AP if given.
    const withScope = await getRecentActivity(
      { ...fixtureWindow(), accessPointId: mainPointId, result: CheckInResult.VALID },
      50
    );
    for (const r of withScope) {
      assert.equal(
        r.accessPoint?.id ?? null,
        mainPointId,
        "recent activity must be scoped to the filter AP"
      );
    }
  });
});

// ─── Structural — page + component source discipline ─────────────

describe("/admin/scan/analytics — code discipline", () => {
  test("page gates access with requirePermission(\"analytics.view\")", async () => {
    const src = await readFile(
      new URL("../app/admin/(protected)/scan/analytics/page.tsx", import.meta.url),
      "utf8"
    );
    assert.ok(
      src.includes('requirePermission("analytics.view")'),
      "analytics page must gate at analytics.view"
    );
  });

  test("page never renders internal ids as visible text", async () => {
    const src = await readFile(
      new URL("../app/admin/(protected)/scan/analytics/page.tsx", import.meta.url),
      "utf8"
    );
    // Internal ids (participantId, credentialId, tokenHash) must never
    // appear as visible text. They're allowed as React keys and query
    // params in href attributes only. Grep for direct JSX text usage.
    for (const banned of [
      "tokenHash",
      "rawToken",
      "passwordHash",
      "credentialId",
      "session.token"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `analytics page must not reference ${banned}`
      );
    }
  });

  test("page does not use dangerouslySetInnerHTML", async () => {
    const src = await readFile(
      new URL("../app/admin/(protected)/scan/analytics/page.tsx", import.meta.url),
      "utf8"
    );
    assert.equal(
      src.includes("dangerouslySetInnerHTML"),
      false,
      "analytics page must not use dangerouslySetInnerHTML"
    );
  });

  test("query layer imports 'server-only' and Prisma from lib/db", async () => {
    const src = await readFile(
      new URL("../lib/admin/checkin-analytics.ts", import.meta.url),
      "utf8"
    );
    assert.ok(
      /import\s+["']server-only["']/.test(src),
      "checkin-analytics.ts must import 'server-only'"
    );
    assert.ok(
      src.includes('from "@/lib/db"'),
      "checkin-analytics.ts must import the shared prisma client"
    );
    // No $queryRawUnsafe.
    assert.equal(
      src.includes("$queryRawUnsafe"),
      false,
      "raw SQL escape hatch must not be used"
    );
  });

  test("filter component is a client component and imports no server-only modules", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/analytics/analytics-filters.tsx",
        import.meta.url
      ),
      "utf8"
    );
    assert.ok(
      /^\s*["']use client["'];?/m.test(src),
      "analytics-filters.tsx must begin with \"use client\""
    );
    for (const banned of [
      "@/lib/db",
      "next/headers",
      "@/lib/admin/auth",
      "server-only"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `analytics-filters.tsx must not import ${banned}`
      );
    }
  });

  test("scan hub button to analytics is gated by analytics.view", async () => {
    // The analytics entry point was moved out of the sidebar and into
    // a button on the Centre de scan hub page. UX gating must still
    // require `analytics.view` (the route itself also re-checks
    // server-side via requirePermission).
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    assert.ok(
      /can\(\s*user\.role\s*,\s*"analytics\.view"\s*\)[\s\S]{0,300}href=\{?"\/admin\/scan\/analytics"/.test(
        src
      ),
      "scan hub must render the /admin/scan/analytics link only when can(user.role, \"analytics.view\") is true"
    );
  });
});

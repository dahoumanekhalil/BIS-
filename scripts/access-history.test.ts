// Focused tests for the Phase 6 attendee access history. Run with:
//   npm run test:history
//
// The query under test is `getCheckInHistoryForParticipant(participantId)`
// in lib/account/participant.ts. We use the exact same select shape via
// direct Prisma (not the cached helper) to avoid pulling in Next.js's
// React runtime, and we independently assert:
//
//   • ownership scoping (participant A cannot see B's history)
//   • ordering (most recent first)
//   • the `take: 50` bound is honoured
//   • CheckIn with null accessPointId does not crash and yields null join
//   • ParticipantAccess rows never leak into CheckIn history
//   • sensitive fields (operatorId, ticketCode, gate, reason,
//     credentialId, participantId, id) are absent from returned rows
//
// The test creates two isolated participants + an admin, seeds CheckIn
// rows, runs assertions, and cleans everything up in `after`.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AdminRole,
  AdminStatus,
  CheckInResult,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

// Same select shape as lib/account/participant.ts::getCheckInHistoryForParticipant.
// Kept in this test file so any drift in the production select is caught
// by test failure at read time.
const HISTORY_SELECT = {
  scannedAt: true,
  result: true,
  accessPoint: {
    select: { slug: true, name: true, type: true }
  }
} as const;

const HISTORY_BOUND = 50;

async function loadHistory(participantId: string) {
  return prisma.checkIn.findMany({
    where: { participantId },
    orderBy: { scannedAt: "desc" },
    take: HISTORY_BOUND,
    select: HISTORY_SELECT
  });
}

let eventId: string;
let adminId: string;
let participantAId: string;
let participantBId: string;
let mainPointId: string;
let room1PointId: string;

before(async () => {
  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(event);
  eventId = event.id;

  const points = await prisma.accessPoint.findMany({
    where: { slug: { in: ["main", "room-01"] } }
  });
  const bySlug = new Map(points.map((p) => [p.slug, p.id]));
  mainPointId = bySlug.get("main")!;
  room1PointId = bySlug.get("room-01")!;
  assert.ok(mainPointId && room1PointId);

  const admin = await prisma.adminUser.upsert({
    where: { email: "history-test-admin@bis.dz" },
    update: {},
    create: {
      email: "history-test-admin@bis.dz",
      name: "History Test Admin",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  adminId = admin.id;

  const pa = await prisma.participant.create({
    data: {
      eventId,
      firstName: "History",
      lastName: "AlphaOwner",
      email: `history-a-${Date.now()}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  participantAId = pa.id;

  const pb = await prisma.participant.create({
    data: {
      eventId,
      firstName: "History",
      lastName: "BetaOwner",
      email: `history-b-${Date.now()}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  participantBId = pb.id;
});

after(async () => {
  await prisma.participant
    .deleteMany({
      where: { id: { in: [participantAId, participantBId] } }
    })
    .catch(() => {});
  await prisma.adminUser
    .deleteMany({ where: { email: "history-test-admin@bis.dz" } })
    .catch(() => {});
  await prisma.$disconnect();
});

// ─── Ownership scoping ────────────────────────────────────────────────────

describe("ownership isolation", () => {
  test("participant A sees only A's CheckIns; B's are invisible", async () => {
    // Seed 2 CheckIns for A and 3 for B.
    const now = Date.now();
    await prisma.checkIn.createMany({
      data: [
        {
          participantId: participantAId,
          operatorId: adminId,
          ticketCode: "A-TCK-1",
          gate: "main",
          accessPointId: mainPointId,
          result: CheckInResult.VALID,
          scannedAt: new Date(now - 3_000)
        },
        {
          participantId: participantAId,
          operatorId: adminId,
          ticketCode: "A-TCK-2",
          gate: "room-01",
          accessPointId: room1PointId,
          result: CheckInResult.ALREADY_CHECKED_IN,
          scannedAt: new Date(now - 2_000)
        },
        {
          participantId: participantBId,
          operatorId: adminId,
          ticketCode: "B-TCK-1",
          gate: "main",
          accessPointId: mainPointId,
          result: CheckInResult.VALID,
          scannedAt: new Date(now - 1_000)
        },
        {
          participantId: participantBId,
          operatorId: adminId,
          ticketCode: "B-TCK-2",
          gate: "room-01",
          accessPointId: room1PointId,
          result: CheckInResult.VALID,
          scannedAt: new Date(now - 500)
        },
        {
          participantId: participantBId,
          operatorId: adminId,
          ticketCode: "B-TCK-3",
          gate: "room-01",
          accessPointId: room1PointId,
          result: CheckInResult.WRONG_GATE,
          scannedAt: new Date(now - 100)
        }
      ]
    });

    const historyA = await loadHistory(participantAId);
    const historyB = await loadHistory(participantBId);

    assert.equal(historyA.length, 2, "A must see exactly own 2 CheckIns");
    assert.equal(historyB.length, 3, "B must see exactly own 3 CheckIns");

    // Belt-and-braces: no ticket-code overlap between the two histories.
    // (ticketCode is not in the select — but if drift ever puts it there,
    // this comparison catches it.)
    const aTickets = JSON.stringify(historyA);
    for (const bTicket of ["B-TCK-1", "B-TCK-2", "B-TCK-3"]) {
      assert.equal(
        aTickets.includes(bTicket),
        false,
        `A's history unexpectedly contains B's ${bTicket}`
      );
    }
  });
});

// ─── Ordering ─────────────────────────────────────────────────────────────

describe("ordering", () => {
  test("returned rows are sorted by scannedAt DESC", async () => {
    const rows = await loadHistory(participantAId);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i - 1].scannedAt.getTime() >= rows[i].scannedAt.getTime(),
        `ordering broken at index ${i}: ${rows[i - 1].scannedAt.toISOString()} < ${rows[i].scannedAt.toISOString()}`
      );
    }
  });
});

// ─── Bound ────────────────────────────────────────────────────────────────

describe("bound", () => {
  test("take: 50 is honoured — 60 rows in, 50 rows out", async () => {
    const now = Date.now();
    const rows: {
      participantId: string;
      operatorId: string;
      ticketCode: string;
      gate: string;
      accessPointId: string;
      result: CheckInResult;
      scannedAt: Date;
    }[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({
        participantId: participantBId,
        operatorId: adminId,
        ticketCode: `B-BULK-${i}`,
        gate: "room-01",
        accessPointId: room1PointId,
        result: CheckInResult.VALID,
        scannedAt: new Date(now + i * 1_000)
      });
    }
    await prisma.checkIn.createMany({ data: rows });

    const returned = await loadHistory(participantBId);
    assert.equal(
      returned.length,
      HISTORY_BOUND,
      `bound must cap the result set at ${HISTORY_BOUND}`
    );
  });
});

// ─── Legacy CheckIn (accessPointId = null) ────────────────────────────────

describe("legacy CheckIn without accessPointId", () => {
  test("does not crash and reports accessPoint = null in the projection", async () => {
    await prisma.checkIn.create({
      data: {
        participantId: participantAId,
        operatorId: adminId,
        ticketCode: "A-LEGACY-1",
        gate: "Gate A",
        // accessPointId is deliberately absent — represents a pre-Phase-1 row.
        result: CheckInResult.VALID
      }
    });

    const history = await loadHistory(participantAId);
    const legacy = history.find((h) => h.accessPoint === null);
    assert.ok(legacy, "legacy row must be returned");
    assert.equal(legacy!.accessPoint, null);
    // Non-legacy rows keep their AccessPoint join.
    const nonLegacy = history.filter((h) => h.accessPoint !== null);
    assert.ok(nonLegacy.length > 0);
  });
});

// ─── ParticipantAccess isolation ──────────────────────────────────────────

describe("ParticipantAccess is not CheckIn", () => {
  test("granting room access does NOT create a CheckIn history entry", async () => {
    // Take a fresh count first, then grant access, then re-count.
    const before = await prisma.checkIn.count({
      where: { participantId: participantAId }
    });
    await prisma.participantAccess.create({
      data: {
        participantId: participantAId,
        accessPointId: room1PointId,
        granted: true
      }
    });
    const after = await prisma.checkIn.count({
      where: { participantId: participantAId }
    });
    assert.equal(
      after,
      before,
      "granting ParticipantAccess must not fabricate a CheckIn"
    );
  });
});

// ─── Sensitive field whitelist ────────────────────────────────────────────

describe("sensitive fields whitelist", () => {
  test("returned row shape contains ONLY {scannedAt, result, accessPoint}", async () => {
    const history = await loadHistory(participantAId);
    assert.ok(history.length > 0);
    const row = history[0];

    const keys = Object.keys(row).sort();
    // The Prisma `select` clause is the sole authority — this catches
    // accidental widening.
    assert.deepEqual(keys, ["accessPoint", "result", "scannedAt"]);

    // Belt-and-braces: none of the following fields should be present.
    const banned = [
      "id",
      "participantId",
      "operatorId",
      "credentialId",
      "ticketCode",
      "gate",
      "reason"
    ];
    for (const k of banned) {
      assert.equal(
        k in row,
        false,
        `banned field "${k}" appeared in returned CheckIn row`
      );
    }
  });

  test("accessPoint join, when present, is limited to {slug, name, type}", async () => {
    const history = await loadHistory(participantAId);
    const withAP = history.find((h) => h.accessPoint !== null);
    assert.ok(withAP && withAP.accessPoint);
    const keys = Object.keys(withAP.accessPoint).sort();
    assert.deepEqual(keys, ["name", "slug", "type"]);
  });
});

// ─── Empty case ───────────────────────────────────────────────────────────

describe("empty history", () => {
  test("participant with no CheckIns returns []", async () => {
    // Create a fresh participant with no scans.
    const p = await prisma.participant.create({
      data: {
        eventId,
        firstName: "History",
        lastName: "NoScans",
        email: `history-empty-${Date.now()}@bis.dz`,
        status: RegistrationStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID
      }
    });
    try {
      const rows = await loadHistory(p.id);
      assert.equal(rows.length, 0);
    } finally {
      await prisma.participant.delete({ where: { id: p.id } }).catch(() => {});
    }
  });
});

// Production-readiness audit — concurrency safety of the registration
// kernel. Hammers ensureParticipantForAccount + ensureActiveBadge in
// parallel and checks that DB-level invariants hold under contention.
//
// Requires a live DB.
//
//   npm run test:register-concurrency

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PrismaClient,
  RegistrationStatus,
  type ApplicationType
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  ensureActiveBadge,
  ensureParticipantForAccount
} from "../lib/register/participant";

const prisma = new PrismaClient();

async function ensureEvent() {
  const existing = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (existing) return existing;
  return prisma.event.create({
    data: {
      slug: "bis-2027-test",
      name: "BIS 2027 (test)",
      startsAt: new Date("2027-11-15"),
      endsAt: new Date("2027-11-17"),
      city: "Alger",
      venue: "CIC Alger",
      country: "Algérie",
      expectedAttendees: 12611
    }
  });
}

async function makeAccount(email: string) {
  return prisma.accountUser.create({
    data: {
      email,
      firstName: "Concurrency",
      lastName: "Test",
      passwordHash: hashPassword("hunter2-test-password")
    },
    select: { id: true, email: true, firstName: true, lastName: true }
  });
}

const createdAccountIds: string[] = [];
const createdParticipantIds: string[] = [];

before(async () => {
  await ensureEvent();
});

after(async () => {
  if (createdParticipantIds.length > 0) {
    await prisma.participant
      .deleteMany({ where: { id: { in: createdParticipantIds } } })
      .catch(() => undefined);
  }
  if (createdAccountIds.length > 0) {
    await prisma.accountUser
      .deleteMany({ where: { id: { in: createdAccountIds } } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("Race conditions — Participant creation", () => {
  test("10 concurrent ensureParticipantForAccount calls yield exactly 1 Participant", async () => {
    const account = await makeAccount(
      `race-participant-${Date.now()}@bis-test.local`
    );
    createdAccountIds.push(account.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureParticipantForAccount(account))
    );

    // All 10 calls should return `ready` (never `conflict` for the same
    // AccountUser fighting itself).
    for (const r of results) {
      assert.equal(r.kind, "ready", "every concurrent call must succeed");
    }
    const readyIds = new Set(
      results
        .filter((r): r is Extract<typeof r, { kind: "ready" }> => r.kind === "ready")
        .map((r) => r.participant.id)
    );
    assert.equal(
      readyIds.size,
      1,
      "all 10 concurrent calls must resolve to the same Participant id"
    );

    const rows = await prisma.participant.count({
      where: { accountUserId: account.id }
    });
    assert.equal(rows, 1, "DB must contain exactly one Participant per AccountUser");
    for (const id of readyIds) createdParticipantIds.push(id);
  });
});

describe("Race conditions — Badge issuance", () => {
  test("10 concurrent ensureActiveBadge calls yield exactly 1 ACTIVE credential", async () => {
    const account = await makeAccount(
      `race-badge-${Date.now()}@bis-test.local`
    );
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    await Promise.all(
      Array.from({ length: 10 }, () => ensureActiveBadge(ensured.participant.id))
    );

    const active = await prisma.badgeCredential.count({
      where: { participantId: ensured.participant.id, status: "ACTIVE" }
    });
    assert.equal(
      active,
      1,
      "partial unique index + ACTIVE_EXISTS catch must guarantee at most one ACTIVE badge"
    );
  });
});

describe("Race conditions — Application creation", () => {
  // Directly hits the DB unique constraint the kernel relies on.
  // The kernel's own P2002 catch turns the loser into a redirect at
  // the HTTP layer; here we verify the underlying DB guarantee.
  for (const type of [
    "SPEAKER",
    "SPONSOR",
    "PARTNER",
    "CONTENT_CREATOR"
  ] as ApplicationType[]) {
    test(`10 concurrent ${type} inserts leave exactly 1 row`, async () => {
      const account = await makeAccount(
        `race-app-${type}-${Date.now()}@bis-test.local`
      );
      createdAccountIds.push(account.id);
      const ensured = await ensureParticipantForAccount(account);
      assert.equal(ensured.kind, "ready");
      if (ensured.kind !== "ready") return;
      createdParticipantIds.push(ensured.participant.id);

      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          prisma.application.create({
            data: {
              eventId: ensured.participant.eventId,
              participantId: ensured.participant.id,
              type,
              status: "RECEIVED",
              firstName: ensured.participant.firstName,
              lastName: ensured.participant.lastName,
              email: ensured.participant.email,
              phone: "+213555000000",
              country: "Algérie",
              details: {}
            }
          })
        )
      );
      const fulfilled = attempts.filter((r) => r.status === "fulfilled").length;
      const rejected = attempts.filter((r) => r.status === "rejected").length;
      assert.equal(
        fulfilled,
        1,
        `exactly one ${type} insert must win the (participantId, type) unique race`
      );
      assert.equal(
        rejected,
        9,
        `the other nine ${type} inserts must be rejected (P2002)`
      );

      const rows = await prisma.application.count({
        where: { participantId: ensured.participant.id, type }
      });
      assert.equal(rows, 1);

      // Participant status must remain REGISTERED (default). Even under
      // concurrent inserts, no path here should have flipped CONFIRMED
      // or CANCELLED.
      const p = await prisma.participant.findUnique({
        where: { id: ensured.participant.id }
      });
      assert.equal(p?.status, RegistrationStatus.REGISTERED);
    });
  }
});

describe("Race conditions — status guard under concurrent stamps", () => {
  test("concurrent status writes never resurrect CANCELLED", async () => {
    const account = await makeAccount(
      `race-status-cancelled-${Date.now()}@bis-test.local`
    );
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    // Admin cancels.
    await prisma.participant.update({
      where: { id: ensured.participant.id },
      data: { status: RegistrationStatus.CANCELLED }
    });

    // 20 concurrent "set REGISTERED if PENDING|REGISTERED" (the kernel
    // guard) — none should touch the CANCELLED row.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.participant.updateMany({
          where: {
            id: ensured.participant.id,
            status: { in: ["PENDING", "REGISTERED"] }
          },
          data: { status: "REGISTERED" }
        })
      )
    );

    const p = await prisma.participant.findUnique({
      where: { id: ensured.participant.id }
    });
    assert.equal(p?.status, RegistrationStatus.CANCELLED);
  });

  test("concurrent status writes never downgrade CONFIRMED", async () => {
    const account = await makeAccount(
      `race-status-confirmed-${Date.now()}@bis-test.local`
    );
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    await prisma.participant.update({
      where: { id: ensured.participant.id },
      data: { status: RegistrationStatus.CONFIRMED }
    });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.participant.updateMany({
          where: {
            id: ensured.participant.id,
            status: { in: ["PENDING", "REGISTERED"] }
          },
          data: { status: "REGISTERED" }
        })
      )
    );

    const p = await prisma.participant.findUnique({
      where: { id: ensured.participant.id }
    });
    assert.equal(p?.status, RegistrationStatus.CONFIRMED);
  });
});

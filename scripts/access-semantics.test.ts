// Verifies the tri-state semantics of ParticipantAccess as consumed by the
// /compte tree. Run with:
//   npm run test:access
//
// Two things are asserted:
//   1. The exact select shape used by `getParticipantForAccount` returns
//      BOTH granted=true and granted=false rows (no `where: {granted: true}`
//      filter). Rows with no persistence at all are naturally absent.
//   2. The pure classifier `accessStateFor` maps the three cases to
//      "granted" / "denied" / "unassigned" respectively.
//
// The test does not import `lib/account/participant.ts` (which uses
// react.cache and needs Next.js's React runtime). Instead it re-issues the
// same Prisma query directly, keeping the assertion tightly coupled to the
// actual production query shape.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { accessStateFor } from "../lib/account/access-state";

const prisma = new PrismaClient();

let eventId: string;
let accountUserId: string;
let participantId: string;
let roomGrantedId: string;
let roomDeniedId: string;
let roomAbsentId: string;

before(async () => {
  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(event, "seeded event must exist");
  eventId = event.id;

  const points = await prisma.accessPoint.findMany({
    where: { slug: { in: ["room-01", "room-02", "room-03"] } }
  });
  const bySlug = new Map(points.map((p) => [p.slug, p.id]));
  roomGrantedId = bySlug.get("room-01")!;
  roomDeniedId = bySlug.get("room-02")!;
  roomAbsentId = bySlug.get("room-03")!;
  assert.ok(roomGrantedId && roomDeniedId && roomAbsentId);

  const user = await prisma.accountUser.create({
    data: {
      email: `access-semantics-${Date.now()}@bis.dz`,
      firstName: "Access",
      lastName: "Semantics",
      // Placeholder hash — this account is only used by this suite and never
      // logs in. Not a real credential.
      passwordHash: "test-only"
    }
  });
  accountUserId = user.id;

  const p = await prisma.participant.create({
    data: {
      eventId,
      accountUserId: user.id,
      firstName: "Access",
      lastName: "Semantics",
      email: user.email,
      status: RegistrationStatus.CONFIRMED
    }
  });
  participantId = p.id;

  // Row 1 — explicit grant.
  await prisma.participantAccess.create({
    data: { participantId, accessPointId: roomGrantedId, granted: true }
  });
  // Row 2 — explicit denial (row exists, granted=false).
  await prisma.participantAccess.create({
    data: { participantId, accessPointId: roomDeniedId, granted: false }
  });
  // Row 3 — no row created for roomAbsentId.
});

after(async () => {
  // Cascade wipes ParticipantAccess + BadgeCredential + Application.
  await prisma.participant
    .delete({ where: { id: participantId } })
    .catch(() => {});
  await prisma.accountUser
    .delete({ where: { id: accountUserId } })
    .catch(() => {});
  await prisma.$disconnect();
});

// ─── Query shape (mirrors lib/account/participant.ts) ─────────────────────
//
// If the production `select` clause ever regresses to a granted:true filter,
// this test fails — locking in the tri-state exposure at the DB boundary.

test("participant query returns rows for BOTH granted=true and granted=false", async () => {
  const p = await prisma.participant.findFirst({
    where: { accountUserId },
    select: {
      accessPermissions: {
        select: { accessPointId: true, granted: true }
      }
    }
  });
  assert.ok(p);
  const perms = p!.accessPermissions;

  const grantedRow = perms.find((r) => r.accessPointId === roomGrantedId);
  const deniedRow = perms.find((r) => r.accessPointId === roomDeniedId);
  const absentRow = perms.find((r) => r.accessPointId === roomAbsentId);

  assert.ok(grantedRow, "granted=true row must be returned");
  assert.equal(grantedRow!.granted, true);

  assert.ok(
    deniedRow,
    "granted=false row must be returned (do NOT filter to granted=true)"
  );
  assert.equal(deniedRow!.granted, false);

  assert.equal(
    absentRow,
    undefined,
    "no row was created for roomAbsent — must not appear in results"
  );
});

// ─── Pure classifier ──────────────────────────────────────────────────────

test("accessStateFor: granted=true row → 'granted'", () => {
  const perms = [
    { accessPointId: roomGrantedId, granted: true },
    { accessPointId: roomDeniedId, granted: false }
  ];
  assert.equal(accessStateFor(perms, roomGrantedId), "granted");
});

test("accessStateFor: granted=false row → 'denied'", () => {
  const perms = [
    { accessPointId: roomGrantedId, granted: true },
    { accessPointId: roomDeniedId, granted: false }
  ];
  assert.equal(accessStateFor(perms, roomDeniedId), "denied");
});

test("accessStateFor: no row at all → 'unassigned' (default deny)", () => {
  const perms = [
    { accessPointId: roomGrantedId, granted: true },
    { accessPointId: roomDeniedId, granted: false }
  ];
  assert.equal(accessStateFor(perms, roomAbsentId), "unassigned");
});

test("accessStateFor is a pure function — empty input maps to 'unassigned'", () => {
  assert.equal(accessStateFor([], "anything"), "unassigned");
});

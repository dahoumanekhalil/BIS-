// Domain + admin-boundary tests for the FREE-only room registration
// service. Run with:
//   npm run test:room-registration-actions
//
// BIS 2027 is FREE-only. This suite exercises the two remaining
// public entrypoints of `lib/room-registration/service.ts`:
//
//   • initRegistration — self-service FREE registration, idempotent,
//     re-registers a CANCELLED row.
//   • cancel — admin- or attendee-initiated cancellation.
//
// Server actions themselves are not invoked here (they call
// `getCurrentAccount()` / `requirePermission(...)`, which read cookies
// via next/headers — no request context under node:test). Their
// downstream logic is the domain service, which IS exercised.
//
// Coverage:
//
//   Participant flow:
//     • FREE room registration → FREE_CONFIRMED + REGISTRATION-owned
//       ParticipantAccess granted.
//     • Duplicate init is idempotent (no duplicate rows).
//     • CANCELLED participant is rejected.
//     • MAIN_ENTRANCE is rejected (NOT_A_ROOM).
//     • Inactive room is rejected.
//     • Cancel of FREE_CONFIRMED revokes REGISTRATION-owned access
//       and PRESERVES ADMIN-owned rows.
//     • Cancel of a CANCELLED row is idempotent no-op.
//     • Re-register after CANCELLED transitions the same row back.
//
//   Audit:
//     • Init records `transitioned: true` for a fresh create.
//     • Duplicate init records `transitioned: false`.
//     • Cancel records `transitioned: true`.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessGrantSource,
  AccessPointType,
  AdminRole,
  AdminStatus,
  PrismaClient,
  RegistrationStatus,
  RoomRegistrationStatus
} from "@prisma/client";
import { cancel, initRegistration } from "../lib/room-registration/service";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

let eventId: string;
let adminId: string;
const cleanup: Array<() => Promise<unknown>> = [];
let counter = 0;

before(async () => {
  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(event, "seeded event must exist");
  eventId = event.id;
  const admin = await prisma.adminUser.upsert({
    where: { email: "room-reg-actions-test@bis.dz" },
    update: { role: AdminRole.SUPER_ADMIN, status: AdminStatus.ACTIVE },
    create: {
      email: "room-reg-actions-test@bis.dz",
      name: "Room Reg Actions Test Admin",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE
    }
  });
  adminId = admin.id;
});

after(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
  await prisma.$disconnect();
});

async function makeParticipant(
  status: RegistrationStatus = RegistrationStatus.CONFIRMED
) {
  counter += 1;
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "RoomReg",
      lastName: `P${counter}`,
      email: `room-reg-actions-${Date.now()}-${counter}@bis.dz`,
      status
    }
  });
  cleanup.push(() => prisma.participant.delete({ where: { id: p.id } }));
  return p;
}

async function makeRoom(active = true) {
  counter += 1;
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `room-reg-actions-room-${Date.now()}-${counter}`,
      name: `RRA Room ${counter}`,
      type: AccessPointType.ROOM,
      active
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));
  return ap;
}

async function makeMainEntrance() {
  counter += 1;
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `room-reg-actions-main-${Date.now()}-${counter}`,
      name: `RRA Main ${counter}`,
      type: AccessPointType.MAIN_ENTRANCE
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));
  return ap;
}

// ─── Happy path ────────────────────────────────────────────────────────

test("initRegistration on FREE room → FREE_CONFIRMED + REGISTRATION-owned PA grant", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();

  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.FREE_CONFIRMED);

  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    },
    select: { granted: true, source: true }
  });
  assert.ok(pa);
  assert.equal(pa!.granted, true);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);
});

test("initRegistration is idempotent — no duplicate rows", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();

  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const rows = await prisma.roomRegistration.findMany({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(rows.length, 1, "must not create duplicate registration rows");
  assert.equal(rows[0].status, RoomRegistrationStatus.FREE_CONFIRMED);
});

// ─── Eligibility gates ────────────────────────────────────────────────

test("CANCELLED participant is rejected", async () => {
  const p = await makeParticipant(RegistrationStatus.CANCELLED);
  const ap = await makeRoom();

  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "PARTICIPANT_CANCELLED");
});

test("MAIN_ENTRANCE target rejected with NOT_A_ROOM", async () => {
  const p = await makeParticipant();
  const ap = await makeMainEntrance();

  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "NOT_A_ROOM");
});

test("inactive room is rejected", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom(false);

  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "ACCESS_POINT_INACTIVE");
});

// ─── Cancellation ─────────────────────────────────────────────────────

test("cancel of FREE_CONFIRMED revokes REGISTRATION-owned access", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const res = await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    reason: "admin_cancel"
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.CANCELLED);

  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    },
    select: { granted: true, source: true }
  });
  assert.ok(pa);
  assert.equal(pa!.granted, false, "REGISTRATION-owned PA row must be revoked");
});

test("cancel PRESERVES ADMIN-owned PA rows", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();

  // Simulate an admin grant PREDATING any registration.
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: true,
      source: AccessGrantSource.ADMIN,
      grantedById: adminId
    }
  });

  // Registering must not overwrite the ADMIN-owned row.
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const pa1 = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    },
    select: { source: true, granted: true }
  });
  assert.equal(pa1?.source, AccessGrantSource.ADMIN, "admin source preserved on init");
  assert.equal(pa1?.granted, true, "admin grant preserved on init");

  // And cancel must not touch it either.
  await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    reason: "admin_cancel"
  });
  const pa2 = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    },
    select: { source: true, granted: true }
  });
  assert.equal(pa2?.source, AccessGrantSource.ADMIN);
  assert.equal(pa2?.granted, true, "admin grant preserved on cancel");
});

test("cancel of already-CANCELLED row is an idempotent no-op", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    reason: "admin_cancel"
  });
  const res = await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    reason: "admin_cancel"
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.CANCELLED);
});

test("re-register after CANCELLED transitions the same row back to FREE_CONFIRMED", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();

  const r1 = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  const originalId = r1.value.id;

  await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    reason: "attendee_cancel"
  });

  const r2 = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.value.id, originalId, "must reuse the same registration row");
  assert.equal(r2.value.status, RoomRegistrationStatus.FREE_CONFIRMED);

  const rows = await prisma.roomRegistration.findMany({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(rows.length, 1, "unique constraint must ensure single row");
});

// ─── Audit ────────────────────────────────────────────────────────────

test("init writes AuditLog with transitioned=true for a fresh create", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();
  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // Give the fire-and-forget audit a moment to land.
  await new Promise((r) => setTimeout(r, 50));

  const log = await prisma.auditLog.findFirst({
    where: {
      entity: "RoomRegistration",
      entityId: res.value.id,
      action: "room-registration.init"
    },
    orderBy: { createdAt: "desc" }
  });
  assert.ok(log, "expected an audit log for the init");
  const meta = log!.meta as { transitioned?: boolean; after?: string } | null;
  assert.equal(meta?.transitioned, true);
  assert.equal(meta?.after, "FREE_CONFIRMED");
});

test("duplicate idempotent init writes AuditLog with transitioned=false", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  await new Promise((r) => setTimeout(r, 50));

  const logs = await prisma.auditLog.findMany({
    where: {
      entity: "RoomRegistration",
      entityId: res.value.id,
      action: "room-registration.init"
    },
    orderBy: { createdAt: "desc" },
    take: 2
  });
  assert.ok(logs.length >= 2, "expected at least two audit rows");
  const latest = logs[0].meta as { transitioned?: boolean } | null;
  assert.equal(latest?.transitioned, false);
});

test("cancel writes AuditLog with transitioned=true only when state changed", async () => {
  const p = await makeParticipant();
  const ap = await makeRoom();
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    reason: "admin_cancel"
  });

  await new Promise((r) => setTimeout(r, 50));

  const log = await prisma.auditLog.findFirst({
    where: {
      entity: "RoomRegistration",
      entityId: registrationId,
      action: "room-registration.cancel"
    },
    orderBy: { createdAt: "desc" }
  });
  assert.ok(log, "expected an audit log for the cancel");
  const meta = log!.meta as { transitioned?: boolean; after?: string } | null;
  assert.equal(meta?.transitioned, true);
  assert.equal(meta?.after, "CANCELLED");
});

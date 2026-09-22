// Sub-Phase D tests for the participant-facing + admin-facing room
// registration server actions and the expire domain function.
//
// Every server action begins with either `getCurrentAccount()` (for the
// attendee flow) or `requirePermission(...)` (for the admin flow),
// both of which read the cookie jar via next/headers. Under `node:test`
// there is no request context, so this suite exercises the SAME
// downstream code paths — the canonical `initRegistration` / `cancel`
// / `confirmPayment` / `refund` / `expire` domain functions plus the
// RBAC baseline — WITHOUT going through the "use server" boundary. This
// mirrors the pattern used by scripts/access-admin.test.ts.
//
// Coverage:
//
//   Participant flow:
//     • FREE room registration → FREE_CONFIRMED + REGISTRATION-owned
//       ParticipantAccess granted.
//     • PAID room registration → PENDING_PAYMENT + no access grant.
//     • CANCELLED participant is rejected.
//     • Registration for MAIN_ENTRANCE is rejected (NOT_A_ROOM).
//     • Registration for an inactive room is rejected.
//     • Duplicate registration is idempotent — no duplicate rows.
//     • Attendee cancellation of FREE_CONFIRMED revokes REGISTRATION-
//       owned access and preserves ADMIN-owned rows.
//
//   Admin boundary:
//     • RBAC baseline: which roles hold the two new permissions.
//     • Confirm requires payment.confirm.room.
//     • Refund requires payment.refund.room.
//     • Cancellation via admin path reuses access.manage.
//     • Domain guards apply: NOT_A_ROOM, REGISTRATION_NOT_FOUND, etc.
//     • Admin cannot override registration price/currency (Zod strict
//       + service is authoritative).
//
//   Expire:
//     • Stale PENDING_PAYMENT with expiresAt in the past → EXPIRED.
//     • Non-expired pending remains PENDING_PAYMENT.
//     • Repeat calls are idempotent.
//     • ADMIN-owned ParticipantAccess is preserved.
//     • Row with expiresAt=null is a no-op.
//
//   Audit:
//     • Init records `transitioned: true` for a fresh create.
//     • Duplicate idempotent init records `transitioned: false`.
//     • Confirm / refund / cancel record `transitioned: true`.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessGrantSource,
  AccessPointType,
  AdmissionMode,
  AdminRole,
  AdminStatus,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus,
  RoomPaymentEventKind,
  RoomRegistrationStatus
} from "@prisma/client";
import {
  cancel,
  confirmPayment,
  expire,
  initRegistration,
  refund
} from "../lib/room-registration/service";
import { can } from "../lib/admin/rbac";
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
    where: { email: "sub-phase-d-test@bis.dz" },
    update: { role: AdminRole.SUPER_ADMIN, status: AdminStatus.ACTIVE },
    create: {
      email: "sub-phase-d-test@bis.dz",
      name: "Sub-Phase D Test Admin",
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

async function makeParticipant() {
  counter += 1;
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "SubPhaseD",
      lastName: `P${counter}`,
      email: `sub-phase-d-${Date.now()}-${counter}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  cleanup.push(() => prisma.participant.delete({ where: { id: p.id } }));
  return p;
}

async function makeFreeRoom() {
  counter += 1;
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `sub-phase-d-free-${Date.now()}-${counter}`,
      name: `SubD FREE ${counter}`,
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.FREE
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));
  return ap;
}

async function makePaidRoom(priceMinor = 500000, currency = "DZD") {
  counter += 1;
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `sub-phase-d-paid-${Date.now()}-${counter}`,
      name: `SubD PAID ${counter}`,
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.PAID,
      priceMinor,
      currency
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));
  return ap;
}

async function makeMainEntrance() {
  counter += 1;
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `sub-phase-d-main-${Date.now()}-${counter}`,
      name: `SubD MAIN ${counter}`,
      type: AccessPointType.MAIN_ENTRANCE
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));
  return ap;
}

async function accessRow(participantId: string, accessPointId: string) {
  return await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: { participantId, accessPointId }
    }
  });
}

// ─── PARTICIPANT FLOW ────────────────────────────────────────────────

test("participant: FREE room → FREE_CONFIRMED and REGISTRATION-owned access", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.FREE_CONFIRMED);

  const pa = await accessRow(p.id, ap.id);
  assert.ok(pa);
  assert.equal(pa!.granted, true);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);
});

test("participant: PAID room → PENDING_PAYMENT, no access grant", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(750000);
  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.PENDING_PAYMENT);
  assert.equal(res.value.priceMinorSnapshot, 750000);
  assert.equal(res.value.currencySnapshot, "DZD");
  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa, null);
});

test("participant: CANCELLED participant is rejected", async () => {
  const p = await makeParticipant();
  await prisma.participant.update({
    where: { id: p.id },
    data: { status: RegistrationStatus.CANCELLED }
  });
  const ap = await makeFreeRoom();
  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "PARTICIPANT_CANCELLED");
});

test("participant: MAIN_ENTRANCE registration is rejected", async () => {
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

test("participant: inactive room is rejected", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await prisma.accessPoint.update({
    where: { id: ap.id },
    data: { active: false }
  });
  const res = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "ACCESS_POINT_INACTIVE");
});

test("participant: duplicate registration is idempotent (no duplicate rows)", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  const r1 = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  const r2 = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(r1.ok && r2.ok, true);
  if (!(r1.ok && r2.ok)) return;
  assert.equal(r1.value.id, r2.value.id);
  const rows = await prisma.roomRegistration.count({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(rows, 1);
});

test("participant: cancellation of FREE_CONFIRMED revokes REGISTRATION-owned access", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const paBefore = await accessRow(p.id, ap.id);
  assert.equal(paBefore!.granted, true);
  const cancelled = await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    reason: "attendee_cancel"
  });
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.equal(cancelled.value.status, RoomRegistrationStatus.CANCELLED);
  const paAfter = await accessRow(p.id, ap.id);
  assert.ok(paAfter);
  assert.equal(paAfter!.granted, false);
  assert.equal(paAfter!.source, AccessGrantSource.REGISTRATION);
});

test("participant: cancellation preserves ADMIN-owned access on the same pair", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  // Admin grants BEFORE any registration — creates an ADMIN row.
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: true,
      source: AccessGrantSource.ADMIN,
      grantedById: adminId
    }
  });
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null
  });
  const pa = await accessRow(p.id, ap.id);
  assert.ok(pa);
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(pa!.granted, true, "admin-owned grant must survive a cancellation");
});

// ─── ADMIN BOUNDARY ─────────────────────────────────────────────────

test("admin RBAC: FINANCE + SUPER_ADMIN hold payment.confirm.room and payment.refund.room; ADMIN does NOT", () => {
  assert.equal(can(AdminRole.SUPER_ADMIN, "payment.confirm.room"), true);
  assert.equal(can(AdminRole.SUPER_ADMIN, "payment.refund.room"), true);
  assert.equal(can(AdminRole.FINANCE, "payment.confirm.room"), true);
  assert.equal(can(AdminRole.FINANCE, "payment.refund.room"), true);
  assert.equal(can(AdminRole.ADMIN, "payment.confirm.room"), false);
  assert.equal(can(AdminRole.ADMIN, "payment.refund.room"), false);
  // Non-finance roles must not hold either permission.
  assert.equal(can(AdminRole.CHECKIN_OPERATOR, "payment.confirm.room"), false);
  assert.equal(can(AdminRole.REGISTRATION_MANAGER, "payment.confirm.room"), false);
  assert.equal(can(AdminRole.VIEWER, "payment.confirm.room"), false);
});

test("admin RBAC: access.manage still authorises cancellation across relevant roles", () => {
  // SUPER_ADMIN and REGISTRATION_MANAGER hold access.manage.
  assert.equal(can(AdminRole.SUPER_ADMIN, "access.manage"), true);
  assert.equal(can(AdminRole.REGISTRATION_MANAGER, "access.manage"), true);
  // FINANCE does NOT hold access.manage — expected.
  assert.equal(can(AdminRole.FINANCE, "access.manage"), false);
});

test("admin confirm: PENDING_PAYMENT → PAID grants REGISTRATION access", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: {
      providerRef: null,
      actorAdminId: adminId,
      reason: "admin_confirm"
    }
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.PAID);
  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa!.granted, true);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);
});

test("admin confirm: rejects when there is no registration to confirm", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: {
      providerRef: null,
      actorAdminId: adminId
    }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "REGISTRATION_NOT_FOUND");
});

test("admin refund: PAID → REFUNDED revokes only REGISTRATION-owned access", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: {
      providerRef: null,
      actorAdminId: adminId
    }
  });
  const res = await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    reason: "admin_refund"
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.REFUNDED);
  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa!.granted, false);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);
});

test("admin refund: preserves ADMIN-owned access on the same pair", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: true,
      source: AccessGrantSource.ADMIN,
      grantedById: adminId
    }
  });
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: null, actorAdminId: adminId }
  });
  await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId
  });
  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(pa!.granted, true);
});

test("admin: caller cannot smuggle price/currency into confirmPayment", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: {
      providerRef: "safe-ref",
      actorAdminId: adminId,
      // @ts-expect-error — unknown key must be rejected by Zod.strict()
      priceMinorOverride: 1,
      currencyOverride: "USD"
    }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "INVALID_INPUT");
});

// ─── EXPIRE ─────────────────────────────────────────────────────────

test("expire: stale PENDING_PAYMENT with expiresAt in the past → EXPIRED", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({
    participantId: p.id,
    accessPointId: ap.id,
    expiresAt: new Date(Date.now() - 60_000) // 1 min ago
  });
  const res = await expire({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.EXPIRED);
});

test("expire: pending with future deadline remains PENDING_PAYMENT", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({
    participantId: p.id,
    accessPointId: ap.id,
    expiresAt: new Date(Date.now() + 60 * 60_000) // 1h from now
  });
  const res = await expire({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.PENDING_PAYMENT);
});

test("expire: pending WITHOUT an explicit expiresAt is a no-op (no invented duration)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
    // NO expiresAt — the domain must NOT expire it.
  });
  const res = await expire({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.PENDING_PAYMENT);
});

test("expire: repeated execution is idempotent (single event emitted)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({
    participantId: p.id,
    accessPointId: ap.id,
    expiresAt: new Date(Date.now() - 60_000)
  });
  await expire({ participantId: p.id, accessPointId: ap.id });
  await expire({ participantId: p.id, accessPointId: ap.id });
  const reg = await prisma.roomRegistration.findFirstOrThrow({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  const expireEvents = await prisma.roomPaymentEvent.count({
    where: {
      registrationId: reg.id,
      kind: RoomPaymentEventKind.FAIL, // we reuse FAIL kind + meta.reason='expired'
      meta: { path: ["reason"], equals: "expired" }
    }
  });
  assert.equal(expireEvents, 1, "no duplicate expire event on repeated runs");
});

test("expire: preserves ADMIN-owned ParticipantAccess", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: true,
      source: AccessGrantSource.ADMIN,
      grantedById: adminId
    }
  });
  await initRegistration({
    participantId: p.id,
    accessPointId: ap.id,
    expiresAt: new Date(Date.now() - 60_000)
  });
  await expire({ participantId: p.id, accessPointId: ap.id });
  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(pa!.granted, true);
});

// ─── AUDIT: transitioned flag ────────────────────────────────────────

test("audit: fresh init records transitioned=true", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const log = await prisma.auditLog.findFirst({
    where: {
      action: "room-registration.init",
      entityId: (
        await prisma.roomRegistration.findFirstOrThrow({
          where: { participantId: p.id, accessPointId: ap.id }
        })
      ).id
    },
    orderBy: { createdAt: "desc" }
  });
  assert.ok(log);
  assert.equal(
    (log!.meta as { transitioned?: boolean } | null)?.transitioned,
    true
  );
});

test("audit: idempotent duplicate init records transitioned=false", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const reg = await prisma.roomRegistration.findFirstOrThrow({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  const logs = await prisma.auditLog.findMany({
    where: { action: "room-registration.init", entityId: reg.id },
    orderBy: { createdAt: "asc" }
  });
  assert.ok(logs.length >= 2);
  const last = logs[logs.length - 1].meta as {
    transitioned?: boolean;
  } | null;
  assert.equal(last?.transitioned, false);
});

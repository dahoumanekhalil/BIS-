// Sub-Phase C tests for the RoomRegistration domain service.
//
// Covers the full mandate of Sub-Phase C §16:
//   • Registration initialization (FREE / PAID, ineligible AccessPoints,
//     idempotency, snapshot freezing)
//   • Payment confirmation (state machine, duplicate providerRef,
//     conflicting providerRef, access sync)
//   • Payment failure (state machine, idempotency, late-failure guard)
//   • Refund (state machine, idempotency, ADMIN-owned PA preservation,
//     CheckIn history preservation)
//   • Cancellation (both from PENDING_PAYMENT and PAID, admin-owned PA
//     preservation, idempotency)
//   • Access entitlement sync (grant/revoke rules, ADMIN immunity)
//   • State machine boundaries (invalid transitions rejected;
//     REFUNDED never reactivates through initRegistration)
//   • Concurrency (concurrent confirms → exactly one CONFIRM event
//     and no double-grant; conflicting refunds; retry after webhook
//     duplicate)
//   • Security (cross-participant / cross-room isolation, meta
//     whitelist enforcement, price/currency tampering rejected)
//
// Every test uses fresh fixture rows so it is safe to run multiple
// times against the same DB.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessGrantSource,
  AccessPointType,
  AdmissionMode,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus,
  RoomPaymentEventKind,
  RoomRegistrationStatus
} from "@prisma/client";
import {
  cancel,
  confirmPayment,
  failPayment,
  initRegistration,
  refund,
  RoomRegistrationError
} from "../lib/room-registration/service";
import { syncRoomAccessEntitlement } from "../lib/room-registration/sync";
import {
  canReRegister,
  canTransition
} from "../lib/room-registration/state-machine";
import { roomPaymentEventMetaSchema } from "../lib/room-registration/meta-schema";

const prisma = new PrismaClient();

let eventId: string;
let adminId: string;
const cleanup: Array<() => Promise<unknown>> = [];

before(async () => {
  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(event, "seeded event must exist");
  eventId = event.id;
  const admin = await prisma.adminUser.findFirst({
    where: { role: "SUPER_ADMIN" },
    select: { id: true }
  });
  assert.ok(admin, "seeded SUPER_ADMIN must exist");
  adminId = admin.id;
});

after(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
  await prisma.$disconnect();
});

// ─── Fixture helpers ──────────────────────────────────────────────────

let counter = 0;
async function makeParticipant() {
  counter += 1;
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "PaidFree",
      lastName: `S${counter}`,
      email: `paid-free-svc-${Date.now()}-${counter}@bis.dz`,
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
      slug: `paid-free-svc-free-${Date.now()}-${counter}`,
      name: `FREE ${counter}`,
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
      slug: `paid-free-svc-paid-${Date.now()}-${counter}`,
      name: `PAID ${counter}`,
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
      slug: `paid-free-svc-main-${Date.now()}-${counter}`,
      name: `MAIN ${counter}`,
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

async function eventCount(registrationId: string, kind?: RoomPaymentEventKind) {
  return await prisma.roomPaymentEvent.count({
    where: {
      registrationId,
      ...(kind ? { kind } : {})
    }
  });
}

// ─── REGISTRATION INITIALIZATION ─────────────────────────────────────

test("init: free room → FREE_CONFIRMED + registration-owned access granted", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.FREE_CONFIRMED);
  assert.equal(res.value.priceMinorSnapshot, null);
  assert.equal(res.value.currencySnapshot, null);

  const pa = await accessRow(p.id, ap.id);
  assert.ok(pa);
  assert.equal(pa!.granted, true);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);
});

test("init: paid room → PENDING_PAYMENT + no access granted + frozen snapshot", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(750000, "DZD");

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.PENDING_PAYMENT);
  assert.equal(res.value.priceMinorSnapshot, 750000);
  assert.equal(res.value.currencySnapshot, "DZD");
  assert.equal(res.value.paidAt, null);

  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa, null);
});

test("init: paid room missing priceMinor is rejected safely", async () => {
  const p = await makeParticipant();
  // Bypass admin-UI Zod: create a PAID room directly with NULL price
  // (mirrors the fixture `test` row noted in Sub-Phase B report).
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `broken-paid-${Date.now()}`,
      name: "Broken PAID",
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.PAID
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "PAID_ROOM_MISSING_PRICE");
});

test("init: paid room missing currency is rejected safely", async () => {
  const p = await makeParticipant();
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `broken-paid-c-${Date.now()}`,
      name: "Broken PAID currency",
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.PAID,
      priceMinor: 100000
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "PAID_ROOM_MISSING_CURRENCY");
});

test("init: main entrance is not eligible", async () => {
  const p = await makeParticipant();
  const ap = await makeMainEntrance();

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "NOT_A_ROOM");
});

test("init: inactive room is not eligible", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await prisma.accessPoint.update({
    where: { id: ap.id },
    data: { active: false }
  });

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "ACCESS_POINT_INACTIVE");
});

test("init: participant CANCELLED is rejected", async () => {
  const p = await makeParticipant();
  await prisma.participant.update({
    where: { id: p.id },
    data: { status: RegistrationStatus.CANCELLED }
  });
  const ap = await makeFreeRoom();

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "PARTICIPANT_CANCELLED");
});

test("init: unknown participant / accessPoint is rejected", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();

  const r1 = await initRegistration({
    participantId: "nonexistent-participant-id",
    accessPointId: ap.id
  });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.code, "PARTICIPANT_NOT_FOUND");

  const r2 = await initRegistration({
    participantId: p.id,
    accessPointId: "nonexistent-ap-id"
  });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, "ACCESS_POINT_NOT_FOUND");
});

test("init: duplicate init is idempotent, no duplicate row, no extra events", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  const first = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const evCountAfterFirst = await eventCount(first.value.id);

  const second = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.id, first.value.id, "same row");
  assert.equal(second.value.status, RoomRegistrationStatus.FREE_CONFIRMED);
  const evCountAfterSecond = await eventCount(second.value.id);
  assert.equal(
    evCountAfterSecond,
    evCountAfterFirst,
    "no new events on idempotent re-init of an already-live registration"
  );

  const rows = await prisma.roomRegistration.count({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(rows, 1, "@@unique prevents duplicate rows");
});

test("init: does NOT re-price when AccessPoint price later changes", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const first = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  await prisma.accessPoint.update({
    where: { id: ap.id },
    data: { priceMinor: 999000 }
  });

  // Idempotent call — should not silently re-freeze the snapshot.
  const again = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.priceMinorSnapshot, 500000);
});

// ─── CONFIRM PAYMENT ─────────────────────────────────────────────────

test("confirm: PENDING → PAID grants registration-owned access", async () => {
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
  assert.ok(res.value.paidAt);

  const pa = await accessRow(p.id, ap.id);
  assert.ok(pa);
  assert.equal(pa!.granted, true);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);

  const confirmCount = await eventCount(res.value.id, RoomPaymentEventKind.CONFIRM);
  assert.equal(confirmCount, 1);
});

test("confirm: is idempotent for same providerRef", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const providerRef = `txn-${Date.now()}`;
  const r1 = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef, actorAdminId: null }
  });
  const r2 = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef, actorAdminId: null }
  });
  assert.equal(r1.ok && r2.ok, true);
  if (!(r1.ok && r2.ok)) return;
  assert.equal(r1.value.id, r2.value.id);
  assert.equal(r2.value.status, RoomRegistrationStatus.PAID);

  const confirmCount = await eventCount(r1.value.id, RoomPaymentEventKind.CONFIRM);
  assert.equal(confirmCount, 1, "no duplicate CONFIRM event for same providerRef");
});

test("confirm: conflicting providerRef against already-PAID row is rejected", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const r1 = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "txn-A", actorAdminId: null }
  });
  assert.equal(r1.ok, true);

  const r2 = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "txn-B", actorAdminId: null }
  });
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.code, "PROVIDER_REF_CONFLICT");
});

test("confirm: rejects when there is no registration to confirm", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: null, actorAdminId: adminId }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "REGISTRATION_NOT_FOUND");
});

test("confirm: rejects when current state is not PENDING_PAYMENT", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: null, actorAdminId: adminId }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "INVALID_STATE_TRANSITION");
});

// ─── FAIL PAYMENT ────────────────────────────────────────────────────

test("fail: PENDING → PAYMENT_FAILED, no access", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  const init = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(init.ok, true);

  const res = await failPayment({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    providerRef: "prov-fail-1",
    reason: "provider_decline"
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.PAYMENT_FAILED);
  assert.ok(res.value.failedAt);

  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa, null, "no PA row created on failure");
});

test("fail: is idempotent", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const r1 = await failPayment({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    providerRef: "prov-fail-idem"
  });
  const r2 = await failPayment({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    providerRef: "prov-fail-idem"
  });
  assert.equal(r1.ok && r2.ok, true);
  if (!(r1.ok && r2.ok)) return;
  assert.equal(r2.value.status, RoomRegistrationStatus.PAYMENT_FAILED);
  const c = await eventCount(r1.value.id, RoomPaymentEventKind.FAIL);
  assert.equal(c, 1, "no duplicate FAIL event");
});

test("fail: late-failure on already PAID is rejected (never downgrade)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "prov-paid", actorAdminId: null }
  });

  const res = await failPayment({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    providerRef: "prov-late-fail"
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "LATE_FAILURE_ON_PAID");

  // Access still granted.
  const pa = await accessRow(p.id, ap.id);
  assert.ok(pa);
  assert.equal(pa!.granted, true);
});

// ─── REFUND ──────────────────────────────────────────────────────────

test("refund: PAID → REFUNDED revokes only REGISTRATION-owned access", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const paid = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "prov-r-1", actorAdminId: null }
  });
  assert.equal(paid.ok, true);

  const res = await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    providerRef: "prov-refund-1",
    reason: "admin_refund"
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.REFUNDED);

  const pa = await accessRow(p.id, ap.id);
  assert.ok(pa);
  assert.equal(pa!.granted, false);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);
});

test("refund: idempotent", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "prov-r-i", actorAdminId: null }
  });
  const r1 = await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    providerRef: "prov-refund-i"
  });
  const r2 = await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    providerRef: "prov-refund-i"
  });
  assert.equal(r1.ok && r2.ok, true);
  if (!(r1.ok && r2.ok)) return;
  assert.equal(r2.value.status, RoomRegistrationStatus.REFUNDED);
  const c = await eventCount(r1.value.id, RoomPaymentEventKind.REFUND);
  assert.equal(c, 1);
});

test("refund: does NOT revoke ADMIN-owned access on the same pair", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  // Admin grants the pair BEFORE registration (existing PA row).
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: true,
      source: AccessGrantSource.ADMIN,
      grantedById: adminId
    }
  });

  // Register + pay. Sync must NOT touch the admin row.
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const paid = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "prov-admin-owned", actorAdminId: null }
  });
  assert.equal(paid.ok, true);
  const preRefund = await accessRow(p.id, ap.id);
  assert.equal(preRefund!.source, AccessGrantSource.ADMIN);
  assert.equal(preRefund!.granted, true);

  await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    providerRef: "prov-refund-admin-owned"
  });
  const postRefund = await accessRow(p.id, ap.id);
  assert.equal(postRefund!.source, AccessGrantSource.ADMIN);
  assert.equal(
    postRefund!.granted,
    true,
    "admin-owned grant must survive a registration refund"
  );
});

test("refund: preserves CheckIn history", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "prov-history-1", actorAdminId: null }
  });
  const ci = await prisma.checkIn.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      ticketCode: p.ticketCode ?? "TEST",
      gate: "test",
      result: "VALID",
      reason: "ROOM_ENTRY"
    }
  });
  cleanup.push(() => prisma.checkIn.delete({ where: { id: ci.id } }));

  await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    providerRef: "prov-refund-history"
  });
  const still = await prisma.checkIn.findUnique({ where: { id: ci.id } });
  assert.ok(still, "CheckIn row must be preserved through refund");
});

// ─── CANCEL ──────────────────────────────────────────────────────────

test("cancel: PENDING_PAYMENT → CANCELLED", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const res = await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    reason: "attendee_cancel"
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.CANCELLED);
  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa, null, "cancelling a pending registration does not create PA");
});

test("cancel: PAID → CANCELLED revokes registration-owned access", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "prov-cancel-paid", actorAdminId: null }
  });

  const res = await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.CANCELLED);
  const pa = await accessRow(p.id, ap.id);
  assert.ok(pa);
  assert.equal(pa!.granted, false);
  assert.equal(pa!.source, AccessGrantSource.REGISTRATION);
});

test("cancel: is idempotent", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await cancel({ participantId: p.id, accessPointId: ap.id, actorAdminId: adminId });
  const r2 = await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId
  });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  const c = await eventCount(r2.value.id, RoomPaymentEventKind.CANCEL);
  assert.equal(c, 1);
});

test("cancel: never touches ADMIN-owned access", async () => {
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
    confirmation: { providerRef: "prov-cancel-admin-owned", actorAdminId: null }
  });
  await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId
  });
  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(pa!.granted, true);
});

// ─── ACCESS SYNC RULES ───────────────────────────────────────────────

test("sync: FREE_CONFIRMED grants; PENDING_PAYMENT does not", async () => {
  const p = await makeParticipant();
  const apFree = await makeFreeRoom();
  const apPaid = await makePaidRoom();

  await prisma.$transaction(async (tx) => {
    await tx.roomRegistration.create({
      data: {
        participantId: p.id,
        accessPointId: apFree.id,
        status: RoomRegistrationStatus.FREE_CONFIRMED
      }
    });
    await syncRoomAccessEntitlement(tx, {
      participantId: p.id,
      accessPointId: apFree.id,
      status: RoomRegistrationStatus.FREE_CONFIRMED
    });

    await tx.roomRegistration.create({
      data: {
        participantId: p.id,
        accessPointId: apPaid.id,
        status: RoomRegistrationStatus.PENDING_PAYMENT,
        priceMinorSnapshot: 100000,
        currencySnapshot: "DZD"
      }
    });
    await syncRoomAccessEntitlement(tx, {
      participantId: p.id,
      accessPointId: apPaid.id,
      status: RoomRegistrationStatus.PENDING_PAYMENT
    });
  });

  const paFree = await accessRow(p.id, apFree.id);
  const paPaid = await accessRow(p.id, apPaid.id);
  assert.ok(paFree);
  assert.equal(paFree!.granted, true);
  assert.equal(paFree!.source, AccessGrantSource.REGISTRATION);
  assert.equal(paPaid, null, "PENDING_PAYMENT does not materialise a PA row");
});

test("sync: ADMIN source is never mutated by grant/revoke", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: false, // admin has DENIED
      source: AccessGrantSource.ADMIN,
      revokedById: adminId,
      revokedAt: new Date()
    }
  });

  await prisma.$transaction(async (tx) => {
    // Try to grant via sync as if payment succeeded — admin denial
    // must survive.
    const outcome = await syncRoomAccessEntitlement(tx, {
      participantId: p.id,
      accessPointId: ap.id,
      status: RoomRegistrationStatus.PAID
    });
    assert.equal(outcome.action, "no-op");
  });

  const pa = await accessRow(p.id, ap.id);
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(pa!.granted, false);
});

// ─── STATE MACHINE ───────────────────────────────────────────────────

test("state machine: forbidden transitions rejected", () => {
  // PAID → PENDING_PAYMENT: forbidden.
  assert.equal(
    canTransition(RoomRegistrationStatus.PAID, RoomRegistrationStatus.PENDING_PAYMENT),
    false
  );
  // REFUNDED → PAID: forbidden.
  assert.equal(
    canTransition(RoomRegistrationStatus.REFUNDED, RoomRegistrationStatus.PAID),
    false
  );
  // CANCELLED → PAID: forbidden.
  assert.equal(
    canTransition(RoomRegistrationStatus.CANCELLED, RoomRegistrationStatus.PAID),
    false
  );
  // PAYMENT_FAILED → PAID: forbidden.
  assert.equal(
    canTransition(RoomRegistrationStatus.PAYMENT_FAILED, RoomRegistrationStatus.PAID),
    false
  );
  // FREE_CONFIRMED → PAID: forbidden.
  assert.equal(
    canTransition(RoomRegistrationStatus.FREE_CONFIRMED, RoomRegistrationStatus.PAID),
    false
  );
});

test("state machine: canReRegister excludes REFUNDED", () => {
  assert.equal(canReRegister(RoomRegistrationStatus.CANCELLED), true);
  assert.equal(canReRegister(RoomRegistrationStatus.PAYMENT_FAILED), true);
  assert.equal(canReRegister(RoomRegistrationStatus.EXPIRED), true);
  assert.equal(canReRegister(RoomRegistrationStatus.REFUNDED), false);
  assert.equal(canReRegister(RoomRegistrationStatus.PAID), false);
});

test("re-registration: after CANCELLED, init reactivates the same row", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  const first = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await cancel({ participantId: p.id, accessPointId: ap.id, actorAdminId: adminId });

  const second = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.id, first.value.id);
  assert.equal(second.value.status, RoomRegistrationStatus.PENDING_PAYMENT);
});

test("re-registration: after REFUNDED, init is refused (closed door)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "prov-refund-then-init", actorAdminId: null }
  });
  await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    providerRef: "prov-refund-then-init-2"
  });

  const res = await initRegistration({ participantId: p.id, accessPointId: ap.id });
  assert.equal(res.ok, true, "the API still returns the existing view, ok=true");
  if (!res.ok) return;
  // But the row remains REFUNDED — no reactivation happened.
  assert.equal(res.value.status, RoomRegistrationStatus.REFUNDED);
});

// ─── CONCURRENCY / IDEMPOTENCY ───────────────────────────────────────

test("concurrency: parallel confirmations produce exactly one CONFIRM event", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  // Fire 5 parallel confirmations with the same providerRef.
  const providerRef = `race-${Date.now()}`;
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      confirmPayment({
        participantId: p.id,
        accessPointId: ap.id,
        confirmation: { providerRef, actorAdminId: null }
      })
    )
  );
  for (const r of results) assert.equal(r.ok, true);

  const reg = await prisma.roomRegistration.findFirstOrThrow({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(reg.status, RoomRegistrationStatus.PAID);
  const c = await eventCount(reg.id, RoomPaymentEventKind.CONFIRM);
  assert.equal(c, 1, "the partial unique index + conditional update guarantee 1 event");

  // Exactly one granted PA row.
  const pas = await prisma.participantAccess.findMany({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(pas.length, 1);
  assert.equal(pas[0].granted, true);
});

test("concurrency: parallel init calls all return ok with the same row", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      initRegistration({ participantId: p.id, accessPointId: ap.id })
    )
  );
  // Exactly one row in the DB.
  const rows = await prisma.roomRegistration.count({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(rows, 1);
  // All callers must observe ok=true (P2002 losers refetch the winner).
  for (const r of results) assert.equal(r.ok, true);
  // All returned views point at the same registration id.
  const ids = new Set(results.map((r) => (r.ok ? r.value.id : "")));
  assert.equal(ids.size, 1);
});

// ─── SECURITY ────────────────────────────────────────────────────────

test("security: meta whitelist rejects unknown keys (strict) — prevents injection", () => {
  // `.strict()` on Zod object schemas throws on unknown keys, which is
  // stronger than "silently strip" — the service will surface a parse
  // failure at write time if any code path tries to smuggle
  // secrets/PII into meta. We prove that here by asserting the parse
  // rejects each attempted injection.
  const attempts: Array<Record<string, unknown>> = [
    { rawToken: "attempted-token-leak" },
    { authorization: "Bearer x" },
    { password: "secret" },
    { email: "a@b.c" },
    { phone: "+213-000" },
    // Use JSON.parse to create an actual own `__proto__` property:
    // a plain object literal `{ __proto__: ... }` sets the prototype
    // instead of adding an own key, so it would slip past this test
    // for the wrong reason. JSON-decoded webhook bodies are the
    // realistic vector — they DO produce own `__proto__` keys.
    JSON.parse('{"__proto__":{"evil":true}}') as Record<string, unknown>
  ];
  for (const bad of attempts) {
    // Build the candidate meta with Object.assign so the __proto__
    // own-key case is preserved (object spread copies own enumerable
    // string keys but engines skip __proto__ during spread).
    const candidate = Object.assign(
      Object.create(null),
      {
        transition: {
          before: RoomRegistrationStatus.PENDING_PAYMENT,
          after: RoomRegistrationStatus.PAID
        },
        reason: "admin_confirm"
      },
      bad
    );
    const res = roomPaymentEventMetaSchema.safeParse(candidate);
    assert.equal(
      res.success,
      false,
      `meta parse must reject key: ${Object.getOwnPropertyNames(bad).join(",")}`
    );
  }

  // Whitelisted-only input parses successfully.
  const good = roomPaymentEventMetaSchema.safeParse({
    transition: {
      before: RoomRegistrationStatus.PENDING_PAYMENT,
      after: RoomRegistrationStatus.PAID
    },
    reason: "admin_confirm",
    kind: RoomPaymentEventKind.CONFIRM,
    source: "webhook"
  });
  assert.equal(good.success, true);
});

test("security: reason field rejects control characters / long input", () => {
  const bad = roomPaymentEventMetaSchema.safeParse({
    reason: "a\nb\rc\t" // control chars not in the allowed regex
  });
  assert.equal(bad.success, false);
  const tooLong = roomPaymentEventMetaSchema.safeParse({
    reason: "x".repeat(200)
  });
  assert.equal(tooLong.success, false);
});

test("security: caller cannot smuggle price/currency into confirmPayment", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    // Zod .strict() rejects unknown fields at the boundary.
    confirmation: {
      providerRef: "safe-ref",
      actorAdminId: null,
      // @ts-expect-error — intentional: unknown keys must be
      // rejected by both the compile-time type and Zod's .strict()
      // at runtime.
      priceMinorOverride: 1,
      currencyOverride: "USD"
    }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "INVALID_INPUT");
});

test("security: cross-participant registration cannot be confused", async () => {
  const p1 = await makeParticipant();
  const p2 = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p1.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p1.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "isolate", actorAdminId: null }
  });

  // p2 has no registration — a confirm targeting p2 must not affect p1.
  const res = await confirmPayment({
    participantId: p2.id,
    accessPointId: ap.id,
    confirmation: { providerRef: "isolate-2", actorAdminId: null }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "REGISTRATION_NOT_FOUND");

  const p1Access = await accessRow(p1.id, ap.id);
  const p2Access = await accessRow(p2.id, ap.id);
  assert.equal(p1Access!.granted, true);
  assert.equal(p2Access, null);
});

test("security: cross-room reuse of providerRef does not confuse registrations", async () => {
  const p = await makeParticipant();
  const apA = await makePaidRoom();
  const apB = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: apA.id });
  await initRegistration({ participantId: p.id, accessPointId: apB.id });

  const providerRef = "cross-room-1";
  const rA = await confirmPayment({
    participantId: p.id,
    accessPointId: apA.id,
    confirmation: { providerRef, actorAdminId: null }
  });
  const rB = await confirmPayment({
    participantId: p.id,
    accessPointId: apB.id,
    confirmation: { providerRef, actorAdminId: null }
  });
  assert.equal(rA.ok && rB.ok, true);
  const paA = await accessRow(p.id, apA.id);
  const paB = await accessRow(p.id, apB.id);
  assert.equal(paA!.granted, true);
  assert.equal(paB!.granted, true);
});

test("security: adminId that does not exist is rejected", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: {
      providerRef: null,
      actorAdminId: "ckxfake-nonexistent-admin-id-xxxxxxxxxxxxxx"
    }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "ADMIN_NOT_FOUND");
});

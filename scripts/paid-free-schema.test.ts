// Sub-Phase B schema-integrity tests for the paid/free room
// registration feature. Verifies that the DB enforces the invariants
// the higher-level services (Sub-Phase C onwards) will rely on:
//
//   • RoomRegistration @@unique([participantId, accessPointId])
//     — prevents duplicate active registrations for the same pair.
//   • Cascade delete of RoomRegistration when its Participant or
//     AccessPoint is deleted.
//   • Cascade delete of RoomPaymentEvent when its RoomRegistration
//     is deleted.
//   • Partial unique index on RoomPaymentEvent
//     ("registrationId", "providerRef") WHERE providerRef IS NOT NULL
//     — webhook idempotency; multiple admin-side events
//     (providerRef = NULL) MUST remain allowed.
//   • ParticipantAccess.source defaults to ADMIN for backwards
//     compatibility and can be explicitly set to REGISTRATION.
//   • AccessPoint accepts priceMinor and currency (integer minor
//     units, no floating point).
//
// Also verifies the state of the migration-time backfill:
//   • room-01..05 have admissionMode = FREE.
//   • MAIN_ENTRANCE "main" has admissionMode = NULL.
//
// Run:
//   npm run test:paid-free-schema

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessGrantSource,
  AccessPointType,
  AdmissionMode,
  PaymentStatus,
  Prisma,
  PrismaClient,
  RegistrationStatus,
  RoomPaymentEventKind,
  RoomRegistrationStatus
} from "@prisma/client";

const prisma = new PrismaClient();

let eventId: string;
let participantId: string;
let secondParticipantId: string;
let roomAId: string;
let roomBId: string;

// Fresh, isolated fixtures so we can freely create/delete rows
// without touching the seeded operational data.
before(async () => {
  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(event, "seeded event must exist");
  eventId = event.id;

  const stamp = Date.now();

  const p1 = await prisma.participant.create({
    data: {
      eventId,
      firstName: "PaidFree",
      lastName: "Fixture1",
      email: `paid-free-fixture-1-${stamp}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  participantId = p1.id;

  const p2 = await prisma.participant.create({
    data: {
      eventId,
      firstName: "PaidFree",
      lastName: "Fixture2",
      email: `paid-free-fixture-2-${stamp}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  secondParticipantId = p2.id;

  const roomA = await prisma.accessPoint.create({
    data: {
      slug: `paid-free-test-a-${stamp}`,
      name: "PaidFree Test A",
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.FREE
    }
  });
  roomAId = roomA.id;

  const roomB = await prisma.accessPoint.create({
    data: {
      slug: `paid-free-test-b-${stamp}`,
      name: "PaidFree Test B",
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.PAID,
      priceMinor: 500000,
      currency: "DZD"
    }
  });
  roomBId = roomB.id;
});

after(async () => {
  // Best-effort cleanup. Cascades handle RoomRegistration +
  // RoomPaymentEvent + ParticipantAccess automatically.
  await prisma.accessPoint
    .delete({ where: { id: roomAId } })
    .catch(() => {});
  await prisma.accessPoint
    .delete({ where: { id: roomBId } })
    .catch(() => {});
  await prisma.participant
    .delete({ where: { id: participantId } })
    .catch(() => {});
  await prisma.participant
    .delete({ where: { id: secondParticipantId } })
    .catch(() => {});
  await prisma.$disconnect();
});

// ─── Migration state ─────────────────────────────────────────────────

test("migration: room-01..05 have admissionMode = FREE", async () => {
  const rows = await prisma.accessPoint.findMany({
    where: {
      slug: {
        in: ["room-01", "room-02", "room-03", "room-04", "room-05"]
      }
    },
    select: { slug: true, admissionMode: true }
  });
  assert.equal(rows.length, 5, "all five operational rooms must exist");
  for (const r of rows) {
    assert.equal(
      r.admissionMode,
      AdmissionMode.FREE,
      `${r.slug} must be FREE after Sub-Phase B backfill`
    );
  }
});

test("migration: MAIN_ENTRANCE 'main' has admissionMode = NULL", async () => {
  const row = await prisma.accessPoint.findUnique({
    where: { slug: "main" },
    select: { type: true, admissionMode: true }
  });
  assert.ok(row, "main entrance must exist");
  assert.equal(row!.type, AccessPointType.MAIN_ENTRANCE);
  assert.equal(row!.admissionMode, null);
});

// ─── AccessPoint additions ───────────────────────────────────────────

test("AccessPoint accepts integer priceMinor + currency string", async () => {
  const row = await prisma.accessPoint.findUnique({
    where: { id: roomBId },
    select: { priceMinor: true, currency: true, admissionMode: true }
  });
  assert.ok(row);
  assert.equal(row!.priceMinor, 500000);
  assert.equal(row!.currency, "DZD");
  assert.equal(row!.admissionMode, AdmissionMode.PAID);
});

// ─── ParticipantAccess.source ────────────────────────────────────────

test("ParticipantAccess.source defaults to ADMIN for compat", async () => {
  const row = await prisma.participantAccess.create({
    data: { participantId, accessPointId: roomAId, granted: true }
  });
  assert.equal(row.source, AccessGrantSource.ADMIN);
  await prisma.participantAccess.delete({
    where: {
      participantId_accessPointId: {
        participantId,
        accessPointId: roomAId
      }
    }
  });
});

test("ParticipantAccess.source accepts REGISTRATION", async () => {
  const row = await prisma.participantAccess.create({
    data: {
      participantId,
      accessPointId: roomAId,
      granted: true,
      source: AccessGrantSource.REGISTRATION
    }
  });
  assert.equal(row.source, AccessGrantSource.REGISTRATION);
  await prisma.participantAccess.delete({
    where: {
      participantId_accessPointId: {
        participantId,
        accessPointId: roomAId
      }
    }
  });
});

test("migration: existing ParticipantAccess rows have source=ADMIN", async () => {
  // Sample any pre-existing row. Fresh installs may have zero rows —
  // that is a non-failure (nothing to migrate).
  const sample = await prisma.participantAccess.findMany({
    where: { NOT: { participantId: { in: [participantId, secondParticipantId] } } },
    select: { source: true },
    take: 10
  });
  for (const row of sample) {
    assert.equal(
      row.source,
      AccessGrantSource.ADMIN,
      "pre-existing PA rows must default to ADMIN, never REGISTRATION"
    );
  }
});

// ─── RoomRegistration uniqueness ─────────────────────────────────────

test("RoomRegistration @@unique([participantId, accessPointId]) rejects duplicate", async () => {
  await prisma.roomRegistration.create({
    data: {
      participantId,
      accessPointId: roomBId,
      status: RoomRegistrationStatus.PENDING_PAYMENT,
      priceMinorSnapshot: 500000,
      currencySnapshot: "DZD"
    }
  });

  await assert.rejects(
    () =>
      prisma.roomRegistration.create({
        data: {
          participantId,
          accessPointId: roomBId,
          status: RoomRegistrationStatus.PENDING_PAYMENT,
          priceMinorSnapshot: 500000,
          currencySnapshot: "DZD"
        }
      }),
    (err: unknown) =>
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002",
    "second row for same (participant, room) must violate unique constraint"
  );

  // But a DIFFERENT participant for the same room is allowed.
  const other = await prisma.roomRegistration.create({
    data: {
      participantId: secondParticipantId,
      accessPointId: roomBId,
      status: RoomRegistrationStatus.PENDING_PAYMENT,
      priceMinorSnapshot: 500000,
      currencySnapshot: "DZD"
    }
  });
  assert.equal(other.participantId, secondParticipantId);
});

// ─── Price snapshot immutability ────────────────────────────────────

test("RoomRegistration snapshot is not automatically updated when AccessPoint price changes", async () => {
  const reg = await prisma.roomRegistration.findFirst({
    where: { participantId, accessPointId: roomBId },
    select: { priceMinorSnapshot: true, currencySnapshot: true }
  });
  assert.equal(reg!.priceMinorSnapshot, 500000);

  await prisma.accessPoint.update({
    where: { id: roomBId },
    data: { priceMinor: 750000 }
  });

  const regAfter = await prisma.roomRegistration.findFirst({
    where: { participantId, accessPointId: roomBId },
    select: { priceMinorSnapshot: true, currencySnapshot: true }
  });
  assert.equal(
    regAfter!.priceMinorSnapshot,
    500000,
    "historical registration must not be rewritten by admin price edit"
  );

  // Restore
  await prisma.accessPoint.update({
    where: { id: roomBId },
    data: { priceMinor: 500000 }
  });
});

// ─── RoomPaymentEvent cascade + idempotency index ───────────────────

test("RoomPaymentEvent partial unique index rejects duplicate providerRef per registration", async () => {
  const reg = await prisma.roomRegistration.findFirst({
    where: { participantId, accessPointId: roomBId }
  });
  assert.ok(reg);

  await prisma.roomPaymentEvent.create({
    data: {
      registrationId: reg!.id,
      kind: RoomPaymentEventKind.CONFIRM,
      providerRef: "prov-txn-abc-123"
    }
  });

  await assert.rejects(
    () =>
      prisma.roomPaymentEvent.create({
        data: {
          registrationId: reg!.id,
          kind: RoomPaymentEventKind.CONFIRM,
          providerRef: "prov-txn-abc-123"
        }
      }),
    (err: unknown) =>
      err instanceof Prisma.PrismaClientKnownRequestError &&
      // 23505 = unique_violation. Partial indexes surface as generic
      // unique-violation via $executeRaw (no P2002 mapping without a
      // named Prisma constraint), so accept either P2002 or the raw
      // 23505 leaking via meta.
      (err.code === "P2002" ||
        (typeof err.meta === "object" &&
          err.meta !== null &&
          JSON.stringify(err.meta).includes("providerRef"))),
    "duplicate (registrationId, providerRef) must be rejected"
  );

  // But two events with providerRef = null on the same registration
  // are allowed — admin-confirmed transitions do not go through a
  // provider.
  await prisma.roomPaymentEvent.create({
    data: {
      registrationId: reg!.id,
      kind: RoomPaymentEventKind.ADMIN_OVERRIDE,
      providerRef: null,
      actorAdminId: null
    }
  });
  await prisma.roomPaymentEvent.create({
    data: {
      registrationId: reg!.id,
      kind: RoomPaymentEventKind.ADMIN_OVERRIDE,
      providerRef: null,
      actorAdminId: null
    }
  });
});

test("RoomPaymentEvent partial unique index: same providerRef allowed on DIFFERENT registrations", async () => {
  // Create a fresh registration for the second participant on room A
  // so we have a distinct RoomRegistration.
  const otherReg = await prisma.roomRegistration.create({
    data: {
      participantId: secondParticipantId,
      accessPointId: roomAId,
      status: RoomRegistrationStatus.FREE_CONFIRMED
    }
  });

  // Reuse the same providerRef value from the previous test on a
  // DIFFERENT registration — should succeed.
  await prisma.roomPaymentEvent.create({
    data: {
      registrationId: otherReg.id,
      kind: RoomPaymentEventKind.CONFIRM,
      providerRef: "prov-txn-abc-123"
    }
  });

  const count = await prisma.roomPaymentEvent.count({
    where: { providerRef: "prov-txn-abc-123" }
  });
  assert.equal(count, 2, "same providerRef may recur across registrations");

  await prisma.roomRegistration.delete({ where: { id: otherReg.id } });
});

test("RoomPaymentEvent cascades on RoomRegistration delete", async () => {
  const reg = await prisma.roomRegistration.findFirst({
    where: { participantId, accessPointId: roomBId }
  });
  assert.ok(reg);
  const evCount = await prisma.roomPaymentEvent.count({
    where: { registrationId: reg!.id }
  });
  assert.ok(evCount > 0);

  await prisma.roomRegistration.delete({ where: { id: reg!.id } });

  const remaining = await prisma.roomPaymentEvent.count({
    where: { registrationId: reg!.id }
  });
  assert.equal(remaining, 0, "events must cascade with their registration");
});

// ─── Cascades from Participant / AccessPoint ────────────────────────

test("RoomRegistration cascades on Participant delete", async () => {
  const stamp = Date.now();
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "CascadeP",
      lastName: "Fixture",
      email: `cascade-p-${stamp}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  const r = await prisma.roomRegistration.create({
    data: {
      participantId: p.id,
      accessPointId: roomAId,
      status: RoomRegistrationStatus.FREE_CONFIRMED
    }
  });

  await prisma.participant.delete({ where: { id: p.id } });
  const gone = await prisma.roomRegistration.findUnique({
    where: { id: r.id }
  });
  assert.equal(gone, null);
});

test("RoomRegistration cascades on AccessPoint delete", async () => {
  const stamp = Date.now();
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `cascade-ap-${stamp}`,
      name: "Cascade AP",
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.FREE
    }
  });
  const r = await prisma.roomRegistration.create({
    data: {
      participantId,
      accessPointId: ap.id,
      status: RoomRegistrationStatus.FREE_CONFIRMED
    }
  });

  await prisma.accessPoint.delete({ where: { id: ap.id } });
  const gone = await prisma.roomRegistration.findUnique({
    where: { id: r.id }
  });
  assert.equal(gone, null);
});

// ─── Re-registration after a terminal status ────────────────────────

test("RoomRegistration row is reusable across terminal → active transitions", async () => {
  // Freshly reserve room A for the primary participant so we control
  // its lifecycle inside this test.
  await prisma.roomRegistration
    .delete({
      where: {
        participantId_accessPointId: {
          participantId,
          accessPointId: roomAId
        }
      }
    })
    .catch(() => {});

  const r = await prisma.roomRegistration.create({
    data: {
      participantId,
      accessPointId: roomAId,
      status: RoomRegistrationStatus.PENDING_PAYMENT
    }
  });

  // Move to CANCELLED.
  await prisma.roomRegistration.update({
    where: { id: r.id },
    data: {
      status: RoomRegistrationStatus.CANCELLED,
      cancelledAt: new Date()
    }
  });

  // Re-open. Same row, no duplicate created.
  const reopened = await prisma.roomRegistration.update({
    where: { id: r.id },
    data: {
      status: RoomRegistrationStatus.PENDING_PAYMENT,
      cancelledAt: null
    }
  });
  assert.equal(reopened.id, r.id);
  assert.equal(reopened.status, RoomRegistrationStatus.PENDING_PAYMENT);

  const count = await prisma.roomRegistration.count({
    where: { participantId, accessPointId: roomAId }
  });
  assert.equal(count, 1);
});

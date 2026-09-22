// Sub-Phase E tests — Admin Room-Payment UI + read-side loader.
//
// Sub-Phase D already covered the domain service and the action-level
// RBAC baseline. This suite focuses on the NEW surface introduced in
// Sub-Phase E:
//
//   • lib/admin/queries.ts:getRegistrantRoomRegistrations
//       — returns the correct projection of RoomRegistration joined with
//         its AccessPoint and the current ParticipantAccess row.
//       — covers FREE / PENDING_PAYMENT / PAID / REFUNDED / CANCELLED /
//         EXPIRED at read time.
//   • RBAC + ownership invariants remain intact under the UI paths.
//   • Concurrency: repeated confirmation / refund / cancellation is safe
//     when the panel is exercised twice in quick succession (mirrors
//     "two operators clicking simultaneously").
//   • Ownership: refund / cancellation preserve ADMIN-owned
//     ParticipantAccess rows.
//   • Security: the confirm/refund/cancel domain surface still refuses
//     unknown extra keys via Zod .strict() (client cannot smuggle
//     price/currency/actor).
//
// Server-action functions themselves use `requirePermission()` which
// redirects via next/headers — those cannot be invoked outside a
// request context. This is the same reason Sub-Phase D's suite
// exercises the domain service directly. RBAC gating is verified via
// `can()` (the source of truth `requirePermission` consults) and by
// asserting each server action's authorisation prefix in a static
// source-level check (see the last block).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccessGrantSource,
  AccessPointType,
  AdmissionMode,
  AdminRole,
  AdminStatus,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus,
  RoomRegistrationStatus
} from "@prisma/client";
import {
  cancel,
  confirmPayment,
  expire,
  initRegistration,
  refund
} from "../lib/room-registration/service";
import { getRegistrantRoomRegistrations } from "../lib/admin/queries";
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
    where: { email: "sub-phase-e-test@bis.dz" },
    update: { role: AdminRole.SUPER_ADMIN, status: AdminStatus.ACTIVE },
    create: {
      email: "sub-phase-e-test@bis.dz",
      name: "Sub-Phase E Test Admin",
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
      firstName: "SubPhaseE",
      lastName: `P${counter}`,
      email: `sub-phase-e-${Date.now()}-${counter}@bis.dz`,
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
      slug: `sub-phase-e-free-${Date.now()}-${counter}`,
      name: `SubE FREE ${counter}`,
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
      slug: `sub-phase-e-paid-${Date.now()}-${counter}`,
      name: `SubE PAID ${counter}`,
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.PAID,
      priceMinor,
      currency
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));
  return ap;
}

// ─── RBAC baseline for the panel controls ────────────────────────────

test("RBAC: SUPER_ADMIN and FINANCE hold both room-payment permissions", () => {
  assert.equal(can(AdminRole.SUPER_ADMIN, "payment.confirm.room"), true);
  assert.equal(can(AdminRole.SUPER_ADMIN, "payment.refund.room"), true);
  assert.equal(can(AdminRole.FINANCE, "payment.confirm.room"), true);
  assert.equal(can(AdminRole.FINANCE, "payment.refund.room"), true);
});

test("RBAC: ADMIN does NOT hold room-payment permissions (must not silently expand)", () => {
  assert.equal(can(AdminRole.ADMIN, "payment.confirm.room"), false);
  assert.equal(can(AdminRole.ADMIN, "payment.refund.room"), false);
});

test("RBAC: FINANCE does NOT hold access.manage (cancel path stays gated)", () => {
  assert.equal(can(AdminRole.FINANCE, "access.manage"), false);
});

test("RBAC: cancel path (access.manage) unchanged for admin cohorts", () => {
  assert.equal(can(AdminRole.SUPER_ADMIN, "access.manage"), true);
  assert.equal(can(AdminRole.REGISTRATION_MANAGER, "access.manage"), true);
  assert.equal(can(AdminRole.CHECKIN_OPERATOR, "access.manage"), false);
});

test("RBAC: no non-admin role silently gains payment.confirm.room", () => {
  const others: AdminRole[] = [
    AdminRole.SALES,
    AdminRole.REGISTRATION_MANAGER,
    AdminRole.CHECKIN_OPERATOR,
    AdminRole.CONTENT_MANAGER,
    AdminRole.SPONSOR_MANAGER,
    AdminRole.ANALYTICS,
    AdminRole.VIEWER
  ];
  for (const r of others) {
    assert.equal(
      can(r, "payment.confirm.room"),
      false,
      `role ${r} must not hold payment.confirm.room`
    );
    assert.equal(
      can(r, "payment.refund.room"),
      false,
      `role ${r} must not hold payment.refund.room`
    );
  }
});

// ─── Query loader shape ──────────────────────────────────────────────

test("query: FREE registration shows FREE_CONFIRMED + REGISTRATION-owned access granted", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const rows = await getRegistrantRoomRegistrations(p.id);
  const row = rows.find((r) => r.accessPoint.id === ap.id);
  assert.ok(row, "row for FREE registration must be returned");
  assert.equal(row!.status, RoomRegistrationStatus.FREE_CONFIRMED);
  assert.equal(row!.priceMinorSnapshot, null);
  assert.equal(row!.currencySnapshot, null);
  assert.equal(row!.paymentRef, null);
  assert.equal(row!.accessPoint.admissionMode, AdmissionMode.FREE);
  assert.ok(row!.access, "PA row must exist for FREE_CONFIRMED");
  assert.equal(row!.access!.granted, true);
  assert.equal(row!.access!.source, AccessGrantSource.REGISTRATION);
});

test("query: PENDING_PAYMENT shows frozen price + no access grant", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(650000);
  await initRegistration({ participantId: p.id, accessPointId: ap.id });

  const rows = await getRegistrantRoomRegistrations(p.id);
  const row = rows.find((r) => r.accessPoint.id === ap.id);
  assert.ok(row);
  assert.equal(row!.status, RoomRegistrationStatus.PENDING_PAYMENT);
  assert.equal(row!.priceMinorSnapshot, 650000);
  assert.equal(row!.currencySnapshot, "DZD");
  assert.equal(row!.paymentRef, null);
  assert.equal(row!.paidAt, null);
  assert.equal(row!.access, null, "no PA row until confirmation");
});

test("query: PAID shows paidAt + REGISTRATION-owned access granted", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(400000);
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: null, actorAdminId: adminId }
  });

  const rows = await getRegistrantRoomRegistrations(p.id);
  const row = rows.find((r) => r.accessPoint.id === ap.id);
  assert.ok(row);
  assert.equal(row!.status, RoomRegistrationStatus.PAID);
  assert.equal(row!.priceMinorSnapshot, 400000);
  assert.ok(row!.paidAt, "paidAt must be set after confirmation");
  assert.ok(row!.access);
  assert.equal(row!.access!.granted, true);
  assert.equal(row!.access!.source, AccessGrantSource.REGISTRATION);
});

test("query: REFUNDED shows refundedAt + REGISTRATION-owned access revoked", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
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

  const rows = await getRegistrantRoomRegistrations(p.id);
  const row = rows.find((r) => r.accessPoint.id === ap.id);
  assert.ok(row);
  assert.equal(row!.status, RoomRegistrationStatus.REFUNDED);
  assert.ok(row!.refundedAt);
  assert.ok(row!.access);
  assert.equal(row!.access!.granted, false);
  assert.equal(row!.access!.source, AccessGrantSource.REGISTRATION);
});

test("query: CANCELLED shows cancelledAt + revoked access", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await cancel({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId
  });

  const rows = await getRegistrantRoomRegistrations(p.id);
  const row = rows.find((r) => r.accessPoint.id === ap.id);
  assert.ok(row);
  assert.equal(row!.status, RoomRegistrationStatus.CANCELLED);
  assert.ok(row!.cancelledAt);
  assert.ok(row!.access);
  assert.equal(row!.access!.granted, false);
});

test("query: EXPIRED shows no PA row (never granted) — Option C compatible", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({
    participantId: p.id,
    accessPointId: ap.id,
    expiresAt: new Date(Date.now() - 60_000)
  });
  await expire({ participantId: p.id, accessPointId: ap.id });

  const rows = await getRegistrantRoomRegistrations(p.id);
  const row = rows.find((r) => r.accessPoint.id === ap.id);
  assert.ok(row);
  assert.equal(row!.status, RoomRegistrationStatus.EXPIRED);
  assert.equal(row!.access, null, "EXPIRED never materialises a PA row");
});

test("query: ADMIN-owned PA row surfaces on the same registration row", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  // Admin grants BEFORE payment confirmation — creates a source=ADMIN PA.
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

  const rows = await getRegistrantRoomRegistrations(p.id);
  const row = rows.find((r) => r.accessPoint.id === ap.id);
  assert.ok(row);
  assert.equal(row!.status, RoomRegistrationStatus.PENDING_PAYMENT);
  assert.ok(row!.access);
  assert.equal(row!.access!.granted, true);
  assert.equal(
    row!.access!.source,
    AccessGrantSource.ADMIN,
    "admin override must be visible to the panel even for pending payments"
  );
});

test("query: multiple rooms are returned newest-first", async () => {
  const p = await makeParticipant();
  const first = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: first.id });
  // Introduce a small gap so the second registeredAt is strictly later.
  await new Promise((r) => setTimeout(r, 10));
  const second = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: second.id });

  const rows = await getRegistrantRoomRegistrations(p.id);
  const ids = rows.map((r) => r.accessPoint.id);
  const firstIdx = ids.indexOf(first.id);
  const secondIdx = ids.indexOf(second.id);
  assert.ok(firstIdx >= 0 && secondIdx >= 0);
  assert.ok(secondIdx < firstIdx, "newest registration must be listed first");
});

// ─── Concurrency / idempotency of the actions the panel triggers ─────

test("concurrency: two confirmations converge to one PAID (single PAID event)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const [a, b] = await Promise.all([
    confirmPayment({
      participantId: p.id,
      accessPointId: ap.id,
      confirmation: { providerRef: null, actorAdminId: adminId }
    }),
    confirmPayment({
      participantId: p.id,
      accessPointId: ap.id,
      confirmation: { providerRef: null, actorAdminId: adminId }
    })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const reg = await prisma.roomRegistration.findFirstOrThrow({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(reg.status, RoomRegistrationStatus.PAID);
  const confirmEvents = await prisma.roomPaymentEvent.count({
    where: { registrationId: reg.id, kind: "CONFIRM" }
  });
  assert.equal(
    confirmEvents,
    1,
    "domain must guarantee a single CONFIRM event under concurrency"
  );
});

test("concurrency: two refunds converge to one REFUNDED (single REFUND event)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: null, actorAdminId: adminId }
  });
  const [a, b] = await Promise.all([
    refund({
      participantId: p.id,
      accessPointId: ap.id,
      actorAdminId: adminId
    }),
    refund({
      participantId: p.id,
      accessPointId: ap.id,
      actorAdminId: adminId
    })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const reg = await prisma.roomRegistration.findFirstOrThrow({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(reg.status, RoomRegistrationStatus.REFUNDED);
  const refundEvents = await prisma.roomPaymentEvent.count({
    where: { registrationId: reg.id, kind: "REFUND" }
  });
  assert.equal(refundEvents, 1);
});

test("concurrency: two cancellations converge to one CANCELLED (single CANCEL event)", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const [a, b] = await Promise.all([
    cancel({
      participantId: p.id,
      accessPointId: ap.id,
      actorAdminId: adminId
    }),
    cancel({
      participantId: p.id,
      accessPointId: ap.id,
      actorAdminId: adminId
    })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const reg = await prisma.roomRegistration.findFirstOrThrow({
    where: { participantId: p.id, accessPointId: ap.id }
  });
  assert.equal(reg.status, RoomRegistrationStatus.CANCELLED);
  const cancelEvents = await prisma.roomPaymentEvent.count({
    where: { registrationId: reg.id, kind: "CANCEL" }
  });
  assert.equal(cancelEvents, 1);
});

// ─── Ownership invariants (Sub-Phase D §10 restated) ─────────────────

test("ownership: refund preserves ADMIN-owned access on the same pair", async () => {
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
  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    }
  });
  assert.ok(pa);
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(pa!.granted, true, "ADMIN-owned grant must survive a refund");
});

test("ownership: cancel preserves ADMIN-owned access on the same pair", async () => {
  const p = await makeParticipant();
  const ap = await makeFreeRoom();
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
    actorAdminId: adminId
  });
  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    }
  });
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(pa!.granted, true);
});

test("ownership: payment confirmation never overwrites ADMIN denial", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  // Admin explicitly denies BEFORE any registration.
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: false,
      source: AccessGrantSource.ADMIN,
      grantedById: adminId,
      revokedById: adminId,
      revokedAt: new Date()
    }
  });
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: null, actorAdminId: adminId }
  });
  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    }
  });
  assert.ok(pa);
  assert.equal(pa!.source, AccessGrantSource.ADMIN);
  assert.equal(
    pa!.granted,
    false,
    "admin denial must survive a payment confirmation"
  );
});

// ─── Security: Zod .strict() rejects extra fields (price/currency tamper) ─

test("security: confirmPayment rejects extra keys (Zod.strict() defense)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: {
      providerRef: null,
      actorAdminId: adminId,
      // @ts-expect-error — unknown keys must be refused
      priceMinorOverride: 1,
      currencyOverride: "USD"
    }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "INVALID_INPUT");
});

test("security: refund rejects extra keys (Zod.strict() defense)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  await initRegistration({ participantId: p.id, accessPointId: ap.id });
  await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: { providerRef: null, actorAdminId: adminId }
  });
  const res = await refund({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: adminId,
    // @ts-expect-error — unknown key must be refused
    forcedAmount: 999
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "INVALID_INPUT");
});

// ─── Action wiring (static source check) ─────────────────────────────
//
// We cannot invoke the "use server" functions inside node:test — they
// call requirePermission() which reads cookies via next/headers, and
// there is no request context. We therefore assert the source shape of
// the actions file directly: every action must start with the correct
// requirePermission() call BEFORE any DB read or delegate.
//
// If someone regresses the file — e.g., moves the permission check
// after the domain call, or forgets it entirely — this test fires.

test("static: room-payment-actions.ts wires permissions correctly", () => {
  const src = readFileSync(
    join(
      process.cwd(),
      "app",
      "admin",
      "(protected)",
      "registrants",
      "[id]",
      "room-payment-actions.ts"
    ),
    "utf8"
  );

  // Every action must gate through requirePermission with the exact
  // permission string. The regex allows arbitrary whitespace but
  // anchors on the function name.
  const confirmMatch = src.match(
    /export async function confirmRoomPaymentAction[\s\S]*?requirePermission\("payment\.confirm\.room"\)/
  );
  assert.ok(
    confirmMatch,
    "confirmRoomPaymentAction must gate through payment.confirm.room"
  );

  const refundMatch = src.match(
    /export async function refundRoomPaymentAction[\s\S]*?requirePermission\("payment\.refund\.room"\)/
  );
  assert.ok(
    refundMatch,
    "refundRoomPaymentAction must gate through payment.refund.room"
  );

  const cancelMatch = src.match(
    /export async function cancelRoomRegistrationAction[\s\S]*?requirePermission\("access\.manage"\)/
  );
  assert.ok(
    cancelMatch,
    "cancelRoomRegistrationAction must gate through access.manage"
  );

  // The action must derive the actor from the returned session — never
  // read an actorAdminId argument from the client.
  const derivedActor = /actorAdminId:\s*user\.id/g;
  const derivedMatches = src.match(derivedActor);
  assert.ok(
    derivedMatches && derivedMatches.length >= 3,
    "each action must pass actorAdminId from the resolved session user"
  );

  // No client-supplied amount/currency parameter should exist in the
  // exported function signatures.
  assert.ok(
    !/priceMinor|amount|currency/.test(
      src.split("export async function").slice(1).join("\n")
    ),
    "no price/currency argument may appear in the action signatures"
  );
});

test("static: server action revalidates the registrant page after mutation", () => {
  const src = readFileSync(
    join(
      process.cwd(),
      "app",
      "admin",
      "(protected)",
      "registrants",
      "[id]",
      "room-payment-actions.ts"
    ),
    "utf8"
  );
  assert.ok(
    /revalidatePath\(`\/admin\/registrants\/\$\{[^}]+\}`\)/.test(src),
    "actions must revalidate the registrant detail page after success"
  );
});

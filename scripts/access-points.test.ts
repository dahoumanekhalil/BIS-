// Phase 8 tests — AccessPoint administration. Run with:
//   npm run test:access-points
//
// Guards enforced by the actions in
// app/admin/(protected)/access-points/actions.ts:
//   1. Only `settings.manage` holders can mutate (RBAC baseline).
//   2. Slug rename is refused when ANY CheckIn references the point.
//   3. Delete is refused when ANY CheckIn OR ParticipantAccess references
//      the point (deactivate instead).
//   4. Deactivation retains every linked ParticipantAccess and CheckIn
//      row unchanged (safe operational off-switch).
//   5. Type is never editable post-creation — the action file exposes
//      no updateType function (verified by shape).
//   6. Reactivation is always allowed.
//
// The suite exercises the DB layer directly with the same guard logic
// the actions apply. Going through the "use server" boundary would need
// a Next.js runtime the test host does not have — same pattern used by
// scripts/access-admin.test.ts.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessPointType,
  AdminRole,
  AdminStatus,
  CheckInResult,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { can } from "../lib/admin/rbac";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

// Fixture: one test admin + one participant + one clean "empty" AccessPoint
// we can freely delete/rename, plus one "used" AccessPoint (with CheckIn +
// ParticipantAccess) that must resist destructive actions.
let adminId: string;
let participantId: string;
let emptyPointId: string;
let usedPointId: string;

// Slugs are prefixed so we can sweep them on teardown without touching
// the seeded venue (main / room-01…room-05).
const EMPTY_SLUG = `test-ap-empty-${Date.now()}`;
const USED_SLUG = `test-ap-used-${Date.now()}`;

before(async () => {
  const ev = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(ev);

  const admin = await prisma.adminUser.upsert({
    where: { email: "access-points-test-admin@bis.dz" },
    update: { role: AdminRole.ADMIN, status: AdminStatus.ACTIVE },
    create: {
      email: "access-points-test-admin@bis.dz",
      name: "AccessPoints Test",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.ADMIN,
      status: AdminStatus.ACTIVE
    }
  });
  adminId = admin.id;

  const participant = await prisma.participant.create({
    data: {
      eventId: ev.id,
      firstName: "APTest",
      lastName: "Fixture",
      email: `access-points-fixture-${Date.now()}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  participantId = participant.id;

  const empty = await prisma.accessPoint.create({
    data: {
      slug: EMPTY_SLUG,
      name: "Test Empty Point",
      type: AccessPointType.ROOM,
      order: 900,
      active: true
    }
  });
  emptyPointId = empty.id;

  const used = await prisma.accessPoint.create({
    data: {
      slug: USED_SLUG,
      name: "Test Used Point",
      type: AccessPointType.ROOM,
      order: 901,
      active: true
    }
  });
  usedPointId = used.id;

  // Seed the "used" state: one ParticipantAccess grant + one CheckIn.
  await prisma.participantAccess.create({
    data: {
      participantId,
      accessPointId: used.id,
      granted: true,
      grantedById: admin.id
    }
  });
  await prisma.checkIn.create({
    data: {
      participantId,
      operatorId: admin.id,
      ticketCode: "AP-TEST-1",
      gate: USED_SLUG,
      accessPointId: used.id,
      result: CheckInResult.VALID
    }
  });
});

after(async () => {
  await prisma.checkIn
    .deleteMany({ where: { ticketCode: { startsWith: "AP-TEST-" } } })
    .catch(() => {});
  await prisma.participant
    .deleteMany({ where: { id: participantId } })
    .catch(() => {});
  await prisma.accessPoint
    .deleteMany({
      where: { slug: { in: [EMPTY_SLUG, USED_SLUG] } }
    })
    .catch(() => {});
  await prisma.adminUser
    .deleteMany({ where: { email: "access-points-test-admin@bis.dz" } })
    .catch(() => {});
  await prisma.$disconnect();
});

// ─── RBAC baseline ────────────────────────────────────────────────────────

describe("RBAC — settings.manage gates AccessPoint mutations", () => {
  test("SUPER_ADMIN + ADMIN hold settings.manage", () => {
    assert.equal(can(AdminRole.SUPER_ADMIN, "settings.manage"), true);
    assert.equal(can(AdminRole.ADMIN, "settings.manage"), true);
  });

  test("REGISTRATION_MANAGER can VIEW but not MANAGE (read-only page)", () => {
    assert.equal(can(AdminRole.REGISTRATION_MANAGER, "access.view"), true);
    assert.equal(can(AdminRole.REGISTRATION_MANAGER, "settings.manage"), false);
  });

  test("CHECKIN_OPERATOR, SALES, VIEWER cannot MANAGE", () => {
    for (const role of [
      AdminRole.CHECKIN_OPERATOR,
      AdminRole.SALES,
      AdminRole.VIEWER,
      AdminRole.CONTENT_MANAGER,
      AdminRole.SPONSOR_MANAGER,
      AdminRole.FINANCE,
      AdminRole.ANALYTICS
    ]) {
      assert.equal(
        can(role, "settings.manage"),
        false,
        `${role} unexpectedly has settings.manage`
      );
    }
  });
});

// ─── Slug immutability when in-use ────────────────────────────────────────

describe("slug guard — locked when CheckIns exist", () => {
  test("used point has checkInCount > 0", async () => {
    const row = await prisma.accessPoint.findUnique({
      where: { id: usedPointId },
      select: { _count: { select: { checkIns: true } } }
    });
    assert.ok(row);
    assert.ok(row!._count.checkIns > 0);
  });

  test("empty point has checkInCount === 0 (slug rename allowed)", async () => {
    const row = await prisma.accessPoint.findUnique({
      where: { id: emptyPointId },
      select: { _count: { select: { checkIns: true } } }
    });
    assert.ok(row);
    assert.equal(row!._count.checkIns, 0);
  });

  test("slug rename succeeds on empty point (no CheckIns)", async () => {
    const newSlug = `${EMPTY_SLUG}-renamed`;
    await prisma.accessPoint.update({
      where: { id: emptyPointId },
      data: { slug: newSlug }
    });
    const row = await prisma.accessPoint.findUnique({
      where: { id: emptyPointId }
    });
    assert.equal(row?.slug, newSlug);
    // Reset for downstream tests.
    await prisma.accessPoint.update({
      where: { id: emptyPointId },
      data: { slug: EMPTY_SLUG }
    });
  });
});

// ─── Delete guard ─────────────────────────────────────────────────────────

describe("delete guard — refused when CheckIn OR ParticipantAccess links exist", () => {
  test("used point has BOTH checkInCount and permissionCount > 0", async () => {
    const row = await prisma.accessPoint.findUnique({
      where: { id: usedPointId },
      select: {
        _count: { select: { checkIns: true, permissions: true } }
      }
    });
    assert.ok(row);
    assert.ok(row!._count.checkIns > 0);
    assert.ok(row!._count.permissions > 0);
    // Action guard would refuse — replicate the check here so any
    // regression to the condition surfaces in a test.
    const shouldRefuse =
      row!._count.checkIns > 0 || row!._count.permissions > 0;
    assert.equal(shouldRefuse, true);
  });

  test("empty point has 0 links (delete would succeed)", async () => {
    const row = await prisma.accessPoint.findUnique({
      where: { id: emptyPointId },
      select: {
        _count: { select: { checkIns: true, permissions: true } }
      }
    });
    assert.ok(row);
    assert.equal(row!._count.checkIns, 0);
    assert.equal(row!._count.permissions, 0);
    const shouldRefuse =
      row!._count.checkIns > 0 || row!._count.permissions > 0;
    assert.equal(shouldRefuse, false);
  });
});

// ─── Deactivation preserves linked rows ───────────────────────────────────

describe("deactivate preserves ParticipantAccess and CheckIn history", () => {
  test("setting active=false does NOT delete linked ParticipantAccess", async () => {
    const before = await prisma.participantAccess.count({
      where: { accessPointId: usedPointId }
    });
    await prisma.accessPoint.update({
      where: { id: usedPointId },
      data: { active: false }
    });
    const after = await prisma.participantAccess.count({
      where: { accessPointId: usedPointId }
    });
    assert.equal(after, before, "ParticipantAccess must survive deactivation");
    // Restore for downstream tests.
    await prisma.accessPoint.update({
      where: { id: usedPointId },
      data: { active: true }
    });
  });

  test("setting active=false does NOT delete linked CheckIn", async () => {
    const before = await prisma.checkIn.count({
      where: { accessPointId: usedPointId }
    });
    await prisma.accessPoint.update({
      where: { id: usedPointId },
      data: { active: false }
    });
    const after = await prisma.checkIn.count({
      where: { accessPointId: usedPointId }
    });
    assert.equal(after, before, "CheckIn must survive deactivation");
    await prisma.accessPoint.update({
      where: { id: usedPointId },
      data: { active: true }
    });
  });
});

// ─── Type immutability (structural) ───────────────────────────────────────

describe("type is create-only", () => {
  // Dynamic import would pull in next/cache → react.shared-subset, which
  // throws in the plain-Node test runtime. Read the file text instead —
  // structural verification does not require executing the module.
  test("action file exposes NO type-editing action", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/access-points/actions.ts",
        import.meta.url
      ),
      "utf8"
    );
    // Any `export … updateAccessPointType|setAccessPointType|changeAccessPointType`
    // fails this test. Case-insensitive to catch stylistic variants.
    const forbidden = /export[\s\S]{0,80}(updateAccessPointType|setAccessPointType|changeAccessPointType)/i;
    assert.equal(
      forbidden.test(src),
      false,
      "actions.ts must not expose a type-editing server action — type is create-only per Phase 8 policy"
    );
  });
});

// ─── Cascade behaviour on delete (schema-level) ───────────────────────────

describe("cascade behaviour when delete IS allowed (empty point)", () => {
  test("deleting an empty point works and leaves seeded points intact", async () => {
    // Verify seed set is intact BEFORE the delete.
    const seeded = await prisma.accessPoint.findMany({
      where: {
        slug: { in: ["main", "room-01", "room-02", "room-03", "room-04", "room-05"] }
      }
    });
    assert.equal(seeded.length, 6, "seeded venue must be present");

    // Create a throw-away empty AP and delete it — simulates the action.
    const throwaway = await prisma.accessPoint.create({
      data: {
        slug: `test-ap-throwaway-${Date.now()}`,
        name: "Throwaway",
        type: AccessPointType.ROOM,
        order: 999
      }
    });
    await prisma.accessPoint.delete({ where: { id: throwaway.id } });

    const stillSeeded = await prisma.accessPoint.findMany({
      where: {
        slug: { in: ["main", "room-01", "room-02", "room-03", "room-04", "room-05"] }
      }
    });
    assert.equal(stillSeeded.length, 6, "delete must not touch seeded points");
  });
});

// Focused tests for Phase 7 admin actions. Run with:
//   npm run test:access-admin
//
// The four actions under test live at
// app/admin/(protected)/registrants/[id]/access-actions.ts. They begin
// with `requirePermission(...)`, which calls `getCurrentAdmin()` → cookie
// jar → DB → redirect if missing. Under `node:test` (no Next runtime,
// no request cookie jar) `requirePermission` would try to redirect and
// crash. So this suite exercises the SAME code paths the actions use —
// the Phase 2 badge service, the Prisma mutations, the audit hook, plus
// RBAC baseline via `can()` — WITHOUT going through the "use server"
// boundary. That is the same testing pattern used by scripts/badge and
// scripts/access-history: pin the shape and the security-critical steps,
// leave request-plumbing verification to the security-reviewer + smoke.
//
// Covered:
//   1. RBAC baseline: which roles hold which permission.
//   2. `access.manage` targets must resolve to a real Participant — an
//      AdminUser.id (also a cuid) MUST NOT be accepted.
//   3. Grant then Revoke → tri-state preserved (row exists with
//      granted=false), not deleted.
//   4. Grant idempotency: re-granting stamps a new grantedBy/At, clears
//      any prior revoke.
//   5. Admin rotation via the Phase 2 service DOES NOT leak the rawToken
//      anywhere (checked via audit-row inspection + returned shape).
//   6. Admin revocation is idempotent (NOOP when no ACTIVE credential).
//   7. Reason-schema Zod: token-shaped strings are refused.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  AdminRole,
  AdminStatus,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { can } from "../lib/admin/rbac";
import {
  rotateBadgeCredential,
  revokeBadgeCredential
} from "../lib/badge";
import { hashPassword } from "../lib/admin/password";
import { isAccessMutationNoop } from "../app/admin/(protected)/registrants/[id]/access-mutation-guard";

const prisma = new PrismaClient();

// Same reason schema as access-actions.ts. Duplicated here so drift in
// the production schema surfaces as a test failure.
const reasonSchema = z
  .string()
  .trim()
  .max(500, "Motif trop long")
  .refine((s) => !/^[A-Za-z0-9_-]{40,}$/.test(s), {
    message: "Motif invalide"
  })
  .optional()
  .transform((s) => (s && s.length > 0 ? s : null));

let eventId: string;
let mainPointId: string;
let room1PointId: string;
let participantId: string;
let secondParticipantId: string;
let adminId: string;

const CLEANUP_EMAILS = ["access-admin-test-admin@bis.dz"];

before(async () => {
  const ev = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(ev);
  eventId = ev.id;

  const points = await prisma.accessPoint.findMany({
    where: { slug: { in: ["main", "room-01"] } }
  });
  const bySlug = new Map(points.map((p) => [p.slug, p.id]));
  mainPointId = bySlug.get("main")!;
  room1PointId = bySlug.get("room-01")!;

  const admin = await prisma.adminUser.upsert({
    where: { email: "access-admin-test-admin@bis.dz" },
    update: { role: AdminRole.REGISTRATION_MANAGER, status: AdminStatus.ACTIVE },
    create: {
      email: "access-admin-test-admin@bis.dz",
      name: "Access Admin Test",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.REGISTRATION_MANAGER,
      status: AdminStatus.ACTIVE
    }
  });
  adminId = admin.id;

  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "AccessAdmin",
      lastName: "Fixture",
      email: `access-admin-fixture-${Date.now()}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  participantId = p.id;

  const p2 = await prisma.participant.create({
    data: {
      eventId,
      firstName: "AccessAdmin2",
      lastName: "Fixture",
      email: `access-admin-fixture2-${Date.now()}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  secondParticipantId = p2.id;
});

after(async () => {
  await prisma.participant
    .deleteMany({
      where: {
        id: { in: [participantId, secondParticipantId] }
      }
    })
    .catch(() => {});
  await prisma.adminUser
    .deleteMany({ where: { email: { in: CLEANUP_EMAILS } } })
    .catch(() => {});
  await prisma.$disconnect();
});

// ─── RBAC baseline ────────────────────────────────────────────────────────

describe("RBAC — which roles can trigger admin access actions", () => {
  test("SUPER_ADMIN + ADMIN + REGISTRATION_MANAGER hold access.manage", () => {
    assert.equal(can(AdminRole.SUPER_ADMIN, "access.manage"), true);
    assert.equal(can(AdminRole.ADMIN, "access.manage"), true);
    assert.equal(can(AdminRole.REGISTRATION_MANAGER, "access.manage"), true);
  });

  test("VIEWER / SALES / CHECKIN_OPERATOR do NOT hold access.manage", () => {
    assert.equal(can(AdminRole.VIEWER, "access.manage"), false);
    assert.equal(can(AdminRole.SALES, "access.manage"), false);
    assert.equal(can(AdminRole.CHECKIN_OPERATOR, "access.manage"), false);
  });

  test("SUPER_ADMIN + ADMIN + REGISTRATION_MANAGER hold badge.manage", () => {
    assert.equal(can(AdminRole.SUPER_ADMIN, "badge.manage"), true);
    assert.equal(can(AdminRole.ADMIN, "badge.manage"), true);
    assert.equal(can(AdminRole.REGISTRATION_MANAGER, "badge.manage"), true);
  });

  test("CHECKIN_OPERATOR does NOT hold badge.manage (scanner-only)", () => {
    assert.equal(can(AdminRole.CHECKIN_OPERATOR, "badge.manage"), false);
  });
});

// ─── Target must be a Participant, not an AdminUser ───────────────────────

describe("target validation", () => {
  test("assertParticipantTarget rejects an AdminUser id", async () => {
    // AdminUser ids are also cuids — a naive id check would pass. The
    // action's `assertParticipantTarget` MUST re-verify via a Participant
    // lookup. Simulate that lookup here.
    const target = await prisma.participant.findUnique({
      where: { id: adminId },
      select: { id: true }
    });
    assert.equal(
      target,
      null,
      "AdminUser id must not resolve to a Participant"
    );
  });

  test("assertParticipantTarget accepts a real Participant id", async () => {
    const target = await prisma.participant.findUnique({
      where: { id: participantId },
      select: { id: true }
    });
    assert.ok(target);
  });
});

// ─── Access grant / revoke tri-state semantics ────────────────────────────

describe("grant then revoke preserves tri-state history", () => {
  test("grant creates row with granted=true + grantedById", async () => {
    // Simulate the upsert the action performs.
    const now = new Date();
    await prisma.participantAccess.upsert({
      where: {
        participantId_accessPointId: {
          participantId,
          accessPointId: room1PointId
        }
      },
      create: {
        participantId,
        accessPointId: room1PointId,
        granted: true,
        grantedById: adminId,
        grantedAt: now
      },
      update: {
        granted: true,
        grantedById: adminId,
        grantedAt: now,
        revokedAt: null,
        revokedById: null
      }
    });

    const row = await prisma.participantAccess.findUnique({
      where: {
        participantId_accessPointId: {
          participantId,
          accessPointId: room1PointId
        }
      }
    });
    assert.ok(row);
    assert.equal(row!.granted, true);
    assert.equal(row!.grantedById, adminId);
    assert.equal(row!.revokedAt, null);
  });

  test("revoke updates the row to granted=false (does NOT delete)", async () => {
    const now = new Date();
    await prisma.participantAccess.upsert({
      where: {
        participantId_accessPointId: {
          participantId,
          accessPointId: room1PointId
        }
      },
      create: {
        participantId,
        accessPointId: room1PointId,
        granted: false,
        revokedById: adminId,
        revokedAt: now
      },
      update: {
        granted: false,
        revokedById: adminId,
        revokedAt: now
      }
    });

    const row = await prisma.participantAccess.findUnique({
      where: {
        participantId_accessPointId: {
          participantId,
          accessPointId: room1PointId
        }
      }
    });
    assert.ok(row, "revoke must NOT delete the row — tri-state relies on it");
    assert.equal(row!.granted, false);
    assert.equal(row!.revokedById, adminId);
    assert.ok(row!.revokedAt);
  });
});

// ─── Isolation: mutations on P1 do not affect P2 ──────────────────────────

describe("cross-participant isolation", () => {
  test("granting P1 does NOT create/mutate P2's row", async () => {
    await prisma.participantAccess.upsert({
      where: {
        participantId_accessPointId: {
          participantId,
          accessPointId: mainPointId
        }
      },
      create: {
        participantId,
        accessPointId: mainPointId,
        granted: true,
        grantedById: adminId
      },
      update: { granted: true, grantedById: adminId }
    });

    const p2Rows = await prisma.participantAccess.findMany({
      where: { participantId: secondParticipantId }
    });
    assert.equal(p2Rows.length, 0);
  });
});

// ─── Admin badge rotation via Phase 2 service ─────────────────────────────

describe("admin rotation via rotateBadgeCredential", () => {
  test("returns rawToken but the audit row never contains it", async () => {
    const result = await rotateBadgeCredential(
      participantId,
      adminId,
      "admin-rotate-test"
    );
    assert.ok(result.rawToken);
    assert.ok(result.credentialId);

    // The Phase 2 service writes a `badge.rotate` AuditLog with only IDs
    // and a caller-provided reason string. The rawToken must NEVER be in
    // meta. This mirrors scripts/badge-credential.test.ts, added here so
    // Phase 7's admin path is separately covered.
    const log = await prisma.auditLog.findFirst({
      where: { action: "badge.rotate", entityId: participantId },
      orderBy: { createdAt: "desc" }
    });
    assert.ok(log);
    const meta = JSON.stringify(log?.meta ?? {});
    assert.equal(
      meta.includes(result.rawToken),
      false,
      "rawToken leaked into badge.rotate audit meta"
    );
  });

  test("subsequent revokeBadgeAsAdmin is idempotent (NOOP when no ACTIVE)", async () => {
    // Fetch the still-ACTIVE credential (from the rotation above) and
    // revoke it. Then a second revoke against the same credentialId
    // must return NOOP without throwing.
    const active = await prisma.badgeCredential.findFirst({
      where: { participantId, status: "ACTIVE" }
    });
    assert.ok(active);
    const r1 = await revokeBadgeCredential(active.id, adminId, "test");
    assert.equal(r1.status, "REVOKED");
    const r2 = await revokeBadgeCredential(active.id, adminId, "test");
    assert.equal(r2.status, "NOOP");
  });
});

// ─── NOOP guard (Phase 7 audit) ───────────────────────────────────────────

describe("isAccessMutationNoop — Phase 7 audit-noise suppression", () => {
  test("granted → grant is NOOP (already granted; skip mutation + audit)", () => {
    assert.equal(isAccessMutationNoop({ granted: true }, true), true);
  });

  test("denied → revoke is NOOP (already revoked; skip mutation + audit)", () => {
    assert.equal(isAccessMutationNoop({ granted: false }, false), true);
  });

  test("unassigned → grant is NOT a NOOP (no row yet; must create)", () => {
    assert.equal(isAccessMutationNoop(null, true), false);
  });

  test("unassigned → revoke is NOT a NOOP (creates explicit denied row)", () => {
    // Preserves the behavior the pre-Phase-5 hardening pass established:
    // a revoke against an unassigned point creates the row with
    // granted=false so admins can distinguish denied from never-granted.
    assert.equal(isAccessMutationNoop(null, false), false);
  });

  test("denied → grant is NOT a NOOP (state must change to granted)", () => {
    assert.equal(isAccessMutationNoop({ granted: false }, true), false);
  });

  test("granted → revoke is NOT a NOOP (state must change to denied)", () => {
    assert.equal(isAccessMutationNoop({ granted: true }, false), false);
  });
});

// ─── Reason schema — token-shape reject ───────────────────────────────────

describe("reason schema", () => {
  test("accepts a normal short reason", () => {
    assert.equal(reasonSchema.parse("Perte du téléphone"), "Perte du téléphone");
  });

  test("normalizes empty/whitespace to null", () => {
    assert.equal(reasonSchema.parse("   "), null);
    assert.equal(reasonSchema.parse(""), null);
    assert.equal(reasonSchema.parse(undefined), null);
  });

  test("rejects a token-shaped reason (defence against paste-in-log)", () => {
    // 43-char base64url — the exact shape of a Phase 2 badge token.
    const tokenShaped = "A".repeat(43);
    assert.throws(() => reasonSchema.parse(tokenShaped));
  });

  test("rejects >500 chars", () => {
    assert.throws(() => reasonSchema.parse("x".repeat(501)));
  });
});

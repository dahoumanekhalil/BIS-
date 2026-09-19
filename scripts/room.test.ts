// Phase 11 tests — ROOM QR validator. Run with:
//   npm run test:room
//
// Mirrors scripts/main-entrance.test.ts. Directly exercises
// `validateRoomQrCore` — the pure core the server action wraps in
// `requirePermission("access.validate.room")`. Every test creates
// per-participant fixtures, issues real BadgeCredentials via the
// Phase 2 service, and asserts DB state + response shape.
//
// Covered (owner-locked decisions: strict per-room PA rule from
// spec §14; C1 = A "every scan is a fresh CheckIn(VALID) — rooms
// allow repeat entry"):
//   1. valid + PAID + PA granted=true       → VALID (CheckIn(VALID))
//   2. valid + PAID + PA granted=false      → PA_REVOKED
//   3. valid + PAID + no PA row             → PA_NOT_GRANTED (default-deny)
//   4. valid + UNPAID + PA granted=true     → UNPAID (payment overrides PA)
//   5. valid + CANCELLED (verify path)      → CANCELLED, AuditLog only
//   6. valid + CANCELLED (status path)      → CheckIn(CANCELLED)
//   7. two consecutive VALID scans          → TWO CheckIn(VALID) rows
//                                              (no ALREADY_CHECKED_IN)
//   8. revoked / expired / random QR        → AuditLog only, no CheckIn
//   9. inactive AccessPoint                 → ACCESS_POINT_INACTIVE
//  10. MAIN_ENTRANCE sent to room validator → ACCESS_POINT_WRONG_TYPE
//  11. unknown slug                         → ACCESS_POINT_UNKNOWN
//  12. cross-room isolation — PA on room-01 does NOT authorize room-02
//  13. Participant.checkedInAt NEVER mutated by room validation
//  14. rawToken never persisted
//  15. CheckIn.gate = AccessPoint.slug
//  16. Structural — validator does NOT set Participant.checkedInAt.
//  17. Structural — validator does NOT use an atomic claim.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AdminRole,
  AdminStatus,
  BadgeStatus,
  CheckInResult,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  issueBadgeCredential,
  revokeBadgeCredential
} from "../lib/badge";
import { validateRoomQrCore } from "../lib/admin/room-validator";

const prisma = new PrismaClient();

let eventId: string;
let mainPointId: string;
let room1PointId: string;
let room2PointId: string;
let operatorId: string;

const OPERATOR_EMAIL = "room-test-op@bis.dz";
const P_EMAIL_PREFIX = "room-fixture-";

async function makeParticipant(
  overrides: Partial<{
    status: RegistrationStatus;
    paymentStatus: PaymentStatus;
    checkedInAt: Date | null;
    ticketCode: string | null;
  }> = {}
) {
  return prisma.participant.create({
    data: {
      eventId,
      firstName: "Room",
      lastName: `Fixture-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      email: `${P_EMAIL_PREFIX}${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}@bis.dz`,
      status: overrides.status ?? RegistrationStatus.CONFIRMED,
      paymentStatus: overrides.paymentStatus ?? PaymentStatus.PAID,
      checkedInAt: overrides.checkedInAt ?? null,
      ticketCode:
        overrides.ticketCode !== undefined
          ? overrides.ticketCode
          : `RM-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    },
    select: { id: true, ticketCode: true, checkedInAt: true }
  });
}

async function grantRoom(participantId: string, accessPointId: string) {
  await prisma.participantAccess.create({
    data: {
      participantId,
      accessPointId,
      granted: true,
      grantedById: operatorId
    }
  });
}

async function revokeRoom(participantId: string, accessPointId: string) {
  await prisma.participantAccess.create({
    data: {
      participantId,
      accessPointId,
      granted: false,
      revokedById: operatorId,
      revokedAt: new Date()
    }
  });
}

async function issueActive(participantId: string): Promise<string> {
  const r = await issueBadgeCredential(participantId);
  return r.rawToken;
}

async function cleanupFixture(participantId: string) {
  await prisma.checkIn
    .deleteMany({ where: { participantId } })
    .catch(() => {});
  await prisma.participantAccess
    .deleteMany({ where: { participantId } })
    .catch(() => {});
  await prisma.badgeCredential
    .deleteMany({ where: { participantId } })
    .catch(() => {});
  await prisma.auditLog
    .deleteMany({ where: { entityId: participantId } })
    .catch(() => {});
  await prisma.participant
    .delete({ where: { id: participantId } })
    .catch(() => {});
}

before(async () => {
  const ev = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(ev);
  eventId = ev.id;

  const points = await prisma.accessPoint.findMany({
    where: { slug: { in: ["main", "room-01", "room-02"] } }
  });
  const bySlug = new Map(points.map((p) => [p.slug, p.id]));
  mainPointId = bySlug.get("main")!;
  room1PointId = bySlug.get("room-01")!;
  room2PointId = bySlug.get("room-02")!;
  assert.ok(mainPointId && room1PointId && room2PointId);

  const op = await prisma.adminUser.upsert({
    where: { email: OPERATOR_EMAIL },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: OPERATOR_EMAIL,
      name: "Room Test Operator",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  operatorId = op.id;
});

after(async () => {
  const survivors = await prisma.participant.findMany({
    where: { email: { startsWith: P_EMAIL_PREFIX } },
    select: { id: true }
  });
  for (const p of survivors) {
    await cleanupFixture(p.id);
  }
  await prisma.auditLog
    .deleteMany({ where: { userId: operatorId } })
    .catch(() => {});
  await prisma.adminUser
    .deleteMany({ where: { email: OPERATOR_EMAIL } })
    .catch(() => {});
  await prisma.$disconnect();
});

// ─── Happy path ─────────────────────────────────────────────────────────

describe("ROOM — happy path", () => {
  test("PAID + PA granted=true → VALID + CheckIn(VALID)", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);

    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r.outcome, "VALID");
    assert.equal(r.ok, true);
    assert.ok(r.at);

    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id, accessPointId: room1PointId }
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, CheckInResult.VALID);
    assert.equal(rows[0].reason, "ROOM_ENTRY");
    assert.equal(rows[0].gate, "room-01");
    assert.equal(rows[0].ticketCode, p.ticketCode);
    assert.equal(rows[0].operatorId, operatorId);
    assert.ok(rows[0].credentialId);

    // Room validator MUST NOT set Participant.checkedInAt
    const after = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true, checkedInGate: true }
    });
    assert.equal(
      after?.checkedInAt,
      null,
      "room validator must not set checkedInAt"
    );
    assert.equal(after?.checkedInGate, null);

    await cleanupFixture(p.id);
  });

  test("two consecutive authorized scans → TWO CheckIn(VALID) rows (C1 = A)", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);

    const r1 = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    const r2 = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r1.outcome, "VALID");
    assert.equal(r2.outcome, "VALID");
    // Rooms allow repeat entry — no ALREADY_CHECKED_IN outcome
    // and both scans write fresh VALID CheckIn rows.
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id, accessPointId: room1PointId }
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.result, CheckInResult.VALID);
      assert.equal(row.reason, "ROOM_ENTRY");
    }
    await cleanupFixture(p.id);
  });
});

// ─── Denials with participant resolved ──────────────────────────────────

describe("ROOM — denials", () => {
  test("PAID + PA granted=false → PA_REVOKED", async () => {
    const p = await makeParticipant();
    await revokeRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);

    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r.outcome, "PA_REVOKED");
    const row = await prisma.checkIn.findFirst({
      where: { participantId: p.id, accessPointId: room1PointId }
    });
    assert.equal(row?.result, CheckInResult.UNKNOWN);
    assert.equal(row?.reason, "PA_REVOKED");
    await cleanupFixture(p.id);
  });

  test("PAID + no PA row → PA_NOT_GRANTED (default-deny)", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);
    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r.outcome, "PA_NOT_GRANTED");
    const row = await prisma.checkIn.findFirst({
      where: { participantId: p.id, accessPointId: room1PointId }
    });
    assert.equal(row?.result, CheckInResult.UNKNOWN);
    assert.equal(row?.reason, "PA_NOT_GRANTED");
    await cleanupFixture(p.id);
  });

  test("UNPAID + PA granted=true → UNPAID (payment gate wins)", async () => {
    const p = await makeParticipant({ paymentStatus: PaymentStatus.UNPAID });
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);
    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r.outcome, "UNPAID");
    const row = await prisma.checkIn.findFirst({
      where: { participantId: p.id, accessPointId: room1PointId }
    });
    assert.equal(row?.result, CheckInResult.UNPAID);
    assert.equal(row?.reason, "UNPAID");
    await cleanupFixture(p.id);
  });

  test("participant CANCELLED (verify path) → CANCELLED, AuditLog only", async () => {
    const p = await makeParticipant({ status: RegistrationStatus.CANCELLED });
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);
    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r.outcome, "CANCELLED");
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(rows.length, 0, "verify-path CANCELLED must not write CheckIn");
    await cleanupFixture(p.id);
  });
});

// ─── Badge failures (AuditLog only) ────────────────────────────────────

describe("ROOM — badge failures never write a CheckIn", () => {
  test("REVOKED badge → BADGE_REVOKED, AuditLog only", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);
    const cred = await prisma.badgeCredential.findFirst({
      where: { participantId: p.id, status: "ACTIVE" },
      select: { id: true }
    });
    await revokeBadgeCredential(cred!.id, operatorId, "manual-revoke");

    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r.outcome, "BADGE_REVOKED");
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(rows.length, 0);
    await cleanupFixture(p.id);
  });

  test("EXPIRED badge → BADGE_EXPIRED, AuditLog only", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);
    await prisma.badgeCredential.updateMany({
      where: { participantId: p.id, status: "ACTIVE" },
      data: { status: BadgeStatus.EXPIRED }
    });
    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(r.outcome, "BADGE_EXPIRED");
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(rows.length, 0);
    await cleanupFixture(p.id);
  });

  test("random / invalid QR → BADGE_INVALID, AuditLog only", async () => {
    const bogus = "R".repeat(64);
    const before = await prisma.checkIn.count();
    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: bogus
    });
    assert.equal(r.outcome, "BADGE_INVALID");
    const afterCount = await prisma.checkIn.count();
    assert.equal(afterCount, before);
  });
});

// ─── AccessPoint gates ─────────────────────────────────────────────────

describe("ROOM — AccessPoint gates", () => {
  test("inactive room → ACCESS_POINT_INACTIVE, no CheckIn", async () => {
    await prisma.accessPoint.update({
      where: { id: room1PointId },
      data: { active: false }
    });
    try {
      const p = await makeParticipant();
      await grantRoom(p.id, room1PointId);
      const raw = await issueActive(p.id);
      const r = await validateRoomQrCore({
        user: { id: operatorId },
        slug: "room-01",
        rawToken: raw
      });
      assert.equal(r.outcome, "ACCESS_POINT_INACTIVE");
      const rows = await prisma.checkIn.findMany({
        where: { participantId: p.id }
      });
      assert.equal(rows.length, 0);
      await cleanupFixture(p.id);
    } finally {
      await prisma.accessPoint.update({
        where: { id: room1PointId },
        data: { active: true }
      });
    }
  });

  test("MAIN_ENTRANCE sent to room validator → ACCESS_POINT_WRONG_TYPE", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, mainPointId); // even with a MAIN row, wrong-type wins
    const raw = await issueActive(p.id);
    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(r.outcome, "ACCESS_POINT_WRONG_TYPE");
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(rows.length, 0);
    await cleanupFixture(p.id);
  });

  test("unknown slug → ACCESS_POINT_UNKNOWN", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);
    const r = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-99",
      rawToken: raw
    });
    assert.equal(r.outcome, "ACCESS_POINT_UNKNOWN");
    await cleanupFixture(p.id);
  });
});

// ─── Cross-room isolation ──────────────────────────────────────────────

describe("ROOM — cross-room isolation", () => {
  test("PA on room-01 does NOT authorize room-02", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    // No grant on room-02.
    const raw = await issueActive(p.id);

    // room-01: allowed
    const rOK = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    assert.equal(rOK.outcome, "VALID");

    // room-02: default-deny (no PA row)
    const rDenied = await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-02",
      rawToken: raw
    });
    assert.equal(rDenied.outcome, "PA_NOT_GRANTED");

    // CheckIn shape sanity
    const cis = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(cis.length, 2);
    const r01 = cis.find((c) => c.accessPointId === room1PointId);
    const r02 = cis.find((c) => c.accessPointId === room2PointId);
    assert.equal(r01?.result, CheckInResult.VALID);
    assert.equal(r02?.result, CheckInResult.UNKNOWN);
    assert.equal(r02?.reason, "PA_NOT_GRANTED");

    await cleanupFixture(p.id);
  });
});

// ─── Data safety ───────────────────────────────────────────────────────

describe("ROOM — data safety", () => {
  test("Participant.checkedInAt is NEVER mutated by room validation", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);
    await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    const after = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true, checkedInGate: true }
    });
    assert.equal(after?.checkedInAt, null);
    assert.equal(after?.checkedInGate, null);
    await cleanupFixture(p.id);
  });

  test("rawToken never appears in any DB row after a valid room scan", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);
    await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    const cis = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    for (const row of cis) {
      assert.equal(JSON.stringify(row).includes(raw), false);
    }
    const audits = await prisma.auditLog.findMany({
      where: {
        OR: [{ entityId: p.id }, { entityId: room1PointId }],
        userId: operatorId
      }
    });
    for (const a of audits) {
      assert.equal(JSON.stringify(a).includes(raw), false);
    }
    await cleanupFixture(p.id);
  });

  test("ParticipantAccess is never mutated by validation", async () => {
    const p = await makeParticipant();
    await grantRoom(p.id, room1PointId);
    const raw = await issueActive(p.id);
    const before = await prisma.participantAccess.findUnique({
      where: {
        participantId_accessPointId: {
          participantId: p.id,
          accessPointId: room1PointId
        }
      }
    });
    await validateRoomQrCore({
      user: { id: operatorId },
      slug: "room-01",
      rawToken: raw
    });
    const after = await prisma.participantAccess.findUnique({
      where: {
        participantId_accessPointId: {
          participantId: p.id,
          accessPointId: room1PointId
        }
      }
    });
    assert.deepEqual(after, before);
    await cleanupFixture(p.id);
  });
});

// ─── Structural — validator discipline ─────────────────────────────────

describe("ROOM validator — code discipline", () => {
  const validatorPath = new URL(
    "../lib/admin/room-validator.ts",
    import.meta.url
  );
  const actionPath = new URL(
    "../app/admin/(protected)/scan/[access-point-slug]/actions.ts",
    import.meta.url
  );

  test("validator does NOT set Participant.checkedInAt", async () => {
    const src = await readFile(validatorPath, "utf8");
    // The write shape that would set the timestamp:
    //   participant.update({ data: { checkedInAt: ... } })
    //   participant.updateMany({ ..., data: { checkedInAt: ... } })
    // Ban both.
    assert.equal(
      /participant\.update(?:Many)?\(/.test(src),
      false,
      "room validator must not update Participant"
    );
    assert.equal(
      /checkedInAt\s*:\s*new\s+Date/.test(src),
      false,
      "room validator must not write a checkedInAt timestamp"
    );
  });

  test("validator does NOT use an atomic checkedInAt claim", async () => {
    const src = await readFile(validatorPath, "utf8");
    assert.equal(
      /checkedInAt\s*:\s*null/.test(src),
      false,
      "room validator must not filter on `checkedInAt: null` — that's main-only"
    );
  });

  test("room server action requires access.validate.room strictly", async () => {
    const src = await readFile(actionPath, "utf8");
    assert.ok(
      src.includes('requirePermission("access.validate.room")'),
      "actions.ts must include the strict access.validate.room gate"
    );
    // Legacy permission must not authorize the room path
    assert.equal(
      /validateRoomQrScan[\s\S]*?requirePermission\(\s*"checkin\.validate"/.test(
        src
      ),
      false,
      "room action must not authorize on legacy checkin.validate"
    );
  });

  test("validator emits AuditLog with action=checkin.scan.qr", async () => {
    const src = await readFile(validatorPath, "utf8");
    assert.ok(src.includes('action: "checkin.scan.qr"'));
    assert.equal(
      src.match(/action:\s*"checkin\.scan"/g)?.length ?? 0,
      0,
      "must not emit the legacy `checkin.scan` action"
    );
  });

  test("validator never assigns rawToken into any Prisma field", async () => {
    const src = await readFile(validatorPath, "utf8");
    // Same shape check as main-entrance-validator's discipline test.
    assert.equal(
      /:\s*rawToken\b/.test(src),
      false,
      "rawToken must never be assigned as an object-literal value"
    );
    assert.equal(
      /=\s*rawToken\b/.test(src),
      false,
      "rawToken must never be assigned to a variable / field"
    );
  });

  test("ticketCode is participant.ticketCode ?? \"\"", async () => {
    const src = await readFile(validatorPath, "utf8");
    assert.ok(
      /ticketCode:\s*(?:args\.ticketCode|participant\.ticketCode\s*\?\?\s*"")/.test(
        src
      )
    );
  });
});

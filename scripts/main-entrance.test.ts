// Phase 10 tests — MAIN_ENTRANCE QR validator. Run with:
//   npm run test:main-entrance
//
// Directly exercises `validateMainEntranceQrCore` — the pure core the
// server action wraps in `requirePermission(...)`. Every test creates
// per-participant fixtures, issues real BadgeCredentials via the
// Phase 2 service, and asserts DB state + response shape.
//
// Covered (owner-locked decisions B1 = C, B2 = A, B3 = B):
//   1. valid + PAID + no PA row              → VALID
//   2. valid + PAID + PA granted=true        → VALID
//   3. valid + PAID + PA granted=false       → PA_REVOKED, no checkedInAt
//   4. valid + UNPAID                        → UNPAID
//   5. valid + CANCELLED                     → CANCELLED
//   6. valid + already checked in            → ALREADY_CHECKED_IN, no re-write
//   7. revoked badge                         → BADGE_REVOKED, AuditLog only
//   8. expired badge                         → BADGE_EXPIRED, AuditLog only
//   9. invalid/random QR                     → BADGE_INVALID, AuditLog only
//  10. inactive AccessPoint                  → ACCESS_POINT_INACTIVE
//  11. ROOM AccessPoint                      → ACCESS_POINT_WRONG_TYPE
//  12. concurrent scans                      → exactly one VALID
//  13. rawToken never persisted / audited
//  14. one AuditLog per scan attempt
//  15. ParticipantAccess untouched by validation
//  16. CheckIn.ticketCode = participant.ticketCode ?? ""
//  17. CheckIn.gate = AccessPoint.slug
//  18. CheckIn.accessPointId = resolved MAIN_ENTRANCE id
//  19. Legacy manual `validateTicket` still uses `checkin.validate` +
//      `"checkin.scan"` audit action + non-QR path (structural).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AdminRole,
  AdminStatus,
  CheckInResult,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus,
  BadgeStatus
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  issueBadgeCredential,
  revokeBadgeCredential
} from "../lib/badge";
import { validateMainEntranceQrCore } from "../lib/admin/main-entrance-validator";

const prisma = new PrismaClient();

let eventId: string;
let mainPointId: string;
let room1PointId: string;
let operatorId: string;

const OPERATOR_EMAIL = "main-entrance-test-op@bis.dz";
const P_EMAIL_PREFIX = "main-entrance-fixture-";

async function makeParticipant(
  overrides: Partial<{
    status: RegistrationStatus;
    paymentStatus: PaymentStatus;
    checkedInAt: Date | null;
    ticketCode: string | null;
  }> = {}
) {
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "Main",
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
          : `TC-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    },
    select: {
      id: true,
      ticketCode: true
    }
  });
  return p;
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
    where: { slug: { in: ["main", "room-01"] } }
  });
  const bySlug = new Map(points.map((p) => [p.slug, p.id]));
  mainPointId = bySlug.get("main")!;
  room1PointId = bySlug.get("room-01")!;
  assert.ok(mainPointId, "seeded MAIN_ENTRANCE (main) missing");
  assert.ok(room1PointId, "seeded ROOM (room-01) missing");

  const op = await prisma.adminUser.upsert({
    where: { email: OPERATOR_EMAIL },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: OPERATOR_EMAIL,
      name: "Main Entrance Test Operator",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  operatorId = op.id;
});

after(async () => {
  // Delete every participant we created during the run (email prefix
  // filter), plus their derived rows.
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

// ─── Happy paths ─────────────────────────────────────────────────────────

describe("MAIN_ENTRANCE — happy paths", () => {
  test("PAID + eligible + no ParticipantAccess row → VALID", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);

    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });

    assert.equal(r.outcome, "VALID");
    assert.equal(r.ok, true);
    assert.ok(r.participant);
    assert.ok(r.at);
    // CheckIn row
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id, accessPointId: mainPointId },
      select: {
        result: true,
        ticketCode: true,
        gate: true,
        credentialId: true,
        accessPointId: true,
        operatorId: true,
        reason: true
      }
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, CheckInResult.VALID);
    assert.equal(rows[0].ticketCode, p.ticketCode);
    assert.equal(rows[0].gate, "main");
    assert.ok(rows[0].credentialId);
    assert.equal(rows[0].operatorId, operatorId);
    assert.equal(rows[0].reason, "FIRST_SCAN");
    // Participant.checkedInAt was written
    const after = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true, checkedInGate: true }
    });
    assert.ok(after?.checkedInAt);
    assert.equal(after?.checkedInGate, "main");

    await cleanupFixture(p.id);
  });

  test("PAID + PA granted=true → VALID (does not depend on override)", async () => {
    const p = await makeParticipant();
    await prisma.participantAccess.create({
      data: {
        participantId: p.id,
        accessPointId: mainPointId,
        granted: true,
        grantedById: operatorId
      }
    });
    const raw = await issueActive(p.id);

    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(r.outcome, "VALID");
    await cleanupFixture(p.id);
  });

  test("second scan for the same participant → ALREADY_CHECKED_IN, no re-write", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);

    const first = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(first.outcome, "VALID");
    const afterFirst = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true }
    });
    const firstAt = afterFirst?.checkedInAt?.toISOString();
    assert.ok(firstAt);

    // Small delay so any accidental re-write would produce a different
    // timestamp — the test asserts the timestamp does NOT change.
    await new Promise((r) => setTimeout(r, 5));

    const second = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(second.outcome, "ALREADY_CHECKED_IN");
    assert.equal(second.ok, true);
    assert.equal(second.at, firstAt, "checkedInAt must not change on repeat");

    // Two CheckIn rows, one VALID one ALREADY_CHECKED_IN
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id, accessPointId: mainPointId },
      orderBy: { scannedAt: "asc" },
      select: { result: true, reason: true }
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].result, CheckInResult.VALID);
    assert.equal(rows[1].result, CheckInResult.ALREADY_CHECKED_IN);
    assert.equal(rows[1].reason, "REPEAT_SCAN");

    await cleanupFixture(p.id);
  });
});

// ─── Denials with participant resolved (CheckIn row IS written) ─────────

describe("MAIN_ENTRANCE — denials with participant resolved", () => {
  test("PAID + PA granted=false → PA_REVOKED, no checkedInAt", async () => {
    const p = await makeParticipant();
    await prisma.participantAccess.create({
      data: {
        participantId: p.id,
        accessPointId: mainPointId,
        granted: false,
        revokedById: operatorId,
        revokedAt: new Date()
      }
    });
    const raw = await issueActive(p.id);

    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(r.outcome, "PA_REVOKED");
    assert.equal(r.ok, false);
    // CheckIn shape
    const row = await prisma.checkIn.findFirst({
      where: { participantId: p.id, accessPointId: mainPointId }
    });
    assert.ok(row);
    assert.equal(row?.result, CheckInResult.UNKNOWN);
    assert.equal(row?.reason, "PA_REVOKED");
    // checkedInAt still null
    const after = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true }
    });
    assert.equal(after?.checkedInAt, null);

    await cleanupFixture(p.id);
  });

  test("UNPAID → UNPAID CheckIn + no checkedInAt", async () => {
    const p = await makeParticipant({ paymentStatus: PaymentStatus.UNPAID });
    const raw = await issueActive(p.id);

    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(r.outcome, "UNPAID");
    const row = await prisma.checkIn.findFirst({
      where: { participantId: p.id, accessPointId: mainPointId }
    });
    assert.equal(row?.result, CheckInResult.UNPAID);
    assert.equal(row?.reason, "UNPAID");
    const after = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true }
    });
    assert.equal(after?.checkedInAt, null);

    await cleanupFixture(p.id);
  });

  test("participant.status === CANCELLED → CANCELLED CheckIn + no checkedInAt", async () => {
    const p = await makeParticipant({ status: RegistrationStatus.CANCELLED });
    // Note: verifyBadgeToken returns PARTICIPANT_CANCELLED for a
    // CANCELLED participant even before we reach the status gate. Both
    // paths produce outcome=CANCELLED for the operator. The two paths
    // differ in whether a CheckIn row is written (verify-path: no,
    // status-gate path: yes). Here we make status=CANCELLED and then
    // rely on the verify-first path: verifyBadgeToken sees the
    // credential is ACTIVE but the participant is CANCELLED, returns
    // {ok:false, reason: PARTICIPANT_CANCELLED}. AuditLog only.
    const raw = await issueActive(p.id);

    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(r.outcome, "CANCELLED");
    // Path via verifyBadgeToken failure → AuditLog only (per B4).
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(
      rows.length,
      0,
      "PARTICIPANT_CANCELLED at the verify layer must not write a CheckIn"
    );
    const audits = await prisma.auditLog.findMany({
      where: {
        userId: operatorId,
        action: "checkin.scan.qr",
        // audit meta references the access point id, not the participant
        entity: "AccessPoint",
        entityId: mainPointId
      }
    });
    assert.ok(audits.length >= 1);

    await cleanupFixture(p.id);
  });
});

// ─── Badge failures — AuditLog only (B4) ────────────────────────────────

describe("MAIN_ENTRANCE — badge failures never write a CheckIn", () => {
  test("REVOKED badge → BADGE_REVOKED, AuditLog only", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);
    // Revoke via the service, then scan with the (now stale) token.
    const cred = await prisma.badgeCredential.findFirst({
      where: { participantId: p.id, status: "ACTIVE" },
      select: { id: true }
    });
    await revokeBadgeCredential(cred!.id, operatorId, "manual-revoke");

    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(r.outcome, "BADGE_REVOKED");
    // No CheckIn
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(rows.length, 0);
    // AuditLog written on the AccessPoint entity
    const audits = await prisma.auditLog.findMany({
      where: {
        userId: operatorId,
        action: "checkin.scan.qr",
        entity: "AccessPoint",
        entityId: mainPointId
      }
    });
    assert.ok(audits.length >= 1);
    await cleanupFixture(p.id);
  });

  test("EXPIRED badge → BADGE_EXPIRED, AuditLog only", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);
    // Flip the credential to EXPIRED directly (no Phase 2 service
    // helper for this).
    await prisma.badgeCredential.updateMany({
      where: { participantId: p.id, status: "ACTIVE" },
      data: { status: BadgeStatus.EXPIRED }
    });

    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    assert.equal(r.outcome, "BADGE_EXPIRED");
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(rows.length, 0);
    await cleanupFixture(p.id);
  });

  test("random/invalid QR string → BADGE_INVALID, AuditLog only, no CheckIn", async () => {
    // The fake token is arbitrary — long enough to pass the
    // MIN_TOKEN_LENGTH short-circuit but unmatched by any credential
    // hash in the DB. verifyBadgeToken returns INVALID for both a
    // shape miss and a hash miss.
    const bogus = "A".repeat(64);
    const before = await prisma.checkIn.count();
    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: bogus
    });
    assert.equal(r.outcome, "BADGE_INVALID");
    // No CheckIn row created anywhere for this scan
    const afterCount = await prisma.checkIn.count();
    assert.equal(afterCount, before);
    // AuditLog was written on the AccessPoint
    const audits = await prisma.auditLog.findMany({
      where: {
        userId: operatorId,
        action: "checkin.scan.qr",
        entity: "AccessPoint",
        entityId: mainPointId
      }
    });
    assert.ok(audits.length >= 1);
  });
});

// ─── AccessPoint gates ──────────────────────────────────────────────────

describe("MAIN_ENTRANCE — AccessPoint gates", () => {
  test("inactive AccessPoint → ACCESS_POINT_INACTIVE, no CheckIn", async () => {
    // Toggle the main point inactive for the duration of this test.
    await prisma.accessPoint.update({
      where: { id: mainPointId },
      data: { active: false }
    });
    try {
      const p = await makeParticipant();
      const raw = await issueActive(p.id);
      const r = await validateMainEntranceQrCore({
        user: { id: operatorId },
        slug: "main",
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
        where: { id: mainPointId },
        data: { active: true }
      });
    }
  });

  test("ROOM AccessPoint passed to main validator → ACCESS_POINT_WRONG_TYPE", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);
    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "room-01",
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
    const r = await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "does-not-exist",
      rawToken: raw
    });
    assert.equal(r.outcome, "ACCESS_POINT_UNKNOWN");
    await cleanupFixture(p.id);
  });
});

// ─── Concurrency — atomic claim ─────────────────────────────────────────

describe("MAIN_ENTRANCE — atomic checkedInAt claim", () => {
  test("5 concurrent scans on the same participant → exactly one VALID", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);

    const results = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        validateMainEntranceQrCore({
          user: { id: operatorId },
          slug: "main",
          rawToken: raw
        })
      )
    );

    const valids = results.filter((r) => r.outcome === "VALID").length;
    const already = results.filter(
      (r) => r.outcome === "ALREADY_CHECKED_IN"
    ).length;
    assert.equal(valids, 1, "exactly one scan must win the atomic claim");
    assert.equal(already, 4, "the other four must be ALREADY_CHECKED_IN");

    // The participant's checkedInAt is set exactly once and never
    // updated by the losers.
    const after = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true }
    });
    assert.ok(after?.checkedInAt);

    // Every attempt still writes an AuditLog and a CheckIn row.
    const cis = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    assert.equal(cis.length, 5);
    const audits = await prisma.auditLog.findMany({
      where: {
        userId: operatorId,
        action: "checkin.scan.qr",
        entity: "Participant",
        entityId: p.id
      }
    });
    assert.equal(audits.length, 5);

    await cleanupFixture(p.id);
  });
});

// ─── Data safety ────────────────────────────────────────────────────────

describe("MAIN_ENTRANCE — data safety", () => {
  test("rawToken never appears in DB after a valid scan", async () => {
    const p = await makeParticipant();
    const raw = await issueActive(p.id);
    await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });

    // Search every row we might have written for the raw token.
    // Note: substring search in JS after fetching — the DB has no
    // literal `contains` for `Json` in Prisma.
    const ci = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    for (const row of ci) {
      const s = JSON.stringify(row);
      assert.equal(
        s.includes(raw),
        false,
        "rawToken must not appear in any CheckIn field"
      );
    }
    const audits = await prisma.auditLog.findMany({
      where: {
        OR: [{ entityId: p.id }, { entityId: mainPointId }],
        userId: operatorId
      }
    });
    for (const a of audits) {
      const s = JSON.stringify(a);
      assert.equal(
        s.includes(raw),
        false,
        "rawToken must not appear in AuditLog"
      );
    }
    // And not in the participant row itself
    const pRow = await prisma.participant.findUnique({
      where: { id: p.id }
    });
    assert.equal(JSON.stringify(pRow).includes(raw), false);

    await cleanupFixture(p.id);
  });

  test("rawToken never appears anywhere on badge-failure paths either", async () => {
    const bogus = "Z".repeat(80);
    await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: bogus
    });
    // Look at every AuditLog by the operator for this AP recently.
    const recent = await prisma.auditLog.findMany({
      where: {
        userId: operatorId,
        action: "checkin.scan.qr",
        entity: "AccessPoint",
        entityId: mainPointId
      },
      orderBy: { createdAt: "desc" },
      take: 5
    });
    for (const a of recent) {
      const s = JSON.stringify(a);
      assert.equal(s.includes(bogus), false);
    }
  });

  test("ParticipantAccess is never mutated by validation", async () => {
    const p = await makeParticipant();
    await prisma.participantAccess.create({
      data: {
        participantId: p.id,
        accessPointId: mainPointId,
        granted: true,
        grantedById: operatorId
      }
    });
    const raw = await issueActive(p.id);
    const before = await prisma.participantAccess.findUnique({
      where: {
        participantId_accessPointId: {
          participantId: p.id,
          accessPointId: mainPointId
        }
      }
    });
    await validateMainEntranceQrCore({
      user: { id: operatorId },
      slug: "main",
      rawToken: raw
    });
    const after = await prisma.participantAccess.findUnique({
      where: {
        participantId_accessPointId: {
          participantId: p.id,
          accessPointId: mainPointId
        }
      }
    });
    assert.deepEqual(after, before);
    await cleanupFixture(p.id);
  });
});

// ─── Structural — legacy manual flow is not silently altered ────────────

describe("legacy manual flow — unrelated semantics unchanged", () => {
  const manualPath = new URL(
    "../app/admin/(protected)/check-in/actions.ts",
    import.meta.url
  );

  test("manual flow still uses checkin.validate permission", async () => {
    const src = await readFile(manualPath, "utf8");
    assert.ok(src.includes('requirePermission("checkin.validate")'));
  });

  test("manual flow still audits as `checkin.scan`, not `checkin.scan.qr`", async () => {
    const src = await readFile(manualPath, "utf8");
    assert.ok(
      src.includes('action: "checkin.scan"'),
      "manual flow must retain the legacy `checkin.scan` audit action"
    );
    assert.equal(
      src.includes('action: "checkin.scan.qr"'),
      false,
      "manual flow must not accidentally use the Phase 10 QR action name"
    );
  });

  test("manual flow does NOT consult ParticipantAccess", async () => {
    const src = await readFile(manualPath, "utf8");
    // The manual /admin/check-in flow uses `Participant.gate` matching
    // only. Phase 10's ParticipantAccess-based rule (B1) applies to
    // the QR path only.
    assert.equal(src.includes("participantAccess"), false);
  });

  test("manual flow uses the atomic updateMany claim (B3)", async () => {
    const src = await readFile(manualPath, "utf8");
    // The critical pattern: updateMany with `checkedInAt: null` in
    // the WHERE clause. The regex tolerates arbitrary key ordering
    // inside `where`.
    assert.ok(
      /participant\.updateMany\(\s*\{[\s\S]*?where\s*:\s*\{[\s\S]*?checkedInAt\s*:\s*null/.test(
        src
      ),
      "manual flow must use `updateMany({ where: { ..., checkedInAt: null } })` (atomic claim)"
    );
    // And that the pre-atomic race-prone pattern is gone.
    assert.equal(
      /if\s*\(\s*participant\.checkedInAt\s*\)/.test(src),
      false,
      "the earlier read-then-update guard must be removed"
    );
  });
});

// ─── Structural — Phase 10 code discipline ──────────────────────────────

describe("Phase 10 code discipline", () => {
  const validatorPath = new URL(
    "../lib/admin/main-entrance-validator.ts",
    import.meta.url
  );
  const actionPath = new URL(
    "../app/admin/(protected)/scan/[access-point-slug]/actions.ts",
    import.meta.url
  );

  test("server action requires access.validate.main strictly", async () => {
    const src = await readFile(actionPath, "utf8");
    assert.ok(
      src.includes('requirePermission("access.validate.main")'),
      "action must open with the strict access.validate.main gate"
    );
    // Legacy permission MUST NOT appear
    assert.equal(
      src.includes('"checkin.validate"'),
      false,
      "checkin.validate must not authorize the QR scanner action"
    );
    // The OR-fallback helper must not be used here either
    assert.equal(
      src.includes("canValidateMainEntrance"),
      false,
      "canValidateMainEntrance (OR-fallback helper) must not appear"
    );
  });

  test("validator core writes AuditLog with action=checkin.scan.qr only", async () => {
    const src = await readFile(validatorPath, "utf8");
    assert.ok(
      src.includes('action: "checkin.scan.qr"'),
      "validator must emit `checkin.scan.qr` audits"
    );
    assert.equal(
      src.match(/action:\s*"checkin\.scan"/g)?.length ?? 0,
      0,
      "validator must never emit the legacy `checkin.scan` action"
    );
  });

  test("validator uses updateMany atomic claim on Participant", async () => {
    const src = await readFile(validatorPath, "utf8");
    assert.ok(
      /participant\.updateMany\(\s*\{[\s\S]*?where\s*:\s*\{[\s\S]*?checkedInAt\s*:\s*null/.test(
        src
      )
    );
  });

  test("validator never assigns rawToken into any Prisma field", async () => {
    const src = await readFile(validatorPath, "utf8");
    // Positive: ticketCode is either forwarded through the helper's
    // `args.ticketCode` or built from `participant.ticketCode ?? ""`.
    assert.ok(
      /ticketCode:\s*(?:args\.ticketCode|participant\.ticketCode\s*\?\?\s*"")/.test(
        src
      )
    );
    // Negative: `<anyKey>: rawToken` — the specific shape that would
    // occur if a future edit accidentally piped rawToken into a
    // Prisma `data:` field, an object literal, or an audit meta.
    assert.equal(
      /:\s*rawToken\b/.test(src),
      false,
      "rawToken must never be assigned as an object-literal value"
    );
    // Negative: rawToken must only ever be either destructured or
    // passed as an argument. Any assignment shape (`obj.k = rawToken`
    // or a JSON.stringify sink) would flag here. `=` followed by
    // rawToken indicates assignment; only the destructure literal
    // `{ user, slug, rawToken }` and the type declaration
    // `rawToken: string;` are permitted.
    assert.equal(
      /=\s*rawToken\b/.test(src),
      false,
      "rawToken must never be assigned to a variable / field"
    );
  });
});

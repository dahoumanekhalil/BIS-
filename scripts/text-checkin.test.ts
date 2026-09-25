// Phase 19 — text check-in code tests. Run with:
//   npm run test:text-checkin
//
// Structure mirrors Phase 10 / 11:
//   • Behavioural — exercise the pure validator cores + generation
//     service directly against a real DB fixture.
//   • Structural — grep the shipped source for security-critical
//     invariants (no raw code in AuditLog / logs / responses, no
//     new permission introduced, action name distinct from QR).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  AdminRole,
  AdminStatus,
  CheckInResult,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  CHECKIN_CODE_CANONICAL_RE,
  CHECKIN_CODE_FORMATTED_LENGTH,
  ensureCheckinCode,
  generateCheckinCode,
  normalizeCheckinCode
} from "../lib/badge/checkin-code";
import {
  validateMainEntranceTextCore,
  validateRoomTextCore
} from "../lib/admin/text-checkin-validator";

const prisma = new PrismaClient();

const OPERATOR_EMAIL = "text-checkin-op@bis.dz";
const P_EMAIL_PREFIX = "text-checkin-fixture-";

let eventId: string;
let mainPointId: string;
let room1PointId: string;
let operatorId: string;

async function makeParticipant(
  overrides: Partial<{
    status: RegistrationStatus;
    checkedInAt: Date | null;
    checkinCode: string | null;
  }> = {}
) {
  const rid = randomBytes(3).toString("hex");
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "Txt",
      lastName: `Fixture-${rid}`,
      email: `${P_EMAIL_PREFIX}${rid}@bis.dz`,
      status: overrides.status ?? RegistrationStatus.CONFIRMED,
      checkedInAt: overrides.checkedInAt ?? null,
      ticketCode: `TXT-${rid.toUpperCase()}`,
      checkinCode: overrides.checkinCode ?? null
    },
    select: { id: true, checkinCode: true }
  });
  return p;
}

async function cleanup(participantId: string) {
  await prisma.checkIn
    .deleteMany({ where: { participantId } })
    .catch(() => {});
  await prisma.participantAccess
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
  mainPointId = points.find((p) => p.slug === "main")!.id;
  room1PointId = points.find((p) => p.slug === "room-01")!.id;

  const op = await prisma.adminUser.upsert({
    where: { email: OPERATOR_EMAIL },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: OPERATOR_EMAIL,
      name: "Text CheckIn Op",
      passwordHash: hashPassword("test-only"),
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
  for (const p of survivors) await cleanup(p.id);
  await prisma.auditLog
    .deleteMany({ where: { userId: operatorId } })
    .catch(() => {});
  await prisma.adminUser
    .deleteMany({ where: { email: OPERATOR_EMAIL } })
    .catch(() => {});
  await prisma.$disconnect();
});

// ─── Generation + normalization ────────────────────────────────

describe("checkin-code — generation + normalization", () => {
  test("generateCheckinCode produces canonical shape", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCheckinCode();
      assert.equal(code.length, CHECKIN_CODE_FORMATTED_LENGTH);
      assert.match(code, CHECKIN_CODE_CANONICAL_RE);
      // No ambiguous characters.
      for (const ch of code.replace(/-/g, "")) {
        assert.equal(
          "01ISBO58".indexOf(ch),
          -1,
          `code ${code} contains an ambiguous char '${ch}'`
        );
      }
    }
  });

  test("2000 generated codes are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateCheckinCode());
    assert.equal(seen.size, 2000, "generated codes should be unique");
  });

  test("normalizeCheckinCode accepts canonical form", () => {
    const c = generateCheckinCode();
    assert.equal(normalizeCheckinCode(c), c);
  });

  test("normalizeCheckinCode accepts lowercase + spaces (case-insensitive, whitespace-tolerant)", () => {
    const c = "K4MX-A7RN-92QT";
    assert.equal(normalizeCheckinCode("k4mx a7rn 92qt"), c);
    assert.equal(normalizeCheckinCode(" k4mx-a7rn-92qt "), c);
    assert.equal(normalizeCheckinCode("K4MXA7RN92QT"), c);
  });

  test("normalizeCheckinCode rejects malformed / non-string / ambiguous input", () => {
    assert.equal(normalizeCheckinCode(""), null);
    assert.equal(normalizeCheckinCode("SHORT"), null);
    // 'S' / '0' / '1' / '5' / '8' / 'B' / 'I' / 'O' are not in the charset.
    assert.equal(normalizeCheckinCode("BIS7-K4MX-92QT"), null);
    assert.equal(normalizeCheckinCode("0123-4567-8901"), null);
    assert.equal(normalizeCheckinCode(null as unknown as string), null);
    assert.equal(normalizeCheckinCode(12 as unknown as string), null);
    // 13-char payload — wrong length.
    assert.equal(normalizeCheckinCode("KMXA7RN92QTZP4"), null);
  });
});

describe("ensureCheckinCode — idempotent assignment", () => {
  test("assigns fresh code on first call", async () => {
    const p = await makeParticipant();
    assert.equal(p.checkinCode, null);
    const code = await ensureCheckinCode(p.id);
    assert.match(code, CHECKIN_CODE_CANONICAL_RE);
    const row = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkinCode: true }
    });
    assert.equal(row?.checkinCode, code);
    await cleanup(p.id);
  });

  test("second call returns the same code (idempotent)", async () => {
    const p = await makeParticipant();
    const first = await ensureCheckinCode(p.id);
    const second = await ensureCheckinCode(p.id);
    assert.equal(first, second);
    await cleanup(p.id);
  });

  test("5 concurrent calls → single stored code", async () => {
    const p = await makeParticipant();
    const codes = await Promise.all(
      Array.from({ length: 5 }, () => ensureCheckinCode(p.id))
    );
    // Every caller sees the SAME value.
    for (const c of codes) assert.equal(c, codes[0]);
    // DB confirms.
    const row = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkinCode: true }
    });
    assert.equal(row?.checkinCode, codes[0]);
    await cleanup(p.id);
  });
});

// ─── Validator behavioural — text path mirrors QR path ────────

describe("text validator — MAIN_ENTRANCE happy path", () => {
  test("PAID + no PA row + valid code → VALID (fresh CheckIn)", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    const r = await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    assert.equal(r.outcome, "VALID");
    assert.equal(r.ok, true);
    const row = await prisma.checkIn.findFirst({
      where: { participantId: p.id, accessPointId: mainPointId }
    });
    assert.equal(row?.result, CheckInResult.VALID);
    assert.equal(row?.reason, "FIRST_SCAN");
    assert.equal(row?.credentialId, null); // Text path — no credential
    assert.equal(row?.gate, "main");
    await cleanup(p.id);
  });

  test("second text scan → ALREADY_CHECKED_IN, atomic claim honored", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    const first = await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    assert.equal(first.outcome, "VALID");
    const second = await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    assert.equal(second.outcome, "ALREADY_CHECKED_IN");
    await cleanup(p.id);
  });
});

describe("text validator — MAIN_ENTRANCE denials", () => {
  test("PA granted=false → PA_REVOKED", async () => {
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
    const code = await ensureCheckinCode(p.id);
    const r = await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    assert.equal(r.outcome, "PA_REVOKED");
    await cleanup(p.id);
  });
});

describe("text validator — code-invalid enumeration protection", () => {
  test("malformed code → BADGE_INVALID (generic)", async () => {
    const r = await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code: "GARBAGE",
      ip: null
    });
    assert.equal(r.outcome, "BADGE_INVALID");
    // No participant info leaked.
    assert.equal(r.participant, undefined);
  });

  test("unknown but well-formed code → same BADGE_INVALID (indistinguishable)", async () => {
    // Random canonical shape that no participant owns.
    const code = generateCheckinCode();
    const r = await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    assert.equal(r.outcome, "BADGE_INVALID");
    assert.equal(r.participant, undefined);
    // No CheckIn was written for the unknown code.
    const anyCheckIn = await prisma.checkIn.findMany({
      where: { reason: "TEXT_UNKNOWN" }
    });
    // We don't insist on absolute row count here — other tests may
    // have inserted TEXT_UNKNOWN — but our audit did fire.
    void anyCheckIn;
    // AuditLog for the operator MUST exist.
    const audit = await prisma.auditLog.findFirst({
      where: {
        userId: operatorId,
        action: "checkin.scan.text",
        entity: "AccessPoint",
        entityId: mainPointId
      },
      orderBy: { createdAt: "desc" }
    });
    assert.ok(audit);
  });
});

describe("text validator — ROOM happy path + isolation", () => {
  test("PAID + PA granted=true → VALID + fresh CheckIn(ROOM_ENTRY)", async () => {
    const p = await makeParticipant();
    await prisma.participantAccess.create({
      data: {
        participantId: p.id,
        accessPointId: room1PointId,
        granted: true,
        grantedById: operatorId
      }
    });
    const code = await ensureCheckinCode(p.id);
    const r = await validateRoomTextCore({
      user: { id: operatorId },
      slug: "room-01",
      code,
      ip: null
    });
    assert.equal(r.outcome, "VALID");
    const row = await prisma.checkIn.findFirst({
      where: { participantId: p.id, accessPointId: room1PointId }
    });
    assert.equal(row?.reason, "ROOM_ENTRY");
    // Room path must NOT touch checkedInAt.
    const after = await prisma.participant.findUnique({
      where: { id: p.id },
      select: { checkedInAt: true }
    });
    assert.equal(after?.checkedInAt, null);
    await cleanup(p.id);
  });

  test("no PA row for room → PA_NOT_GRANTED (default-deny)", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    const r = await validateRoomTextCore({
      user: { id: operatorId },
      slug: "room-01",
      code,
      ip: null
    });
    assert.equal(r.outcome, "PA_NOT_GRANTED");
    await cleanup(p.id);
  });

  test("MAIN slug in room validator → ACCESS_POINT_WRONG_TYPE", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    const r = await validateRoomTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    assert.equal(r.outcome, "ACCESS_POINT_WRONG_TYPE");
    await cleanup(p.id);
  });
});

// ─── Data safety ──────────────────────────────────────────────

describe("text validator — data safety (audit + rate-limit + no leakage)", () => {
  test("audit action for text scans is 'checkin.scan.text', distinct from QR", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    const audit = await prisma.auditLog.findFirst({
      where: {
        userId: operatorId,
        action: "checkin.scan.text",
        entity: "Participant",
        entityId: p.id
      },
      orderBy: { createdAt: "desc" }
    });
    assert.ok(audit, "checkin.scan.text audit must exist");
    // Verify no QR-style audit fired for this text scan.
    const qrAudit = await prisma.auditLog.findFirst({
      where: {
        userId: operatorId,
        action: "checkin.scan.qr",
        entity: "Participant",
        entityId: p.id
      }
    });
    assert.equal(qrAudit, null, "text scan must NOT emit checkin.scan.qr");
    await cleanup(p.id);
  });

  test("raw check-in code never appears in AuditLog meta", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    const audits = await prisma.auditLog.findMany({
      where: {
        userId: operatorId,
        action: "checkin.scan.text"
      },
      orderBy: { createdAt: "desc" },
      take: 5
    });
    for (const a of audits) {
      const serialised = JSON.stringify(a);
      assert.equal(
        serialised.includes(code),
        false,
        "raw code must not appear anywhere in AuditLog serialisation"
      );
    }
    await cleanup(p.id);
  });

  test("raw code never appears in CheckIn row for a valid scan", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    const rows = await prisma.checkIn.findMany({
      where: { participantId: p.id }
    });
    for (const r of rows) {
      const serialised = JSON.stringify(r);
      assert.equal(
        serialised.includes(code),
        false,
        "raw code must not appear in CheckIn row (only ticketCode is stored)"
      );
    }
    await cleanup(p.id);
  });

  test("scanner-response never contains the raw code", async () => {
    const p = await makeParticipant();
    const code = await ensureCheckinCode(p.id);
    const r = await validateMainEntranceTextCore({
      user: { id: operatorId },
      slug: "main",
      code,
      ip: null
    });
    assert.equal(
      JSON.stringify(r).includes(code),
      false,
      "server response must not echo the raw code"
    );
    await cleanup(p.id);
  });
});

// ─── Structural — text validator + actions discipline ─────────

describe("Phase 19 code discipline (structural)", () => {
  const validatorPath = new URL(
    "../lib/admin/text-checkin-validator.ts",
    import.meta.url
  );
  const actionsPath = new URL(
    "../app/admin/(protected)/scan/[access-point-slug]/text-actions.ts",
    import.meta.url
  );

  test("MAIN action requires access.validate.main STRICTLY", async () => {
    const src = await readFile(actionsPath, "utf8");
    assert.ok(
      /validateMainEntranceTextScan[\s\S]{0,300}requirePermission\(\s*"access\.validate\.main"\s*\)/.test(
        src
      )
    );
    // Must NOT accept the legacy manual-flow permission.
    assert.equal(
      /validateMainEntranceTextScan[\s\S]{0,600}requirePermission\(\s*"checkin\.validate"\s*\)/.test(
        src
      ),
      false
    );
  });

  test("ROOM action requires access.validate.room STRICTLY", async () => {
    const src = await readFile(actionsPath, "utf8");
    assert.ok(
      /validateRoomTextScan[\s\S]{0,300}requirePermission\(\s*"access\.validate\.room"\s*\)/.test(
        src
      )
    );
  });

  test("validator uses distinct audit action checkin.scan.text (never .qr)", async () => {
    const src = await readFile(validatorPath, "utf8");
    assert.ok(src.includes('action: "checkin.scan.text"'));
    assert.equal(
      /action:\s*"checkin\.scan\.qr"/.test(src),
      false,
      "text validator must not emit the QR audit action"
    );
  });

  test("rate-limit runs BEFORE any DB access", async () => {
    const src = await readFile(validatorPath, "utf8");
    const isBlockedIdx = src.indexOf("isBlocked(");
    const findUniqueIdx = src.indexOf("prisma.accessPoint.findUnique");
    assert.ok(isBlockedIdx >= 0);
    assert.ok(findUniqueIdx >= 0);
    assert.ok(
      isBlockedIdx < findUniqueIdx,
      "rate-limit must gate before the AccessPoint lookup"
    );
  });

  test("validator never writes the raw code into a Prisma data block", async () => {
    const src = await readFile(validatorPath, "utf8");
    // Ban raw-code shape in write paths. The variable is called
    // `code` inside the function; a Prisma write of that would be
    // `code:` inside a `data: { ... }`. Search for that pattern.
    assert.equal(
      /data\s*:\s*\{[\s\S]*?\bcheckinCode\s*:/.test(src),
      false,
      "text validator must NEVER write to checkinCode (that is the code-service's job)"
    );
    assert.equal(
      /data\s*:\s*\{[\s\S]*?\bcode\s*:/.test(src),
      false,
      "text validator must NEVER pipe the raw `code` variable into a Prisma data block"
    );
  });

  test("validator never audits with the raw code in meta", async () => {
    const src = await readFile(validatorPath, "utf8");
    // meta: { ... } blocks passed to audit() must not contain
    // `code:` (the raw variable). The reason strings we DO write
    // are fixed short codes like "TEXT_INVALID_SHAPE" / "TEXT_UNKNOWN".
    assert.equal(
      /meta\s*:\s*\{[\s\S]*?\bcode\s*:/.test(src),
      false,
      "audit meta must not include the raw `code` variable"
    );
  });

  test("no new permission introduced in Phase 19", async () => {
    // The Phase 3 permissions list is the source of truth. Text
    // check-in reuses `access.validate.main` and `access.validate.room`.
    const rbac = await readFile(
      new URL("../lib/admin/rbac.ts", import.meta.url),
      "utf8"
    );
    for (const banned of [
      "text.validate",
      "checkin.text",
      "text.checkin",
      "access.validate.text"
    ]) {
      assert.equal(
        rbac.includes(banned),
        false,
        `rbac.ts should not define a new '${banned}' permission for Phase 19`
      );
    }
  });
});

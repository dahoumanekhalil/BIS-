// Focused tests for lib/badge/service.ts. Run with:
//   npx tsx --test scripts/badge-credential.test.ts
//
// Uses node's built-in test runner (no framework dependency) and the LOCAL
// Postgres already used by the app. Every test creates its own Participant
// under a distinctive email prefix and cleans it up in afterEach — the
// cascade removes any BadgeCredential rows it created.
//
// If a run is interrupted, stragglers can be swept with:
//   DELETE FROM "Participant" WHERE email LIKE 'badge-test-%';

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AdminRole,
  AdminStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";

import {
  BadgeError,
  issueBadgeCredential,
  revokeBadgeCredential,
  rotateBadgeCredential,
  verifyBadgeToken
} from "../lib/badge";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

// ─── Fixtures ─────────────────────────────────────────────────────────────

let eventId: string;
let adminId: string;
let participantId: string;

before(async () => {
  let event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (!event) {
    event = await prisma.event.create({
      data: {
        slug: `badge-test-event-${Date.now()}`,
        name: "Badge Test Event",
        startsAt: new Date("2017-01-03T08:00:00Z"),
        endsAt: new Date("2017-01-05T18:00:00Z"),
        city: "Alger",
        venue: "Test",
        country: "DZ"
      }
    });
  }
  eventId = event.id;

  const admin = await prisma.adminUser.upsert({
    where: { email: "badge-test-admin@bis.dz" },
    update: {},
    create: {
      email: "badge-test-admin@bis.dz",
      name: "Badge Test Admin",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE
    }
  });
  adminId = admin.id;
});

beforeEach(async () => {
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "Test",
      lastName: "Participant",
      email: `badge-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@bis.dz`,
      status: RegistrationStatus.CONFIRMED
    }
  });
  participantId = p.id;
});

after(async () => {
  // Sweep any test-created participants (belt-and-braces if afterEach was
  // skipped by a crashed test). Cascade wipes credentials and permissions.
  await prisma.participant.deleteMany({
    where: { email: { startsWith: "badge-test-" } }
  });
  // Also remove the throwaway test admin. Leaving a SUPER_ADMIN row with a
  // known-plaintext password in the DB is fine on a local dev machine, but
  // it becomes a real credential the moment someone clones this DB to
  // staging — so we clean it up.
  await prisma.adminUser.deleteMany({
    where: { email: "badge-test-admin@bis.dz" }
  });
  await prisma.$disconnect();
});

// ─── issue ────────────────────────────────────────────────────────────────

describe("issueBadgeCredential", () => {
  test("creates an ACTIVE credential and returns a raw token", async () => {
    const { credentialId, rawToken } = await issueBadgeCredential(participantId);
    assert.ok(credentialId, "credentialId is present");
    assert.ok(rawToken.length >= 40, "rawToken has expected length");
    const row = await prisma.badgeCredential.findUnique({
      where: { id: credentialId }
    });
    assert.equal(row?.status, "ACTIVE");
    assert.equal(row?.participantId, participantId);
    assert.equal(row?.rotatedFromId, null);
  });

  test("raw token is NEVER stored in the DB row", async () => {
    const { credentialId, rawToken } = await issueBadgeCredential(participantId);
    const row = await prisma.badgeCredential.findUnique({
      where: { id: credentialId }
    });
    assert.ok(row);
    assert.notEqual(row!.tokenHash, rawToken);
    const serialized = JSON.stringify(row);
    assert.equal(
      serialized.includes(rawToken),
      false,
      "raw token must not appear anywhere in the credential row"
    );
  });

  test("stored tokenHash equals sha256(rawToken) in hex", async () => {
    const { credentialId, rawToken } = await issueBadgeCredential(participantId);
    const expected = createHash("sha256")
      .update(rawToken, "utf8")
      .digest("hex");
    const row = await prisma.badgeCredential.findUnique({
      where: { id: credentialId }
    });
    assert.equal(row?.tokenHash, expected);
  });

  test("throws PARTICIPANT_NOT_FOUND for an unknown participant id", async () => {
    await assert.rejects(
      () => issueBadgeCredential("no-such-participant"),
      (err: unknown) =>
        err instanceof BadgeError && err.code === "PARTICIPANT_NOT_FOUND"
    );
  });

  test("throws ACTIVE_EXISTS on a second issue for the same participant", async () => {
    await issueBadgeCredential(participantId);
    await assert.rejects(
      () => issueBadgeCredential(participantId),
      (err: unknown) =>
        err instanceof BadgeError && err.code === "ACTIVE_EXISTS"
    );
  });
});

// ─── verify ───────────────────────────────────────────────────────────────

describe("verifyBadgeToken", () => {
  test("succeeds with the correct token", async () => {
    const { credentialId, rawToken } =
      await issueBadgeCredential(participantId);
    const r = await verifyBadgeToken(rawToken);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.credentialId, credentialId);
      assert.equal(r.participantId, participantId);
    }
  });

  test("returns INVALID for a well-formed but unknown token", async () => {
    const r = await verifyBadgeToken(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "INVALID");
  });

  test("returns INVALID for an obviously short / bogus token", async () => {
    const r1 = await verifyBadgeToken("short");
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.reason, "INVALID");
    // Non-string input as well.
    const r2 = await verifyBadgeToken(undefined);
    assert.equal(r2.ok, false);
    const r3 = await verifyBadgeToken({ nope: true });
    assert.equal(r3.ok, false);
  });

  test("returns REVOKED for a revoked credential", async () => {
    const { credentialId, rawToken } =
      await issueBadgeCredential(participantId);
    await revokeBadgeCredential(credentialId);
    const r = await verifyBadgeToken(rawToken);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "REVOKED");
  });

  test("returns EXPIRED when expiresAt is in the past", async () => {
    const past = new Date(Date.now() - 60_000);
    const { rawToken } = await issueBadgeCredential(participantId, {
      expiresAt: past
    });
    const r = await verifyBadgeToken(rawToken);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "EXPIRED");
  });

  test("returns PARTICIPANT_CANCELLED when the participant is CANCELLED", async () => {
    const { rawToken } = await issueBadgeCredential(participantId);
    await prisma.participant.update({
      where: { id: participantId },
      data: { status: RegistrationStatus.CANCELLED }
    });
    const r = await verifyBadgeToken(rawToken);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "PARTICIPANT_CANCELLED");
  });
});

// ─── revoke ───────────────────────────────────────────────────────────────

describe("revokeBadgeCredential", () => {
  test("marks the credential REVOKED and stamps revocation metadata", async () => {
    const { credentialId } = await issueBadgeCredential(participantId);
    const r = await revokeBadgeCredential(credentialId, adminId, "test-reason");
    assert.equal(r.status, "REVOKED");
    const row = await prisma.badgeCredential.findUnique({
      where: { id: credentialId }
    });
    assert.equal(row?.status, "REVOKED");
    assert.equal(row?.revokedById, adminId);
    assert.equal(row?.revokedReason, "test-reason");
    assert.ok(row?.revokedAt);
  });

  test("is idempotent — second revoke returns NOOP without mutation", async () => {
    const { credentialId } = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(credentialId, adminId, "first");
    const before = await prisma.badgeCredential.findUnique({
      where: { id: credentialId }
    });
    const r2 = await revokeBadgeCredential(credentialId, adminId, "second");
    assert.equal(r2.status, "NOOP");
    const after = await prisma.badgeCredential.findUnique({
      where: { id: credentialId }
    });
    // Reason/timestamp preserved from first revoke.
    assert.equal(after?.revokedReason, before?.revokedReason);
    assert.equal(
      after?.revokedAt?.getTime(),
      before?.revokedAt?.getTime()
    );
  });

  test("throws ADMIN_NOT_FOUND when revokedById does not resolve", async () => {
    const { credentialId } = await issueBadgeCredential(participantId);
    await assert.rejects(
      () => revokeBadgeCredential(credentialId, "no-such-admin", "x"),
      (err: unknown) =>
        err instanceof BadgeError && err.code === "ADMIN_NOT_FOUND"
    );
  });

  test("throws CREDENTIAL_NOT_FOUND on an unknown credential id", async () => {
    await assert.rejects(
      () => revokeBadgeCredential("no-such-credential"),
      (err: unknown) =>
        err instanceof BadgeError && err.code === "CREDENTIAL_NOT_FOUND"
    );
  });
});

// ─── rotate ───────────────────────────────────────────────────────────────

describe("rotateBadgeCredential", () => {
  test("revokes the previous ACTIVE, creates a new ACTIVE, and chains rotatedFromId", async () => {
    const first = await issueBadgeCredential(participantId);
    const second = await rotateBadgeCredential(
      participantId,
      adminId,
      "renewal"
    );

    const oldRow = await prisma.badgeCredential.findUnique({
      where: { id: first.credentialId }
    });
    assert.equal(oldRow?.status, "REVOKED");
    assert.equal(oldRow?.revokedReason, "renewal");
    assert.equal(oldRow?.revokedById, adminId);

    const newRow = await prisma.badgeCredential.findUnique({
      where: { id: second.credentialId }
    });
    assert.equal(newRow?.status, "ACTIVE");
    assert.equal(newRow?.rotatedFromId, first.credentialId);
    assert.equal(second.previousCredentialId, first.credentialId);
    assert.notEqual(first.rawToken, second.rawToken);
  });

  test("verifies the new token and rejects the old one after rotation", async () => {
    const first = await issueBadgeCredential(participantId);
    const second = await rotateBadgeCredential(participantId);

    const oldR = await verifyBadgeToken(first.rawToken);
    assert.equal(oldR.ok, false);
    if (!oldR.ok) assert.equal(oldR.reason, "REVOKED");

    const newR = await verifyBadgeToken(second.rawToken);
    assert.equal(newR.ok, true);
  });

  test("rotate with no prior credential behaves like issue and sets previousCredentialId=null", async () => {
    const r = await rotateBadgeCredential(participantId);
    assert.equal(r.previousCredentialId, null);
    const row = await prisma.badgeCredential.findUnique({
      where: { id: r.credentialId }
    });
    assert.equal(row?.status, "ACTIVE");
    assert.equal(row?.rotatedFromId, null);
  });

  test("throws PARTICIPANT_NOT_FOUND for an unknown participant", async () => {
    await assert.rejects(
      () => rotateBadgeCredential("no-such-participant"),
      (err: unknown) =>
        err instanceof BadgeError && err.code === "PARTICIPANT_NOT_FOUND"
    );
  });

  test("throws ADMIN_NOT_FOUND when revokedById does not resolve", async () => {
    await issueBadgeCredential(participantId);
    await assert.rejects(
      () => rotateBadgeCredential(participantId, "no-such-admin", "x"),
      (err: unknown) =>
        err instanceof BadgeError && err.code === "ADMIN_NOT_FOUND"
    );
  });
});

// ─── DB-level defence in depth ────────────────────────────────────────────

describe("partial unique index (DB-level guarantee)", () => {
  test("direct insert of a second ACTIVE credential is rejected by Postgres", async () => {
    await issueBadgeCredential(participantId);
    // Bypass the service layer entirely — try to slip a second ACTIVE past
    // the transaction precheck. The partial unique index must stop it.
    await assert.rejects(
      () =>
        prisma.badgeCredential.create({
          data: {
            participantId,
            tokenHash: createHash("sha256")
              .update(`bogus-${Math.random()}`)
              .digest("hex"),
            status: "ACTIVE"
          }
        }),
      /Unique constraint|already exists|P2002/i
    );
  });

  test("multiple REVOKED credentials per participant are permitted (history)", async () => {
    const first = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(first.credentialId);
    const second = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(second.credentialId);
    const rows = await prisma.badgeCredential.findMany({
      where: { participantId, status: "REVOKED" }
    });
    assert.equal(rows.length, 2, "both revoked rows persist as history");
  });
});

// ─── Audit trail ──────────────────────────────────────────────────────────

describe("AuditLog integration", () => {
  test("issue writes badge.issue with credentialId metadata", async () => {
    const { credentialId } = await issueBadgeCredential(participantId);
    const log = await prisma.auditLog.findFirst({
      where: { action: "badge.issue", entityId: participantId },
      orderBy: { createdAt: "desc" }
    });
    assert.ok(log);
    const meta = log?.meta as { credentialId?: string } | null;
    assert.equal(meta?.credentialId, credentialId);
  });

  test("revoke writes badge.revoke with userId + reason", async () => {
    const { credentialId } = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(credentialId, adminId, "audit-test");
    const log = await prisma.auditLog.findFirst({
      where: { action: "badge.revoke", entityId: participantId },
      orderBy: { createdAt: "desc" }
    });
    assert.ok(log);
    assert.equal(log?.userId, adminId);
    const meta = log?.meta as { reason?: string } | null;
    assert.equal(meta?.reason, "audit-test");
  });

  test("rotate writes badge.rotate with both credential ids", async () => {
    const first = await issueBadgeCredential(participantId);
    const second = await rotateBadgeCredential(
      participantId,
      adminId,
      "audit-rotate"
    );
    const log = await prisma.auditLog.findFirst({
      where: { action: "badge.rotate", entityId: participantId },
      orderBy: { createdAt: "desc" }
    });
    assert.ok(log);
    const meta = log?.meta as {
      newCredentialId?: string;
      previousCredentialId?: string | null;
    } | null;
    assert.equal(meta?.newCredentialId, second.credentialId);
    assert.equal(meta?.previousCredentialId, first.credentialId);
  });

  test("idempotent revoke does NOT double-audit", async () => {
    const { credentialId } = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(credentialId);
    const first = await prisma.auditLog.count({
      where: { action: "badge.revoke", entityId: participantId }
    });
    await revokeBadgeCredential(credentialId);
    const second = await prisma.auditLog.count({
      where: { action: "badge.revoke", entityId: participantId }
    });
    assert.equal(first, second, "NOOP revoke must not emit a new audit row");
  });
});

// ─── Logging discipline ───────────────────────────────────────────────────

describe("logging discipline", () => {
  test("raw token does not appear in a BadgeError's message or stringify", async () => {
    const { rawToken } = await issueBadgeCredential(participantId);
    try {
      await issueBadgeCredential(participantId);
      assert.fail("expected ACTIVE_EXISTS");
    } catch (err) {
      const s = JSON.stringify({
        name: (err as Error).name,
        code: (err as BadgeError).code,
        message: (err as Error).message,
        stringified: `${err}`,
        stack: (err as Error).stack ?? ""
      });
      assert.equal(
        s.includes(rawToken),
        false,
        "raw token must never appear in error output"
      );
    }
  });

  test("AuditLog rows do not contain the raw token", async () => {
    const { rawToken, credentialId } =
      await issueBadgeCredential(participantId);
    await revokeBadgeCredential(credentialId, adminId, rawToken);
    // Even if a caller mistakenly puts the raw token in `reason`, the audit
    // row will contain what the caller sent — this test verifies that the
    // SERVICE itself never places the raw token into an audit row.
    const logs = await prisma.auditLog.findMany({
      where: { entityId: participantId, action: { startsWith: "badge." } }
    });
    for (const l of logs) {
      // Only inspect the metadata the SERVICE controls (credentialId + null
      // reason from the issue call). We deliberately excluded the revoke
      // reason (caller-controlled) from this assertion.
      const meta = (l.meta ?? {}) as Record<string, unknown>;
      const svcMeta = {
        credentialId: meta.credentialId,
        newCredentialId: meta.newCredentialId,
        previousCredentialId: meta.previousCredentialId
      };
      assert.equal(
        JSON.stringify(svcMeta).includes(rawToken),
        false,
        "service-controlled audit metadata must never contain the raw token"
      );
    }
  });
});

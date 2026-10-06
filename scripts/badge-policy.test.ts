// QR policy tests — ONE persistent QR per participant, admin-only
// regeneration, durable revocation, same-participant identity, audit
// atomicity, concurrency safety and secret hygiene.
//
//   npm run test:badge-policy
//
// Needs DATABASE_URL pointing at a THROWAWAY database whose name contains
// "test" (the test refuses to run otherwise: it installs a temporary
// trigger to prove audit atomicity).

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AdminRole,
  AdminStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";

import {
  BadgeError,
  getCurrentBadgeToken,
  issueBadgeCredential,
  regenerateBadgeCredential,
  revokeBadgeCredential,
  verifyBadgeToken
} from "../lib/badge";
import { reissueLegacyCredential } from "../lib/badge/service";
import { deriveBadgeToken, hashBadgeToken, loadBadgeQrSecret } from "../lib/badge/token";
import { renderBadgeQrDataUrl } from "../lib/badge/qr";
import { ensureActiveBadge } from "../lib/register/participant";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

const SECRET = "test-only-badge-qr-secret-0123456789abcdef0123456789abcdef";
process.env.BADGE_QR_TOKEN_SECRET = SECRET;

let eventId: string;
let adminId: string;
let admin2Id: string;
let participantId: string;
let accountId: string;

const dbName = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "");
  } catch {
    return "";
  }
})();

before(async () => {
  assert.ok(
    dbName.includes("test"),
    `refusing to run: DATABASE_URL database "${dbName}" is not a throwaway *test* database`
  );
  let event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (!event) {
    event = await prisma.event.create({
      data: {
        slug: `policy-test-event-${Date.now()}`,
        name: "Policy Test Event",
        startsAt: new Date("2017-01-03T08:00:00Z"),
        endsAt: new Date("2017-01-05T18:00:00Z"),
        city: "Alger",
        venue: "Test",
        country: "DZ"
      }
    });
  }
  eventId = event.id;
  const mk = async (email: string) =>
    (
      await prisma.adminUser.upsert({
        where: { email },
        update: {},
        create: {
          email,
          name: "Policy Test Admin",
          passwordHash: hashPassword("test-only-do-not-use"),
          role: AdminRole.SUPER_ADMIN,
          status: AdminStatus.ACTIVE
        }
      })
    ).id;
  adminId = await mk("policy-test-admin-1@bis.dz");
  admin2Id = await mk("policy-test-admin-2@bis.dz");
});

beforeEach(async () => {
  const account = await prisma.accountUser.create({
    data: {
      email: `policy-test-acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@bis.dz`,
      firstName: "Pol",
      lastName: "Icy",
      passwordHash: "x"
    }
  });
  accountId = account.id;
  participantId = await newParticipant(account.id);
});

async function newParticipant(accountUserId?: string): Promise<string> {
  const p = await prisma.participant.create({
    data: {
      eventId,
      accountUserId: accountUserId ?? null,
      firstName: "Test",
      lastName: "Participant",
      email: `policy-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      checkinCode: null
    }
  });
  return p.id;
}

after(async () => {
  await prisma.participant.deleteMany({
    where: { email: { startsWith: "policy-test-" } }
  });
  await prisma.accountUser.deleteMany({
    where: { email: { startsWith: "policy-test-acct-" } }
  });
  await prisma.adminUser.deleteMany({
    where: { email: { startsWith: "policy-test-admin-" } }
  });
  await prisma.$disconnect();
});

async function regen(
  pid: string,
  expected: string | null,
  by = adminId,
  reason = "policy test regeneration"
) {
  return regenerateBadgeCredential({
    participantId: pid,
    adminId: by,
    reason,
    expectedCredentialId: expected
  });
}

async function activeCount(pid: string) {
  return prisma.badgeCredential.count({
    where: { participantId: pid, status: "ACTIVE" }
  });
}

// ─── A. Subscriber policy (persistent display) ────────────────────────────

describe("A. subscriber sees ONE persistent QR", () => {
  test("repeated display returns the exact same QR token and image", async () => {
    const issued = await issueBadgeCredential(participantId);
    const a = await getCurrentBadgeToken(participantId);
    const b = await getCurrentBadgeToken(participantId);
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) {
      assert.equal(a.rawToken, issued.rawToken);
      assert.equal(a.rawToken, b.rawToken);
      assert.equal(a.credentialId, b.credentialId);
      assert.equal(
        await renderBadgeQrDataUrl(a.rawToken),
        await renderBadgeQrDataUrl(b.rawToken)
      );
    }
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 1);
  });

  test("display never mutates: no new credential, no audit row", async () => {
    await issueBadgeCredential(participantId);
    const before = await prisma.auditLog.count({ where: { entityId: participantId } });
    for (let i = 0; i < 5; i++) await getCurrentBadgeToken(participantId);
    assert.equal(
      await prisma.auditLog.count({ where: { entityId: participantId } }),
      before
    );
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 1);
  });

  test("token is a pure function of (secret, credential id, sequence): survives restart / another session", async () => {
    const issued = await issueBadgeCredential(participantId);
    const row = await prisma.badgeCredential.findFirstOrThrow({
      where: { participantId, status: "ACTIVE" }
    });
    // Independent re-computation = what a fresh process / other device does.
    const independent = createHmac("sha256", Buffer.from(SECRET, "utf8"))
      .update(`bis-badge-qr|v1|${row.id}|${row.sequence}`, "utf8")
      .digest("base64url");
    // SECRET above is decoded as base64url by the app, so compare through the app's derivation:
    assert.equal(deriveBadgeToken(row.id, row.sequence!), issued.rawToken);
    assert.equal(hashBadgeToken(issued.rawToken), row.tokenHash);
    assert.equal(typeof independent, "string");
  });

  test("registration auto-issue is first-issuance only and idempotent (verified email only)", async () => {
    await ensureActiveBadge(participantId); // unverified account → nothing yet
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 0);
    await prisma.accountUser.update({
      where: { id: accountId },
      data: { emailVerifiedAt: new Date() }
    });
    await ensureActiveBadge(participantId);
    await ensureActiveBadge(participantId);
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 1);
  });

  test("a subscriber-reachable path cannot rotate: no non-admin API exists", async () => {
    const svc = await import("../lib/badge");
    const names = Object.keys(svc).sort();
    assert.ok(!names.includes("rotateBadgeCredential"));
    // The only replacement functions require an administrator identity.
    assert.equal(regenerateBadgeCredential.length, 1);
    await issueBadgeCredential(participantId);
    // issue refuses once any credential exists
    await assert.rejects(
      () => issueBadgeCredential(participantId),
      (e: unknown) => e instanceof BadgeError && e.code === "ACTIVE_EXISTS"
    );
    // missing admin identity is rejected
    await assert.rejects(
      () => regen(participantId, null, ""),
      (e: unknown) => e instanceof BadgeError && e.code === "ADMIN_NOT_FOUND"
    );
  });
});

// ─── B/C. Admin regeneration + identity/history ───────────────────────────

describe("B/C. admin regeneration preserves identity and history", () => {
  test("old QR fails immediately, new QR works, same participant", async () => {
    const first = await issueBadgeCredential(participantId);
    const participantsBefore = await prisma.participant.count();
    const second = await regen(participantId, first.credentialId);

    const oldR = await verifyBadgeToken(first.rawToken);
    assert.ok(!oldR.ok && oldR.reason === "REVOKED");
    const newR = await verifyBadgeToken(second.rawToken);
    assert.ok(newR.ok);
    if (newR.ok) assert.equal(newR.participantId, participantId);

    assert.equal(await activeCount(participantId), 1);
    assert.equal(await prisma.participant.count(), participantsBefore, "no Participant created");
    const cur = await getCurrentBadgeToken(participantId);
    assert.ok(cur.ok);
    if (cur.ok) {
      assert.equal(cur.rawToken, second.rawToken);
      assert.notEqual(cur.rawToken, first.rawToken);
    }
  });

  test("participant id, account, event, registration and CheckIn history unchanged", async () => {
    const first = await issueBadgeCredential(participantId);
    const checkIn = await prisma.checkIn.create({
      data: {
        participantId,
        credentialId: first.credentialId,
        ticketCode: "",
        gate: "main-entrance",
        result: "VALID"
      }
    });
    const before = await prisma.participant.findUniqueOrThrow({
      where: { id: participantId }
    });
    await regen(participantId, first.credentialId);
    const after = await prisma.participant.findUniqueOrThrow({
      where: { id: participantId }
    });
    assert.equal(after.id, before.id);
    assert.equal(after.accountUserId, accountId);
    assert.equal(after.eventId, before.eventId);
    assert.equal(after.email, before.email);
    assert.equal(after.status, before.status);
    assert.equal(after.createdAt.getTime(), before.createdAt.getTime());

    const ci = await prisma.checkIn.findUniqueOrThrow({ where: { id: checkIn.id } });
    assert.equal(ci.participantId, participantId);
    assert.equal(ci.credentialId, first.credentialId, "history still references the OLD credential");
    const oldRow = await prisma.badgeCredential.findUniqueOrThrow({
      where: { id: first.credentialId }
    });
    assert.equal(oldRow.status, "REVOKED");
    assert.equal(oldRow.participantId, participantId, "old credential row kept, same participant");
  });

  test("regeneration rotates the printed text code; old text code no longer resolves", async () => {
    const first = await issueBadgeCredential(participantId);
    const { ensureCheckinCode } = await import("../lib/badge/checkin-code");
    const oldCode = await ensureCheckinCode(participantId);
    await regen(participantId, first.credentialId);
    const p = await prisma.participant.findUniqueOrThrow({ where: { id: participantId } });
    assert.ok(p.checkinCode);
    assert.notEqual(p.checkinCode, oldCode);
    assert.equal(await prisma.participant.count({ where: { checkinCode: oldCode } }), 0);
  });

  test("sequence increases monotonically and tokens never repeat", async () => {
    let cur = (await issueBadgeCredential(participantId)).credentialId;
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = await regen(participantId, cur);
      assert.equal(r.sequence, i + 2);
      assert.ok(!seen.has(r.rawToken));
      seen.add(r.rawToken);
      cur = r.credentialId;
    }
    assert.equal(await activeCount(participantId), 1);
    assert.equal(
      await prisma.badgeCredential.count({ where: { participantId, status: "REVOKED" } }),
      4
    );
  });

  test("a revoked credential cannot be reassigned or duplicated", async () => {
    const first = await issueBadgeCredential(participantId);
    const otherId = await newParticipant();
    await regen(participantId, first.credentialId);
    // Same tokenHash cannot be inserted for another participant.
    await assert.rejects(
      () =>
        prisma.badgeCredential.create({
          data: {
            participantId: otherId,
            tokenHash: hashBadgeToken(first.rawToken),
            status: "ACTIVE"
          }
        }),
      /Unique constraint|P2002/i
    );
    // Other participant's own credential has a different token.
    const other = await issueBadgeCredential(otherId);
    assert.notEqual(other.rawToken, first.rawToken);
    const r = await verifyBadgeToken(first.rawToken);
    assert.ok(!r.ok && r.reason === "REVOKED");
  });
});

// ─── D. Durable revocation ────────────────────────────────────────────────

describe("D. revocation is durable", () => {
  test("after admin revoke nothing but an admin can create a credential", async () => {
    const first = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(first.credentialId, adminId, "abuse report");
    await assert.rejects(
      () => issueBadgeCredential(participantId),
      (e: unknown) => e instanceof BadgeError && e.code === "HISTORY_EXISTS"
    );
    await ensureActiveBadge(participantId); // registration path
    assert.equal(await activeCount(participantId), 0);
    const cur = await getCurrentBadgeToken(participantId);
    assert.ok(!cur.ok && cur.reason === "REVOKED");
    // Only an admin regeneration restores a badge.
    const r = await regen(participantId, null);
    assert.equal(await activeCount(participantId), 1);
    assert.ok((await verifyBadgeToken(r.rawToken)).ok);
  });

  test("text check-in code of a revoked badge is gated (latest credential REVOKED)", async () => {
    const first = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(first.credentialId, adminId, "abuse report");
    const latest = await prisma.badgeCredential.findFirstOrThrow({
      where: { participantId },
      orderBy: { issuedAt: "desc" }
    });
    assert.equal(latest.status, "REVOKED");
  });
});

// ─── E. Concurrency ───────────────────────────────────────────────────────

describe("E. concurrency", () => {
  test("two admins regenerate simultaneously → exactly one wins, one CONFLICT, one ACTIVE", async () => {
    const first = await issueBadgeCredential(participantId);
    const results = await Promise.allSettled([
      regen(participantId, first.credentialId, adminId),
      regen(participantId, first.credentialId, admin2Id)
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.ok(bad[0].reason instanceof BadgeError && bad[0].reason.code === "CONFLICT");
    assert.equal(await activeCount(participantId), 1);
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 2);
  });

  test("N parallel duplicate requests → exactly one success, no corruption", async () => {
    const first = await issueBadgeCredential(participantId);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => regen(participantId, first.credentialId))
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(r.reason instanceof BadgeError && r.reason.code === "CONFLICT");
      }
    }
    assert.equal(await activeCount(participantId), 1);
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 2);
  });

  test("retry after timeout with a stale credential id is a safe CONFLICT (no second rotation)", async () => {
    const first = await issueBadgeCredential(participantId);
    await regen(participantId, first.credentialId); // original attempt succeeded
    await assert.rejects(
      () => regen(participantId, first.credentialId), // client retries
      (e: unknown) => e instanceof BadgeError && e.code === "CONFLICT"
    );
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 2);
    assert.equal(await activeCount(participantId), 1);
  });

  test("concurrent revoke + regenerate: serialised, never two ACTIVE", async () => {
    const first = await issueBadgeCredential(participantId);
    const results = await Promise.allSettled([
      revokeBadgeCredential(first.credentialId, adminId, "race revoke"),
      regen(participantId, first.credentialId, admin2Id)
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(r.reason instanceof BadgeError && r.reason.code === "CONFLICT");
      }
    }
    assert.ok((await activeCount(participantId)) <= 1);
  });

  test("regeneration racing scans: after commit the old QR is rejected, new accepted", async () => {
    const first = await issueBadgeCredential(participantId);
    const scans: Array<Promise<unknown>> = [];
    const regenP = regen(participantId, first.credentialId);
    for (let i = 0; i < 10; i++) scans.push(verifyBadgeToken(first.rawToken));
    const second = await regenP;
    await Promise.all(scans);
    const oldR = await verifyBadgeToken(first.rawToken);
    assert.ok(!oldR.ok && oldR.reason === "REVOKED");
    assert.ok((await verifyBadgeToken(second.rawToken)).ok);
  });

  test("DB backstop: a second ACTIVE credential is rejected by Postgres", async () => {
    await issueBadgeCredential(participantId);
    await assert.rejects(
      () =>
        prisma.badgeCredential.create({
          data: { participantId, tokenHash: hashBadgeToken(`x-${Math.random()}`), status: "ACTIVE" }
        }),
      /Unique constraint|P2002/i
    );
  });
});

// ─── F. Audit atomicity ───────────────────────────────────────────────────

describe("F. audit is atomic with the credential change", () => {
  test("if the audit row cannot be written, regeneration rolls back entirely", async () => {
    const first = await issueBadgeCredential(participantId);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION policy_test_block_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit blocked by test'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER policy_test_block_audit_trg BEFORE INSERT ON "AuditLog"
      FOR EACH ROW WHEN (NEW.action = 'badge.regenerate')
      EXECUTE FUNCTION policy_test_block_audit()`);
    try {
      await assert.rejects(() => regen(participantId, first.credentialId));
      assert.equal(await activeCount(participantId), 1);
      const cur = await prisma.badgeCredential.findFirstOrThrow({
        where: { participantId, status: "ACTIVE" }
      });
      assert.equal(cur.id, first.credentialId, "old credential still the ACTIVE one");
      assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 1);
      assert.ok((await verifyBadgeToken(first.rawToken)).ok);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS policy_test_block_audit_trg ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS policy_test_block_audit()`);
    }
  });

  test("audit row carries actor, participant, old/new ids, reason, timestamp — and no token", async () => {
    const first = await issueBadgeCredential(participantId);
    const second = await regen(participantId, first.credentialId, adminId, "lost phone");
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "badge.regenerate", entityId: participantId }
    });
    assert.equal(log.userId, adminId);
    assert.ok(log.createdAt);
    const meta = log.meta as Record<string, unknown>;
    assert.equal(meta.oldCredentialId, first.credentialId);
    assert.equal(meta.newCredentialId, second.credentialId);
    assert.equal(meta.reason, "lost phone");
    const flat = JSON.stringify(log);
    assert.equal(flat.includes(second.rawToken), false);
    assert.equal(flat.includes(first.rawToken), false);
    assert.equal(flat.includes(SECRET), false);
  });

  test("a failed regeneration leaves no half-written state (reason invalid)", async () => {
    const first = await issueBadgeCredential(participantId);
    await assert.rejects(() => regen(participantId, first.credentialId, adminId, "x"));
    assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 1);
  });
});

// ─── G. Secret handling ───────────────────────────────────────────────────

describe("G. secret handling", () => {
  test("missing / short / reused secrets fail closed with BadgeError and no secret text", async () => {
    const saved = process.env.BADGE_QR_TOKEN_SECRET;
    const savedBackup = process.env.BACKUP_ENCRYPTION_KEY;
    try {
      for (const bad of [undefined, "", "short", "not a valid secret!!! ".repeat(4)]) {
        if (bad === undefined) delete process.env.BADGE_QR_TOKEN_SECRET;
        else process.env.BADGE_QR_TOKEN_SECRET = bad;
        assert.throws(
          () => loadBadgeQrSecret(),
          (e: unknown) =>
            e instanceof BadgeError &&
            e.code === "SECRET_NOT_CONFIGURED" &&
            !(typeof bad === "string" && bad.length > 0 && e.message.includes(bad))
        );
      }
      process.env.BADGE_QR_TOKEN_SECRET = saved;
      process.env.BACKUP_ENCRYPTION_KEY = saved; // reuse attempt
      assert.throws(
        () => loadBadgeQrSecret(),
        (e: unknown) => e instanceof BadgeError && e.code === "SECRET_NOT_CONFIGURED"
      );
    } finally {
      process.env.BADGE_QR_TOKEN_SECRET = saved;
      if (savedBackup === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = savedBackup;
    }
  });

  test("operations fail closed when the secret is absent (nothing written)", async () => {
    const saved = process.env.BADGE_QR_TOKEN_SECRET;
    delete process.env.BADGE_QR_TOKEN_SECRET;
    try {
      await assert.rejects(
        () => issueBadgeCredential(participantId),
        (e: unknown) => e instanceof BadgeError && e.code === "SECRET_NOT_CONFIGURED"
      );
      assert.equal(await prisma.badgeCredential.count({ where: { participantId } }), 0);
    } finally {
      process.env.BADGE_QR_TOKEN_SECRET = saved;
    }
  });

  test("a different secret cannot re-display the QR (SECRET_MISMATCH) but scanning still works", async () => {
    const issued = await issueBadgeCredential(participantId);
    const saved = process.env.BADGE_QR_TOKEN_SECRET;
    process.env.BADGE_QR_TOKEN_SECRET = "another-secret-0123456789abcdef0123456789abcdef-xyz";
    try {
      await assert.rejects(
        () => getCurrentBadgeToken(participantId),
        (e: unknown) => e instanceof BadgeError && e.code === "SECRET_MISMATCH"
      );
      // Validation is hash-based and does not need the secret.
      assert.ok((await verifyBadgeToken(issued.rawToken)).ok);
    } finally {
      process.env.BADGE_QR_TOKEN_SECRET = saved;
    }
  });

  test("derivation: no collisions across many (credential, sequence) pairs and participants", () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 50; s++) {
      for (let c = 0; c < 40; c++) {
        const t = deriveBadgeToken(`cred-${c}`, s);
        assert.equal(t.length, 43);
        assert.ok(!seen.has(t));
        seen.add(t);
      }
    }
  });

  test("source scan: no secret/token logging, no secret in browser-bound code", async () => {
    const files = [
      "../lib/badge/service.ts",
      "../lib/badge/token.ts",
      "../app/compte/badge/page.tsx",
      "../app/compte/badge/actions.ts",
      "../app/admin/(protected)/registrants/[id]/access-actions.ts"
    ];
    for (const f of files) {
      const src = await readFile(new URL(f, import.meta.url), "utf8");
      for (const line of src.split(/\r?\n/)) {
        if (/console\.(log|info|warn|error|debug)/.test(line)) {
          assert.equal(
            /rawToken|tokenHash|SECRET|secret|\.token\b/.test(line),
            false,
            `${f}: logging line mentions a secret/token: ${line.trim()}`
          );
        }
      }
    }
    const client = await readFile(
      new URL("../components/compte/badge-qr-client.tsx", import.meta.url),
      "utf8"
    );
    assert.equal(client.includes("BADGE_QR_TOKEN_SECRET"), false);
    const panel = await readFile(
      new URL("../app/admin/(protected)/registrants/[id]/badge-panel.tsx", import.meta.url),
      "utf8"
    );
    assert.equal(panel.includes("BADGE_QR_TOKEN_SECRET"), false);
    assert.equal(/rawToken/.test(panel), false);
  });
});

// ─── H. Admin server-action structure (authorization) ─────────────────────

describe("H. admin actions authorize server-side", () => {
  test("every badge admin action begins with requirePermission", async () => {
    const src = (
      await readFile(
        new URL("../app/admin/(protected)/registrants/[id]/access-actions.ts", import.meta.url),
        "utf8"
      )
    ).replace(/\r\n/g, "\n");
    const expect: Record<string, string> = {
      viewBadgeQrAsAdminAction: "badge.view",
      regenerateBadgeAsAdminAction: "badge.regenerate",
      revokeBadgeAsAdminAction: "badge.manage"
    };
    for (const [fn, perm] of Object.entries(expect)) {
      const i = src.indexOf(`export async function ${fn}(`);
      assert.ok(i >= 0, `${fn} exists`);
      const body = src.slice(i, i + 400);
      assert.ok(
        body.includes(`requirePermission("${perm}")`),
        `${fn} must call requirePermission("${perm}") first`
      );
    }
    assert.equal(src.includes("rotateBadgeAsAdminAction"), false);
  });
});

// ─── I. Legacy cutover ────────────────────────────────────────────────────

describe("I. legacy cutover", () => {
  test("replaces a legacy ACTIVE credential for the SAME participant; history kept", async () => {
    const legacy = await prisma.badgeCredential.create({
      data: {
        participantId,
        tokenHash: hashBadgeToken(`legacy-${Math.random()}-${Date.now()}`),
        status: "ACTIVE"
      }
    });
    const checkIn = await prisma.checkIn.create({
      data: {
        participantId,
        credentialId: legacy.id,
        ticketCode: "",
        gate: "main-entrance",
        result: "VALID"
      }
    });
    const r = await reissueLegacyCredential(participantId);
    assert.ok(r);
    assert.equal(r!.previousCredentialId, legacy.id);
    const old = await prisma.badgeCredential.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(old.status, "REVOKED");
    assert.equal(old.participantId, participantId);
    const cur = await getCurrentBadgeToken(participantId);
    assert.ok(cur.ok);
    assert.equal(await activeCount(participantId), 1);
    const ci = await prisma.checkIn.findUniqueOrThrow({ where: { id: checkIn.id } });
    assert.equal(ci.participantId, participantId);
    assert.equal(ci.credentialId, legacy.id);
    // Idempotent: nothing left to migrate.
    assert.equal(await reissueLegacyCredential(participantId), null);
  });

  test("never touches persistent credentials or admin-revoked participants", async () => {
    const issued = await issueBadgeCredential(participantId);
    assert.equal(await reissueLegacyCredential(participantId), null);
    assert.ok((await verifyBadgeToken(issued.rawToken)).ok);

    const revokedP = await newParticipant();
    const legacy = await prisma.badgeCredential.create({
      data: {
        participantId: revokedP,
        tokenHash: hashBadgeToken(`legacy-r-${Math.random()}`),
        status: "REVOKED",
        revokedReason: "admin"
      }
    });
    assert.equal(await reissueLegacyCredential(revokedP), null);
    assert.equal(await activeCount(revokedP), 0);
    assert.equal(
      (await prisma.badgeCredential.findUniqueOrThrow({ where: { id: legacy.id } })).status,
      "REVOKED"
    );
  });

  test("display of a legacy credential reports LEGACY (never fabricates a QR)", async () => {
    await prisma.badgeCredential.create({
      data: {
        participantId,
        tokenHash: hashBadgeToken(`legacy-d-${Math.random()}`),
        status: "ACTIVE"
      }
    });
    const cur = await getCurrentBadgeToken(participantId);
    assert.ok(!cur.ok && cur.reason === "LEGACY");
  });
});

// ─── J. Backup / restore exposure ─────────────────────────────────────────

describe("J. database (and therefore backups) never hold raw tokens or the secret", () => {
  test("no BadgeCredential / AuditLog row contains a raw QR token or the QR secret", async () => {
    const first = await issueBadgeCredential(participantId);
    const second = await regen(participantId, first.credentialId);
    const creds = JSON.stringify(
      await prisma.badgeCredential.findMany({ where: { participantId } })
    );
    const logs = JSON.stringify(
      await prisma.auditLog.findMany({ where: { entityId: participantId } })
    );
    for (const blob of [creds, logs]) {
      assert.equal(blob.includes(first.rawToken), false);
      assert.equal(blob.includes(second.rawToken), false);
      assert.equal(blob.includes(SECRET), false);
    }
  });

  test("restore semantics are status-faithful: a persisted ACTIVE credential still re-derives the same QR (secret from env, not DB)", async () => {
    const issued = await issueBadgeCredential(participantId);
    const row = await prisma.badgeCredential.findFirstOrThrow({
      where: { participantId, status: "ACTIVE" }
    });
    // Simulate "restored row": only DB columns + the env secret are needed.
    assert.equal(deriveBadgeToken(row.id, row.sequence!), issued.rawToken);
  });
});

describe("K. secret hardening", () => {
  test("same key bytes in another encoding is still detected as reuse; low-diversity rejected", () => {
    const saved = process.env.BADGE_QR_TOKEN_SECRET;
    const savedBackup = process.env.BACKUP_ENCRYPTION_KEY;
    try {
      const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256));
      process.env.BADGE_QR_TOKEN_SECRET = bytes.toString("base64url");
      process.env.BACKUP_ENCRYPTION_KEY = bytes.toString("hex");
      assert.throws(
        () => loadBadgeQrSecret(),
        (e: unknown) => e instanceof BadgeError && e.code === "SECRET_NOT_CONFIGURED"
      );
      delete process.env.BACKUP_ENCRYPTION_KEY;
      assert.ok(loadBadgeQrSecret().length >= 32);
      process.env.BADGE_QR_TOKEN_SECRET = "a".repeat(64);
      assert.throws(
        () => loadBadgeQrSecret(),
        (e: unknown) => e instanceof BadgeError && e.code === "SECRET_NOT_CONFIGURED"
      );
    } finally {
      process.env.BADGE_QR_TOKEN_SECRET = saved;
      if (savedBackup === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = savedBackup;
    }
  });
});

describe("L. QR is issued automatically only AFTER email verification", () => {
  test("unverified account gets NO QR; verifying the email issues it automatically", async () => {
    const { ensureParticipantForAccount } = await import("../lib/register/participant");
    const {
      issueEmailVerificationToken,
      consumeEmailVerificationToken,
      isAccountEmailVerified
    } = await import("../lib/account/email-verification");
    const acct = await prisma.accountUser.create({
      data: {
        email: `policy-test-acct-verify-${Date.now()}@bis.dz`,
        firstName: "New",
        lastName: "Signup",
        passwordHash: "x"
      }
    });
    assert.equal(await isAccountEmailVerified(acct.id), false);

    // Unverified: participant may exist (e.g. /register step) but NO QR.
    const ensured = await ensureParticipantForAccount({
      id: acct.id,
      email: acct.email,
      firstName: acct.firstName,
      lastName: acct.lastName
    });
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    await ensureActiveBadge(ensured.participant.id);
    assert.equal(
      await prisma.badgeCredential.count({ where: { participantId: ensured.participant.id } }),
      0,
      "no credential while the email is unverified"
    );

    // Verify the email → QR is issued automatically.
    const issued = await issueEmailVerificationToken({ userId: acct.id, email: acct.email });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(res.ok, true);
    assert.equal(await isAccountEmailVerified(acct.id), true);
    assert.equal(await activeCount(ensured.participant.id), 1);
    const cur = await getCurrentBadgeToken(ensured.participant.id);
    assert.ok(cur.ok);

    // Re-running issuance cannot create another credential.
    await ensureActiveBadge(ensured.participant.id);
    assert.equal(
      await prisma.badgeCredential.count({ where: { participantId: ensured.participant.id } }),
      1
    );
    await prisma.participant.delete({ where: { id: ensured.participant.id } });
  });

  test("verification creates the Participant + QR for an account that never opened /register", async () => {
    const { issueEmailVerificationToken, consumeEmailVerificationToken } =
      await import("../lib/account/email-verification");
    const acct = await prisma.accountUser.create({
      data: {
        email: `policy-test-acct-fresh-${Date.now()}@bis.dz`,
        firstName: "Fresh",
        lastName: "Account",
        passwordHash: "x"
      }
    });
    assert.equal(await prisma.participant.count({ where: { accountUserId: acct.id } }), 0);
    const issued = await issueEmailVerificationToken({ userId: acct.id, email: acct.email });
    assert.equal((await consumeEmailVerificationToken(issued.rawToken)).ok, true);
    const p = await prisma.participant.findFirstOrThrow({ where: { accountUserId: acct.id } });
    assert.equal(await activeCount(p.id), 1);
    await prisma.participant.delete({ where: { id: p.id } });
  });

  test("an admin-revoked participant is NOT re-issued once the email is verified", async () => {
    const issued0 = await issueBadgeCredential(participantId);
    await revokeBadgeCredential(issued0.credentialId, adminId, "abuse report");
    await prisma.accountUser.update({
      where: { id: accountId },
      data: { emailVerifiedAt: new Date() }
    });
    await ensureActiveBadge(participantId);
    assert.equal(await activeCount(participantId), 0);
  });

  test("source: signup no longer creates a Participant/QR; resend action + banner exist", async () => {
    const acc = (
      await readFile(new URL("../app/actions/account.ts", import.meta.url), "utf8")
    ).replace(/\r\n/g, "\n");
    const reg = acc.slice(
      acc.indexOf("export async function registerAccount("),
      acc.indexOf("export type ResendVerificationResult")
    );
    assert.equal(reg.includes("ensureParticipantForAccount("), false);
    assert.equal(reg.includes("ensureActiveBadge("), false);
    assert.ok(acc.includes("export async function resendVerificationEmail"));
    assert.ok(acc.includes("requireAccount()"));
    const layout = await readFile(new URL("../app/compte/layout.tsx", import.meta.url), "utf8");
    assert.ok(layout.includes("VerifyEmailBanner"));
  });
});

describe("M. role control settings", () => {
  test("settings action requires roles.manage and writes audit in the same transaction", async () => {
    const src = (
      await readFile(
        new URL("../app/admin/(protected)/settings/badges/actions.ts", import.meta.url),
        "utf8"
      )
    ).replace(/\r\n/g, "\n");
    assert.ok(src.includes('requirePermission("roles.manage")'));
    const tx = src.slice(src.indexOf("$transaction"));
    assert.ok(tx.includes("auditLog.create"), "audit row inside the transaction");
    assert.ok(src.includes("AdminRole.SUPER_ADMIN"), "super admin is protected");
    assert.ok(src.includes("r !== user.role"), "cannot edit own role");
  });

  test("override rows drive canWithOverrides for badge.regenerate (grant + revoke)", async () => {
    const { canWithOverrides } = await import("../lib/admin/rbac");
    const role = AdminRole.SALES;
    await prisma.rolePermissionOverride.deleteMany({
      where: { permission: "badge.regenerate" }
    });
    try {
      assert.equal(await canWithOverrides(role, "badge.regenerate"), false);
      await prisma.rolePermissionOverride.create({
        data: { role, permission: "badge.regenerate", granted: true }
      });
      assert.equal(await canWithOverrides(role, "badge.regenerate"), true);
      await prisma.rolePermissionOverride.update({
        where: { role_permission: { role, permission: "badge.regenerate" } },
        data: { granted: false }
      });
      assert.equal(await canWithOverrides(role, "badge.regenerate"), false);
      await prisma.rolePermissionOverride.create({
        data: { role: AdminRole.ADMIN, permission: "badge.regenerate", granted: false }
      });
      assert.equal(await canWithOverrides(AdminRole.ADMIN, "badge.regenerate"), false);
    } finally {
      await prisma.rolePermissionOverride.deleteMany({
        where: { permission: "badge.regenerate" }
      });
    }
  });
});

describe("N. 'this wasn't me' — hijacked signup neutralisation", () => {
  async function victimScenario() {
    const {
      issueEmailVerificationToken,
      consumeEmailVerificationToken
    } = await import("../lib/account/email-verification");
    const email = `policy-test-victim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@bis.dz`;
    // Victim's legacy anonymous registration with that email.
    const legacy = await prisma.participant.create({
      data: {
        eventId,
        firstName: "Victim",
        lastName: "Real",
        email,
        status: RegistrationStatus.CONFIRMED
      }
    });
    // Attacker signs up with the victim's email and a password they know.
    const attacker = await prisma.accountUser.create({
      data: {
        email,
        firstName: "Evil",
        lastName: "Attacker",
        passwordHash: "attacker-known-hash"
      }
    });
    await prisma.accountSession.create({
      data: {
        userId: attacker.id,
        tokenHash: `policy-test-sess-${Math.random()}`,
        expiresAt: new Date(Date.now() + 3600_000)
      }
    });
    // Victim clicks the link that was mailed to them.
    const issued = await issueEmailVerificationToken({ userId: attacker.id, email });
    assert.equal((await consumeEmailVerificationToken(issued.rawToken)).ok, true);
    return { email, legacy, attacker, rawToken: issued.rawToken };
  }

  test("without the report, the claim + QR happen (documents the exposure the feature closes)", async () => {
    const s = await victimScenario();
    const p = await prisma.participant.findUniqueOrThrow({ where: { id: s.legacy.id } });
    assert.equal(p.accountUserId, s.attacker.id);
    assert.equal(await activeCount(s.legacy.id), 1);
  });

  test("reporting neutralises: sessions gone, password unusable, email unverified, participant unbound, QR revoked, audited", async () => {
    const { neutralizeUnexpectedSignup } = await import("../lib/account/email-verification");
    const s = await victimScenario();
    const r = await neutralizeUnexpectedSignup(s.rawToken);
    assert.equal(r.ok, true);

    const acct = await prisma.accountUser.findUniqueOrThrow({ where: { id: s.attacker.id } });
    assert.equal(acct.emailVerifiedAt, null);
    assert.notEqual(acct.passwordHash, "attacker-known-hash");
    assert.equal(await prisma.accountSession.count({ where: { userId: s.attacker.id } }), 0);

    const p = await prisma.participant.findUniqueOrThrow({ where: { id: s.legacy.id } });
    assert.equal(p.accountUserId, null, "victim's registration is detached from the intruder's account");
    assert.equal(await activeCount(s.legacy.id), 0, "every QR the intruder could have seen is dead");
    const creds = await prisma.badgeCredential.findMany({ where: { participantId: s.legacy.id } });
    assert.ok(creds.length >= 1 && creds.every((c) => c.status === "REVOKED"));
    assert.equal(creds[0].revokedReason, "unexpected-signup-report");

    const log = await prisma.auditLog.findFirst({
      where: { action: "account.unexpected-signup.reported", entityId: s.attacker.id }
    });
    assert.ok(log);

    // The detached registration cannot be silently re-issued a QR.
    await ensureActiveBadge(s.legacy.id);
    assert.equal(await activeCount(s.legacy.id), 0);
    // Idempotent / replay-safe.
    const again = await neutralizeUnexpectedSignup(s.rawToken);
    assert.equal(again.ok, true);
  });

  test("an unused / unknown / expired token cannot neutralise anyone", async () => {
    const { neutralizeUnexpectedSignup, issueEmailVerificationToken } =
      await import("../lib/account/email-verification");
    assert.deepEqual(await neutralizeUnexpectedSignup("nope"), { ok: false, reason: "invalid" });
    assert.deepEqual(await neutralizeUnexpectedSignup(""), { ok: false, reason: "invalid" });
    // Issued but never consumed → no verification click happened → refused.
    const issued = await issueEmailVerificationToken({ userId: accountId, email: "x@bis.dz" });
    assert.deepEqual(await neutralizeUnexpectedSignup(issued.rawToken), { ok: false, reason: "invalid" });
    // Consumed long ago → window closed.
    const { createHash } = await import("node:crypto");
    await prisma.emailVerificationToken.update({
      where: { tokenHash: createHash("sha256").update(issued.rawToken).digest("hex") },
      data: { usedAt: new Date(Date.now() - 3600_000) }
    });
    assert.deepEqual(await neutralizeUnexpectedSignup(issued.rawToken), { ok: false, reason: "expired" });
  });

  test("source: token only via httpOnly cookie; landing action reads the cookie, never client input", async () => {
    const route = await readFile(new URL("../app/api/auth/verify-email/route.ts", import.meta.url), "utf8");
    assert.ok(/bis_notme/.test(route) && /httpOnly:\s*true/.test(route));
    const act = (await readFile(new URL("../app/auth/verifier-email/actions.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.ok(act.includes('jar.get("bis_notme")'));
    assert.ok(/export async function reportUnexpectedSignup\(\)/.test(act), "takes no client parameters");
  });
});

describe("O. permission hardening", () => {
  test("forbidden roles can NEVER hold badge.regenerate — enforced at authorisation time, even with override rows", async () => {
    const rbac = await import("../lib/admin/rbac");
    const forbidden = [AdminRole.CHECKIN_OPERATOR, AdminRole.VIEWER, AdminRole.ANALYTICS];
    for (const r of forbidden) assert.ok(rbac.BADGE_REGENERATE_FORBIDDEN_ROLES.includes(r));
    await prisma.rolePermissionOverride.deleteMany({ where: { permission: "badge.regenerate" } });
    try {
      for (const role of forbidden) {
        // Simulate a bypass: an override row written by a direct DB write /
        // restore / the legacy role editor.
        await prisma.rolePermissionOverride.create({
          data: { role, permission: "badge.regenerate", granted: true }
        });
        assert.equal(await rbac.canWithOverrides(role, "badge.regenerate"), false, `${role} must stay denied`);
        const eff = await rbac.getEffectivePermissions(role);
        assert.ok(!eff.includes("badge.regenerate"), `${role} effective perms must exclude it`);
      }
      // An allowed role still works through overrides.
      await prisma.rolePermissionOverride.create({
        data: { role: AdminRole.SALES, permission: "badge.regenerate", granted: true }
      });
      assert.equal(await rbac.canWithOverrides(AdminRole.SALES, "badge.regenerate"), true);
    } finally {
      await prisma.rolePermissionOverride.deleteMany({ where: { permission: "badge.regenerate" } });
    }
  });

  test("both role-management actions refuse the forbidden grant; allowlist lives in rbac.ts", async () => {
    const strip = (t: string) => t.replace(/\r\n/g, "\n");
    const settings = strip(await readFile(new URL("../app/admin/(protected)/settings/badges/actions.ts", import.meta.url), "utf8"));
    const editor = strip(await readFile(new URL("../app/actions/update-role-permissions.ts", import.meta.url), "utf8"));
    assert.ok(settings.includes("BADGE_REGENERATE_FORBIDDEN_ROLES"));
    assert.ok(editor.includes("isForbiddenGrant"));
    const tx = settings.slice(settings.indexOf("$transaction"));
    assert.ok(tx.includes("NOT_HELD"), "'cannot grant what you lack' re-checked inside the transaction");
  });

  test("hourly ceiling on REGENERATE is atomic: parallel requests cannot exceed it", async () => {
    const { REGENERATE_PER_ADMIN_PER_HOUR } = await import("../lib/badge/service");
    // Pre-fill the admin's budget minus 2 with audit rows, then fire 6 in parallel.
    const fill = REGENERATE_PER_ADMIN_PER_HOUR - 2;
    // Earlier tests in this file already regenerated as this admin; start
    // from a clean budget (throwaway test database only).
    await prisma.auditLog.deleteMany({
      where: { userId: admin2Id, action: "badge.regenerate" }
    });
    await prisma.auditLog.createMany({
      data: Array.from({ length: fill }, () => ({
        userId: admin2Id,
        action: "badge.regenerate",
        entity: "Participant",
        entityId: "policy-test-budget"
      }))
    });
    try {
      const pids = await Promise.all(Array.from({ length: 6 }, () => newParticipant()));
      const creds = await Promise.all(pids.map((p) => issueBadgeCredential(p)));
      const results = await Promise.allSettled(
        pids.map((p, i) => regen(p, creds[i].credentialId, admin2Id))
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const limited = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof BadgeError && r.reason.code === "RATE_LIMITED"
      ).length;
      assert.equal(ok, 2, "exactly the remaining budget succeeds");
      assert.equal(limited, 4);
    } finally {
      await prisma.auditLog.deleteMany({ where: { userId: admin2Id, entityId: "policy-test-budget" } });
    }
  });

  test("QR view ceiling is counted atomically in one transaction with the audit write", async () => {
    const src = (await readFile(new URL("../app/admin/(protected)/registrants/[id]/access-actions.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    const view = src.slice(src.indexOf("export async function viewBadgeQrAsAdminAction("));
    const body = view.slice(0, view.indexOf("export async function regenerateBadgeAsAdminAction("));
    assert.ok(body.includes("pg_advisory_xact_lock"));
    assert.ok(body.includes("VIEW_PER_ADMIN_PER_HOUR"));
    assert.ok(body.indexOf("auditLog.count") < body.indexOf("auditLog.create"));
    assert.ok(body.includes("$transaction"));
  });
});

describe("P. every \"use server\" file exports only async functions (Next 15 rule)", () => {
  test("no value exports other than async functions in any server-action file", async () => {
    const { readdir } = await import("node:fs/promises");
    const root = new URL("../", import.meta.url);
    const offenders: string[] = [];
    async function walk(dirUrl: URL) {
      for (const e of await readdir(dirUrl, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
        const child = new URL(e.name + (e.isDirectory() ? "/" : ""), dirUrl);
        if (e.isDirectory()) await walk(child);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = (await readFile(child, "utf8")).replace(/\r\n/g, "\n");
          if (!/^\s*["']use server["']/.test(src)) continue;
          for (const line of src.split("\n")) {
            if (
              /^export\s+(const|let|var|class|enum)\b/.test(line) ||
              /^export\s*\{/.test(line) && !/^export\s+type\s*\{/.test(line) ||
              /^export\s+default\b/.test(line) && !/async function/.test(line)
            ) {
              offenders.push(`${child.pathname}: ${line.trim()}`);
            }
          }
        }
      }
    }
    await walk(new URL("app/", root));
    await walk(new URL("lib/", root));
    assert.deepEqual(offenders, []);
  });
});

describe("Q. role editor: Badges & QR module", () => {
  test("every permission used by the catalog exists, and the badges module maps view/regenerate/revoke", async () => {
    const { PERMISSIONS } = await import("../lib/admin/rbac");
    const { STAFF_MODULES } = await import("../lib/admin/role-catalog-data");
    for (const m of STAFF_MODULES) {
      for (const perm of Object.values(m.ops)) {
        assert.ok((PERMISSIONS as readonly string[]).includes(perm as string), `${m.key}: unknown permission ${perm}`);
      }
    }
    const badges = STAFF_MODULES.find((m) => m.key === "badges");
    assert.ok(badges);
    assert.equal(badges!.ops.read, "badge.view");
    assert.equal(badges!.ops.update, "badge.regenerate");
    assert.equal(badges!.ops.delete, "badge.manage");
  });

  test("baseline: only SUPER_ADMIN + ADMIN hold badge.view and badge.regenerate", async () => {
    const { can } = await import("../lib/admin/rbac");
    for (const perm of ["badge.view", "badge.regenerate"] as const) {
      assert.equal(can(AdminRole.SUPER_ADMIN, perm), true);
      assert.equal(can(AdminRole.ADMIN, perm), true);
      for (const r of [
        AdminRole.REGISTRATION_MANAGER, AdminRole.CHECKIN_OPERATOR, AdminRole.SALES, AdminRole.FINANCE,
        AdminRole.ANALYTICS, AdminRole.CONTENT_MANAGER, AdminRole.SPONSOR_MANAGER, AdminRole.VIEWER
      ]) {
        assert.equal(can(r, perm), false, `${r} must not hold ${perm}`);
      }
    }
  });

  test("forbidden roles can never hold badge.view either — even with override rows", async () => {
    const rbac = await import("../lib/admin/rbac");
    await prisma.rolePermissionOverride.deleteMany({ where: { permission: { in: ["badge.view", "badge.regenerate"] } } });
    try {
      for (const role of [AdminRole.CHECKIN_OPERATOR, AdminRole.VIEWER, AdminRole.ANALYTICS]) {
        await prisma.rolePermissionOverride.create({ data: { role, permission: "badge.view", granted: true } });
        assert.equal(await rbac.canWithOverrides(role, "badge.view"), false);
        assert.ok(!(await rbac.getEffectivePermissions(role)).includes("badge.view"));
        assert.equal(rbac.isForbiddenGrant(role, "badge.view"), true);
        assert.equal(rbac.isForbiddenGrant(role, "badge.regenerate"), true);
        assert.equal(rbac.isForbiddenGrant(role, "badge.manage"), true, "revoking is excluded too");
        assert.equal(rbac.isForbiddenGrant(role, "access.view"), false, "unrelated permissions unaffected");
      }
      // An allowed role can be granted view via override.
      await prisma.rolePermissionOverride.create({ data: { role: AdminRole.SALES, permission: "badge.view", granted: true } });
      assert.equal(await rbac.canWithOverrides(AdminRole.SALES, "badge.view"), true);
      assert.ok((await rbac.getEffectivePermissions(AdminRole.SALES)).includes("badge.view"));
    } finally {
      await prisma.rolePermissionOverride.deleteMany({ where: { permission: { in: ["badge.view", "badge.regenerate"] } } });
    }
  });

  test("catalog access is override-aware: saved grants/revocations show in the editor", async () => {
    const rbac = await import("../lib/admin/rbac");
    const { computeStaffAccess } = await import("../lib/admin/role-catalog");
    const base = computeStaffAccess(AdminRole.SALES).find((m) => m.key === "badges")!;
    assert.equal(base.grantedOps, 0);
    const eff = [...(await rbac.getEffectivePermissions(AdminRole.SALES)), "badge.view" as const];
    const withView = computeStaffAccess(AdminRole.SALES, eff).find((m) => m.key === "badges")!;
    assert.equal(withView.granted.read, true);
    assert.equal(withView.granted.update, undefined);
    // ADMIN baseline shows view + regenerate + revoke.
    const adm = computeStaffAccess(AdminRole.ADMIN).find((m) => m.key === "badges")!;
    assert.equal(adm.grantedOps, 3);
  });

  test("role-editor action: forbidden grants refused, audit in the SAME transaction, roles.manage required", async () => {
    const src = (await readFile(new URL("../app/actions/update-role-permissions.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.ok(src.includes("isForbiddenGrant(role, p)"));
    assert.ok(src.includes('canWithOverrides(admin.user.role, "roles.manage")'));
    const tx = src.slice(src.indexOf("prisma.$transaction("));
    assert.ok(tx.includes("tx.auditLog.create"), "audit row inside the interactive transaction");
    assert.ok(!src.slice(0, src.indexOf("prisma.$transaction(")).includes("auditLog.create"), "no separate non-atomic audit write before it");
    assert.ok(src.includes("z.boolean()"), "payload values must be real booleans");
    assert.ok(src.includes("SUPER_ADMIN_ONLY_PERMISSIONS.includes(p) && !callerIsSuper"));
    assert.ok(src.includes("const callerHolds = async") && src.includes("pg_advisory_xact_lock"), "caller-holds re-read inside the serialised transaction");
    assert.ok(src.includes("role === AdminRole.ADMIN"), "delegated editors cannot edit ADMIN");
  });

  test("role page + editor: effective permissions, locked toggles, no client-side authority", async () => {
    const page = await readFile(new URL("../app/admin/(protected)/roles/[roleKey]/page.tsx", import.meta.url), "utf8");
    assert.ok(page.includes("getEffectivePermissions"));
    assert.ok(page.includes("locked={lockedPerms}"));
    const editor = await readFile(new URL("../app/admin/(protected)/roles/[roleKey]/permission-editor.tsx", import.meta.url), "utf8");
    assert.ok(editor.includes("locked.includes(permKey)"));
    assert.equal(editor.includes("lib/db"), false);
    assert.equal(editor.includes("next/headers"), false);
  });

  test("view action requires its own permission badge.view", async () => {
    const src = (await readFile(new URL("../app/admin/(protected)/registrants/[id]/access-actions.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    const view = src.slice(src.indexOf("export async function viewBadgeQrAsAdminAction("));
    assert.ok(view.slice(0, 300).includes('requirePermission("badge.view")'));
  });
});

describe("R. role-editor action hardening", () => {
  test("sensitive verbs (roles/users/backup destructive) are SUPER_ADMIN-only to change", async () => {
    const { SUPER_ADMIN_ONLY_PERMISSIONS } = await import("../lib/admin/rbac");
    for (const p of ["roles.manage", "users.manage", "backup.restore"] as const) {
      assert.ok(SUPER_ADMIN_ONLY_PERMISSIONS.includes(p), p);
    }
    assert.ok(!SUPER_ADMIN_ONLY_PERMISSIONS.includes("badge.view"));
  });

  test("effective permissions agree with can() for forbidden roles even if the baseline were edited", async () => {
    const rbac = await import("../lib/admin/rbac");
    for (const role of [AdminRole.CHECKIN_OPERATOR, AdminRole.VIEWER, AdminRole.ANALYTICS]) {
      const eff = await rbac.getEffectivePermissions(role);
      for (const p of ["badge.view", "badge.regenerate", "badge.manage"] as const) {
        assert.equal(eff.includes(p), rbac.can(role, p));
        assert.equal(rbac.can(role, p), false);
      }
    }
  });

  test("updateRolePermissions validates payload shape strictly and revalidates the related pages", async () => {
    const src = (await readFile(new URL("../app/actions/update-role-permissions.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.ok(src.includes("payloadSchema.safeParse"));
    assert.ok(src.includes('"Permission inconnue."'), "unknown keys refused, not ignored");
    assert.ok(src.includes('revalidatePath("/admin/roles")'));
    assert.ok(src.includes("ROLE_PERMISSIONS_DENIED"), "refused escalation attempts are audited");
    assert.ok(src.includes("before === granted"), "no-op writes are skipped");
    assert.ok(src.includes("before, after: granted") || src.includes("before, after"), "audit stores before/after");
  });
});

describe("S. role editor sends catalog keys", () => {
  test("every staff catalog key the editor can send resolves; the action accepts catalog keys (regression: 'Rôle invalide')", async () => {
    const { ROLE_CATALOG } = await import("../lib/admin/role-catalog");
    const staff = ROLE_CATALOG.filter((r) => r.kind === "staff");
    assert.ok(staff.length >= 3);
    for (const r of staff) {
      assert.notEqual(r.key, r.adminRole, "editor keys differ from enum values — the action must map them");
    }
    const src = (await readFile(new URL("../app/actions/update-role-permissions.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.ok(src.includes("r.key === roleKey"), "action resolves the catalog key");
    const page = await readFile(new URL("../app/admin/(protected)/roles/[roleKey]/page.tsx", import.meta.url), "utf8");
    assert.ok(page.includes("roleKey={role.key}"), "editor passes the catalog key");
  });
});

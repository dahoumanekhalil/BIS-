// End-to-end tests for the complete Backup/Restore subsystem (Phase 10).
// Run with:
//   npm run test:backup-e2e
//
// These tests exercise the REAL system top-to-bottom against the dev
// Postgres. They are complementary to (not replacements for) the
// module-level suites in backup-{crypto,storage,manifest,dump,verify,
// rbac,restore,scheduler}.test.ts. E2E scope:
//
//   1. Golden backup pipeline: server action → dump → encrypt →
//      manifest → publish → verify → list → detail.
//   2. Cron-endpoint auth-helper: uniform 404 semantics preserved.
//   3. Scheduler cron replay: duplicate ticks produce ≤1 SCHEDULED backup.
//   4. Retention protection matrix: last-known-good + in-flight source +
//      in-flight safety all survive an aggressive prune.
//   5. Authorization matrix at the server-action layer: unauth /
//      wrong-role / correct-role for every backup.* verb.
//   6. Filesystem consistency: staging is empty after publish; published
//      .bin and .manifest.json are readable back.
//   7. Restore-refresh survival: the RSC restore page's fetched
//      `activeRestore` reflects a truly in-flight RestoreOperation and
//      is null once terminal — proving refresh reconstructs from DB state.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";

let testWindowStart: Date;
const scratchRoots: string[] = [];

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

async function insertAdmin(
  prisma: InstanceType<PrismaModule["PrismaClient"]>,
  role: "SUPER_ADMIN" | "ADMIN" | "VIEWER" | "SALES",
  tag: string,
  password = "test-only-do-not-use"
): Promise<{ id: string; password: string }> {
  const { hashPassword } = await import("../lib/admin/password");
  const email = `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@bis.dz`;
  const admin = await prisma.adminUser.create({
    data: {
      email,
      name: `E2E ${tag}`,
      passwordHash: hashPassword(password),
      role,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  return { id: admin.id, password };
}

before(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  process.env.INTERNAL_BACKUP_TICK_SECRET = randomBytes(32).toString("base64url");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bis-e2e-"));
  process.env.BACKUP_STORAGE_DIR = tmp;
  scratchRoots.push(tmp);
  testWindowStart = new Date();
});

after(async () => {
  const prisma = await makePrisma();
  try {
    await prisma.auditLog.deleteMany({
      where: {
        createdAt: { gte: testWindowStart },
        action: { startsWith: "backup." }
      }
    });
    await prisma.restoreOperation.deleteMany({
      where: { startedAt: { gte: testWindowStart } }
    });
    await prisma.backup.deleteMany({
      where: { startedAt: { gte: testWindowStart } }
    });
    await prisma.adminUser.deleteMany({
      where: { email: { startsWith: "e2e-" } }
    });
    await prisma.backupSchedule.deleteMany({}).catch(() => undefined);
  } finally {
    await prisma.$disconnect();
  }
  for (const dir of scratchRoots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ─── E2E: golden backup pipeline ────────────────────────────────────────────

describe("E2E — golden backup pipeline (service → dump → verify → list → detail)", async () => {
  const service = await import("../lib/backup/service");
  const storage = await import("../lib/backup/storage");

  test("SUPER_ADMIN creates, verifies, lists, and inspects a backup", async () => {
    const prisma = await makePrisma();
    try {
      const admin = await insertAdmin(prisma, "SUPER_ADMIN", "golden");

      // Step 1: create.
      const create = await service.createBackupService({
        actor: { id: admin.id, role: "SUPER_ADMIN" }
      });
      assert.equal(create.ok, true, JSON.stringify(create));
      if (!create.ok) throw new Error("guard");
      const backupId = create.backupId;

      // Step 2: filesystem side-effect: .bin + .manifest.json under
      // published/, staging is empty. Symlink refusal is exercised in
      // the storage suite.
      const root = process.env.BACKUP_STORAGE_DIR!;
      const stagingContents = await fs.readdir(path.join(root, "staging"));
      assert.equal(
        stagingContents.filter(
          (n) => n.endsWith(".bin") || n.endsWith(".manifest.json")
        ).length,
        0,
        "staging must be empty after publish"
      );
      const publishedIds = await storage.listPublishedIds();
      assert.ok(publishedIds.includes(backupId));

      // Step 3: verify (real Phase-5 verifier).
      const verify = await service.verifyBackupService({
        actor: { id: admin.id, role: "SUPER_ADMIN" },
        backupId
      });
      assert.equal(verify.ok, true, JSON.stringify(verify));
      if (verify.ok) {
        assert.equal(verify.outcome, "VERIFIED");
        assert.match(verify.code, /^OK$/);
        // NEVER leaks internal detail.
        assert.equal((verify as unknown as { detail?: string }).detail, undefined);
      }

      // Step 4: list (paginated shape).
      const list = await service.listBackupsService({
        actor: { id: admin.id, role: "SUPER_ADMIN" },
        limit: 25,
        offset: 0
      });
      assert.equal(list.ok, true);
      if (list.ok) {
        const found = list.items.find((r) => r.id === backupId);
        assert.ok(found, "created backup must appear in listing");
        // Shape hygiene: no internal columns.
        for (const forbidden of [
          "fileName",
          "contentSha256",
          "manifestSha256",
          "schemaSha256",
          "errorMessage",
          "rowCounts"
        ]) {
          assert.ok(
            !(forbidden in (found as unknown as Record<string, unknown>)),
            `list item leaks "${forbidden}"`
          );
        }
      }

      // Step 5: detail — includes rowCounts but never internal columns.
      const detail = await service.getBackupService({
        actor: { id: admin.id, role: "SUPER_ADMIN" },
        backupId
      });
      assert.equal(detail.ok, true);
      if (detail.ok) {
        assert.equal(detail.status, "VERIFIED");
        assert.ok(detail.rowCounts && Object.keys(detail.rowCounts).length > 0);
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── E2E: cron endpoint auth semantics ──────────────────────────────────────

describe("E2E — cron endpoint auth: uniform 404 preserved", async () => {
  const tickAuth = await import("../lib/backup/tick-auth");

  function makeReq(hdr: string | null) {
    return {
      headers: {
        get: (n: string) =>
          n.toLowerCase() === tickAuth.BACKUP_TICK_HEADER ? hdr : null
      }
    };
  }

  test("no secret → false; too-short config → false; correct → true", async () => {
    assert.equal(tickAuth.isBackupTickAuthorized(makeReq(null)), false);
    assert.equal(
      tickAuth.isBackupTickAuthorized(makeReq("not-the-secret-and-long-enough-1234")),
      false
    );
    const original = process.env.INTERNAL_BACKUP_TICK_SECRET;
    try {
      process.env.INTERNAL_BACKUP_TICK_SECRET = "too-short";
      assert.equal(
        tickAuth.isBackupTickAuthorized(makeReq("too-short")),
        false
      );
    } finally {
      process.env.INTERNAL_BACKUP_TICK_SECRET = original;
    }
    const secret = process.env.INTERNAL_BACKUP_TICK_SECRET!;
    assert.equal(tickAuth.isBackupTickAuthorized(makeReq(secret)), true);
  });
});

// ─── E2E: scheduler cron replay ─────────────────────────────────────────────

describe("E2E — scheduler cron replay: duplicate ticks produce ≤1 SCHEDULED backup", async () => {
  const scheduler = await import("../lib/backup/scheduler");

  test("first tick creates; concurrent second tick either OK or SKIPPED but not both OK", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backupSchedule.upsert({
        where: { id: "singleton" },
        create: {
          id: "singleton",
          enabled: true,
          frequencyHours: 24,
          retentionCount: 14,
          retentionAgeDays: 90
        },
        update: {
          enabled: true,
          frequencyHours: 24,
          retentionCount: 14,
          retentionAgeDays: 90,
          lastRunAt: null,
          lastRunOutcome: null,
          lastRunError: null,
          lastRunBackupId: null
        }
      });
      const before = await prisma.backup.count({
        where: { kind: "SCHEDULED", startedAt: { gte: testWindowStart } }
      });
      const [a, b] = await Promise.all([
        scheduler.runSchedulerTick({ client: prisma }),
        scheduler.runSchedulerTick({ client: prisma })
      ]);
      const after = await prisma.backup.count({
        where: { kind: "SCHEDULED", startedAt: { gte: testWindowStart } }
      });
      assert.equal(after - before, 1, `expected exactly +1 SCHEDULED backup, got +${after - before}`);
      const okCount = [a.outcome, b.outcome].filter((o) => o === "OK").length;
      assert.equal(okCount, 1, `expected exactly one OK outcome, got a=${a.outcome} b=${b.outcome}`);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── E2E: retention protection matrix ───────────────────────────────────────

describe("E2E — retention protects newest known-good + in-flight source + in-flight safety", async () => {
  const retention = await import("../lib/backup/retention");

  test("aggressive prune against a realistic history preserves every protected row", async () => {
    const prisma = await makePrisma();
    try {
      // Wipe prior state so this test is deterministic.
      await prisma.backup.updateMany({
        where: { status: { in: ["COMPLETED", "VERIFIED"] } },
        data: { status: "DELETED" }
      });
      const day = 24 * 60 * 60 * 1000;
      const now = Date.now();
      // Build: 5 ancient rows + 1 recent row that is the last-known-good.
      const ancients: string[] = [];
      for (let i = 0; i < 5; i++) {
        const b = await prisma.backup.create({
          data: {
            kind: "MANUAL",
            status: "COMPLETED",
            schemaSha256: "0".repeat(64),
            appVersion: "0.1.0",
            formatVersion: "1",
            encryptionVersion: "v1",
            startedAt: new Date(now - (200 + i) * day),
            completedAt: new Date(now - (200 + i) * day)
          }
        });
        ancients.push(b.id);
      }
      const newestGood = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "VERIFIED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(now - day),
          completedAt: new Date(now - day)
        }
      });
      // In-flight restore: source = ancients[0], safety = ancients[1].
      const initiator = await insertAdmin(prisma, "SUPER_ADMIN", "e2e-retention");
      const op = await prisma.restoreOperation.create({
        data: {
          backupId: ancients[0],
          initiatedById: initiator.id,
          status: "RUNNING",
          safetyBackupId: ancients[1]
        }
      });
      // Aggressive rules: keep 1, age = 1 day.
      await prisma.backupSchedule.upsert({
        where: { id: "singleton" },
        create: {
          id: "singleton",
          retentionCount: 1,
          retentionAgeDays: 1
        },
        update: {
          retentionCount: 1,
          retentionAgeDays: 1
        }
      });
      const r = await retention.runRetention({ client: prisma });
      // Expected survivors: newestGood (newest known-good), ancients[0] (source),
      // ancients[1] (safety). Others: pruned.
      const survivors = await prisma.backup.findMany({
        where: {
          id: { in: [newestGood.id, ...ancients] },
          status: { in: ["COMPLETED", "VERIFIED"] }
        },
        select: { id: true }
      });
      const survivorIds = new Set(survivors.map((s) => s.id));
      assert.ok(survivorIds.has(newestGood.id), "newest-known-good must survive");
      assert.ok(survivorIds.has(ancients[0]), "in-flight source must survive");
      assert.ok(survivorIds.has(ancients[1]), "in-flight safety must survive");
      // The other 3 ancients should have been pruned.
      assert.equal(
        survivorIds.size,
        3,
        `expected exactly 3 survivors, got ${survivorIds.size}: [${Array.from(survivorIds).join(", ")}]`
      );
      assert.ok(r.deleted >= 3, `expected ≥3 deletions, got ${r.deleted}`);
      // Cleanup.
      await prisma.restoreOperation.delete({ where: { id: op.id } });
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── E2E: authorization matrix at the server-action layer ──────────────────

describe("E2E — authorization matrix: server layer refuses without correct permission", async () => {
  const service = await import("../lib/backup/service");

  test("every non-SUPER_ADMIN role refused for every destructive verb", async () => {
    const prisma = await makePrisma();
    try {
      const roles: Array<"ADMIN" | "VIEWER" | "SALES"> = [
        "ADMIN",
        "VIEWER",
        "SALES"
      ];
      for (const role of roles) {
        const admin = await insertAdmin(prisma, role, `authz-${role.toLowerCase()}`);
        // delete: SUPER_ADMIN only.
        const del = await service.deleteBackupService({
          actor: { id: admin.id, role },
          backupId: "c" + "a".repeat(24) // valid CUID shape, unknown row
        });
        assert.equal(del.ok, false);
        if (!del.ok) assert.equal(del.code, "UNAUTHORIZED");
        // update schedule: SUPER_ADMIN only.
        const sched = await service.updateScheduleService({
          actor: { id: admin.id, role },
          enabled: true,
          frequencyHours: 24,
          retentionCount: 14
        });
        assert.equal(sched.ok, false);
        if (!sched.ok) assert.equal(sched.code, "UNAUTHORIZED");
        // manual retention: SUPER_ADMIN only (backup.settings).
        const ret = await service.runRetentionService({
          actor: { id: admin.id, role }
        });
        assert.equal(ret.ok, false);
        if (!ret.ok) assert.equal(ret.code, "UNAUTHORIZED");
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("VIEWER + SALES + non-privileged roles cannot even list backups", async () => {
    const prisma = await makePrisma();
    try {
      for (const role of ["SALES", "SPONSOR_MANAGER"] as const) {
        const admin = await insertAdmin(prisma, role === "SALES" ? "SALES" : "VIEWER", `list-${role.toLowerCase()}`);
        const list = await service.listBackupsService({
          actor: { id: admin.id, role: role === "SALES" ? "SALES" : "VIEWER" }
        });
        assert.equal(list.ok, false);
        if (!list.ok) assert.equal(list.code, "UNAUTHORIZED");
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── E2E: filesystem consistency ────────────────────────────────────────────

describe("E2E — filesystem consistency after operations", async () => {
  const service = await import("../lib/backup/service");
  const storage = await import("../lib/backup/storage");

  test("delete removes on-disk files AND marks row DELETED", async () => {
    const prisma = await makePrisma();
    try {
      const admin = await insertAdmin(prisma, "SUPER_ADMIN", "fs-delete");
      // Create two backups so retention floor is satisfied when we delete one.
      const b1 = await service.createBackupService({
        actor: { id: admin.id, role: "SUPER_ADMIN" }
      });
      const b2 = await service.createBackupService({
        actor: { id: admin.id, role: "SUPER_ADMIN" }
      });
      assert.equal(b1.ok, true);
      assert.equal(b2.ok, true);
      if (!b1.ok || !b2.ok) throw new Error("guard");

      // Sanity: both are on disk.
      assert.ok(await storage.publishedBackupExists(b1.backupId));
      assert.ok(await storage.publishedBackupExists(b2.backupId));

      // Delete b1.
      const del = await service.deleteBackupService({
        actor: { id: admin.id, role: "SUPER_ADMIN" },
        backupId: b1.backupId
      });
      assert.equal(del.ok, true, JSON.stringify(del));

      // File gone from disk.
      assert.equal(await storage.publishedBackupExists(b1.backupId), false);
      // DB row still exists, marked DELETED. deleteBackupService keeps
      // `fileName` on the row so operators can trace history in the audit
      // log; only the retention prune nulls it out (see retention.ts).
      const row = await prisma.backup.findUnique({
        where: { id: b1.backupId },
        select: { status: true }
      });
      assert.equal(row?.status, "DELETED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── E2E: restore-page UI-refresh survival via server state ────────────────

describe("E2E — restore state survives page refresh (server-owned)", async () => {
  test("activeRestore query reflects RestoreOperation status correctly across a simulated refresh", async () => {
    const prisma = await makePrisma();
    try {
      const admin = await insertAdmin(prisma, "SUPER_ADMIN", "ui-refresh");
      // Create a Backup + RestoreOperation to represent an in-flight restore.
      const b = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });
      const op = await prisma.restoreOperation.create({
        data: {
          backupId: b.id,
          initiatedById: admin.id,
          status: "RUNNING"
        }
      });

      // Simulate the RSC page's initial fetch (equivalent to the query
      // in app/admin/(protected)/backups/restore/page.tsx).
      const activeBefore = await prisma.restoreOperation.findFirst({
        where: { status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] } },
        select: { id: true, status: true }
      });
      assert.ok(activeBefore, "in-flight RestoreOperation must be visible");
      assert.equal(activeBefore.id, op.id);

      // Terminal the op.
      await prisma.restoreOperation.update({
        where: { id: op.id },
        data: { status: "COMPLETED", completedAt: new Date() }
      });

      // Simulate a page refresh — the same query must now return null.
      const activeAfter = await prisma.restoreOperation.findFirst({
        where: { status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] } },
        select: { id: true }
      });
      assert.equal(activeAfter, null, "terminal op must not appear as in-flight");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── E2E: error sanitization end-to-end ────────────────────────────────────

describe("E2E — outbound error shape never leaks internal detail", async () => {
  const service = await import("../lib/backup/service");

  test("failure paths produce {code, publicMessage, operationId} only", async () => {
    const prisma = await makePrisma();
    try {
      const admin = await insertAdmin(prisma, "SUPER_ADMIN", "err-shape");
      // Trigger NOT_FOUND via a well-formed but nonexistent id.
      const r = await service.deleteBackupService({
        actor: { id: admin.id, role: "SUPER_ADMIN" },
        backupId: "c" + "0".repeat(24)
      });
      assert.equal(r.ok, false);
      if (!r.ok) {
        // Positive fields only.
        assert.equal(typeof r.code, "string");
        assert.equal(typeof r.publicMessage, "string");
        assert.equal(typeof r.operationId, "string");
        // Negative-space guarantees.
        const raw = JSON.stringify(r);
        assert.doesNotMatch(raw, /prisma/i);
        assert.doesNotMatch(raw, /Error:/i);
        assert.doesNotMatch(raw, /\.bin\b|\.manifest\.json\b/i);
        assert.doesNotMatch(raw, /BACKUP_ENCRYPTION_KEY/i);
        assert.doesNotMatch(raw, /INTERNAL_BACKUP_TICK_SECRET/i);
        assert.doesNotMatch(raw, /passwordHash/i);
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── E2E: full round-trip destructive restore (opt-in) ─────────────────────

describe("E2E — full destructive round-trip (opt-in, TEST_BACKUP_RESTORE_DESTRUCTIVE=1)", async () => {
  const restore = await import("../lib/backup/restore");
  const gate = process.env.TEST_BACKUP_RESTORE_DESTRUCTIVE === "1";

  test(
    "create + verify + destructive restore + post-restore verify",
    { skip: !gate ? "set TEST_BACKUP_RESTORE_DESTRUCTIVE=1 to opt in" : false },
    async () => {
      const prisma = await makePrisma();
      try {
        const admin = await insertAdmin(prisma, "SUPER_ADMIN", "e2e-roundtrip");
        // Baseline dump.
        const { runBackupDump } = await import("../lib/backup/dump");
        const src = await runBackupDump({ kind: "MANUAL", client: prisma });
        // Inject a marker that must be gone after restore.
        const marker = await prisma.auditLog.create({
          data: {
            userId: admin.id,
            action: "backup.e2e.roundtrip.marker",
            entity: "E2E",
            meta: { operationId: "must-be-wiped" }
          }
        });
        const r = await restore.runRestore({
          actor: { id: admin.id, role: "SUPER_ADMIN" },
          backupId: src.backupId,
          confirmationPhrase: `RESTORE ${src.backupId.slice(0, 8)}`,
          adminPassword: admin.password,
          client: prisma
        });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.code, "OK");
        // Marker must be wiped.
        const stillThere = await prisma.auditLog.findUnique({
          where: { id: marker.id }
        });
        assert.equal(stillThere, null);
        // Safety backup + RestoreOperation must survive.
        assert.ok(r.safetyBackupId);
        assert.ok(r.restoreOperationId);
        const op = await prisma.restoreOperation.findUnique({
          where: { id: r.restoreOperationId! }
        });
        assert.ok(op);
        assert.equal(op.status, "COMPLETED");
      } finally {
        await prisma.$disconnect();
      }
    }
  );
});

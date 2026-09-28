// Tests for lib/backup/scheduler.ts + lib/backup/retention.ts +
// app/api/internal/backup/tick/route.ts. Run with:
//   npm run test:backup-scheduler
//
// Everything runs against the real dev Postgres. Rows created by this
// test are windowed by `testWindowStart` and cleaned up in `after`.

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

async function insertTestAdmin(
  prisma: InstanceType<PrismaModule["PrismaClient"]>,
  role: "SUPER_ADMIN" | "ADMIN" | "VIEWER",
  tag: string
): Promise<string> {
  const { hashPassword } = await import("../lib/admin/password");
  const email = `sched-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@bis.dz`;
  const admin = await prisma.adminUser.create({
    data: {
      email,
      name: `Scheduler ${tag}`,
      passwordHash: hashPassword("test-only-do-not-use"),
      role,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  return admin.id;
}

// Ensure the BackupSchedule singleton is in a known state at the top of
// each test. Tests use `manual: true` where they want to bypass the
// enabled+due gates.
async function resetSchedule(
  prisma: InstanceType<PrismaModule["PrismaClient"]>,
  patch: Partial<{
    enabled: boolean;
    frequencyHours: number;
    retentionCount: number;
    retentionAgeDays: number;
    lastRunAt: Date | null;
    lastRunOutcome: string | null;
    lastRunError: string | null;
    lastRunBackupId: string | null;
  }> = {}
): Promise<void> {
  await prisma.backupSchedule.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      enabled: false,
      frequencyHours: 24,
      retentionCount: 14,
      retentionAgeDays: 90,
      ...patch
    },
    update: {
      enabled: false,
      frequencyHours: 24,
      retentionCount: 14,
      retentionAgeDays: 90,
      lastRunAt: null,
      lastRunOutcome: null,
      lastRunError: null,
      lastRunBackupId: null,
      ...patch
    }
  });
}

before(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  process.env.INTERNAL_BACKUP_TICK_SECRET = randomBytes(32).toString("base64url");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bis-sched-"));
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
      where: { email: { startsWith: "sched-" } }
    });
    // Reset schedule so subsequent test runs are deterministic.
    await prisma.backupSchedule.deleteMany({}).catch(() => undefined);
  } finally {
    await prisma.$disconnect();
  }
  for (const dir of scratchRoots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ─── Scheduler tick — outcome matrix ────────────────────────────────────────

describe("scheduler tick — outcome matrix", async () => {
  const scheduler = await import("../lib/backup/scheduler");

  test("SKIPPED_DISABLED when schedule.enabled=false (non-manual)", async () => {
    const prisma = await makePrisma();
    try {
      await resetSchedule(prisma, { enabled: false });
      const r = await scheduler.runSchedulerTick({ client: prisma });
      assert.equal(r.outcome, "SKIPPED_DISABLED");
      const s = await prisma.backupSchedule.findUnique({
        where: { id: "singleton" }
      });
      // A disabled tick still records lastRunAt so cron replay is idempotent.
      assert.ok(s?.lastRunAt);
      assert.equal(s?.lastRunOutcome, "SKIPPED_DISABLED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("SKIPPED_NOT_DUE when lastRunAt is within frequency window", async () => {
    const prisma = await makePrisma();
    try {
      const recent = new Date(Date.now() - 60 * 1000); // 1 min ago
      await resetSchedule(prisma, {
        enabled: true,
        frequencyHours: 24,
        lastRunAt: recent
      });
      const r = await scheduler.runSchedulerTick({ client: prisma });
      assert.equal(r.outcome, "SKIPPED_NOT_DUE");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("SKIPPED_ACTIVE when a backup is currently PENDING/RUNNING", async () => {
    const prisma = await makePrisma();
    try {
      await resetSchedule(prisma, { enabled: true });
      const blocker = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "RUNNING",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });
      try {
        const r = await scheduler.runSchedulerTick({ client: prisma });
        assert.equal(r.outcome, "SKIPPED_ACTIVE");
      } finally {
        await prisma.backup.delete({ where: { id: blocker.id } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("SKIPPED_ACTIVE when a restore is in flight", async () => {
    const prisma = await makePrisma();
    try {
      await resetSchedule(prisma, { enabled: true });
      // Need a real Backup row for the FK.
      const src = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });
      const initiator = await insertTestAdmin(prisma, "SUPER_ADMIN", "restore-blocker");
      const op = await prisma.restoreOperation.create({
        data: {
          backupId: src.id,
          initiatedById: initiator,
          status: "RUNNING"
        }
      });
      try {
        const r = await scheduler.runSchedulerTick({ client: prisma });
        assert.equal(r.outcome, "SKIPPED_ACTIVE");
      } finally {
        await prisma.restoreOperation.delete({ where: { id: op.id } });
        await prisma.backup.delete({ where: { id: src.id } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("manual=true bypasses NOT_DUE (still refuses concurrent backup)", async () => {
    const prisma = await makePrisma();
    try {
      const recent = new Date(Date.now() - 60 * 1000);
      await resetSchedule(prisma, {
        enabled: true,
        frequencyHours: 24,
        lastRunAt: recent
      });
      const r = await scheduler.runSchedulerTick({
        client: prisma,
        manual: true
      });
      // Manual tick actually runs the dump against real Postgres.
      assert.equal(r.outcome, "OK", JSON.stringify(r));
      assert.ok(r.backupId);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Watchdog: reconciles a schedule stuck at RUNNING ───────────────────────

describe("scheduler tick — watchdog reconciliation (security-review MEDIUM fix)", async () => {
  const scheduler = await import("../lib/backup/scheduler");

  test("row stuck at lastRunOutcome=RUNNING for > timeout is reset before contention", async () => {
    const prisma = await makePrisma();
    try {
      // Simulate a prior tick that recorded RUNNING and then crashed 4h ago.
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
      await resetSchedule(prisma, {
        enabled: true,
        frequencyHours: 24,
        lastRunAt: fourHoursAgo,
        lastRunOutcome: "RUNNING"
      });
      const r = await scheduler.runSchedulerTick({ client: prisma });
      const after = await prisma.backupSchedule.findUnique({
        where: { id: "singleton" }
      });
      // Regardless of the current tick's outcome, the stuck row must
      // NOT still be RUNNING with the ancient lastRunAt.
      assert.notEqual(after?.lastRunOutcome, "RUNNING");
      // If it went through as OK the new tick advanced things; if it
      // was SKIPPED_NOT_DUE the watchdog still flipped the RUNNING flag
      // to FAILED_INTERNAL_STUCK BEFORE the due check. Either way, an
      // audit row must record the reconciliation.
      const reconciled = await prisma.auditLog.findFirst({
        where: {
          action: "backup.scheduler.watchdog.reconciled",
          entity: "BackupSchedule",
          createdAt: { gte: testWindowStart }
        },
        orderBy: { createdAt: "desc" }
      });
      assert.ok(reconciled, "watchdog reconciliation audit row missing");
      void r;
    } finally {
      await prisma.$disconnect();
    }
  });

  test("a fresh RUNNING row (within timeout) is NOT reconciled", async () => {
    const prisma = await makePrisma();
    try {
      // A tick that started 5 minutes ago — still within the 3h ceiling.
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      await resetSchedule(prisma, {
        enabled: true,
        frequencyHours: 24,
        lastRunAt: fiveMinAgo,
        lastRunOutcome: "RUNNING"
      });
      // Snapshot the reconciled-audit count.
      const before = await prisma.auditLog.count({
        where: {
          action: "backup.scheduler.watchdog.reconciled",
          createdAt: { gte: testWindowStart }
        }
      });
      await scheduler.runSchedulerTick({ client: prisma });
      const after = await prisma.auditLog.count({
        where: {
          action: "backup.scheduler.watchdog.reconciled",
          createdAt: { gte: testWindowStart }
        }
      });
      // No NEW watchdog reconciliation row was written this run.
      assert.equal(after, before);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Duplicate cron replay ──────────────────────────────────────────────────

describe("scheduler tick — duplicate cron replay is idempotent", async () => {
  const scheduler = await import("../lib/backup/scheduler");

  test("two back-to-back ticks produce at most ONE scheduled backup", async () => {
    const prisma = await makePrisma();
    try {
      await resetSchedule(prisma, {
        enabled: true,
        frequencyHours: 24,
        lastRunAt: null
      });
      const before = await prisma.backup.count({
        where: { kind: "SCHEDULED", startedAt: { gte: testWindowStart } }
      });
      const first = await scheduler.runSchedulerTick({ client: prisma });
      const second = await scheduler.runSchedulerTick({ client: prisma });
      const after = await prisma.backup.count({
        where: { kind: "SCHEDULED", startedAt: { gte: testWindowStart } }
      });
      // Exactly one new SCHEDULED backup was created between the two ticks.
      assert.equal(after - before, 1, `expected +1 scheduled backup, got +${after - before}`);
      // First tick either OK (created the backup) or SKIPPED_LOCKED (lost
      // the advisory lock race). Second tick MUST NOT be OK a second time.
      assert.ok(
        (first.outcome === "OK" && second.outcome !== "OK") ||
          (second.outcome === "OK" && first.outcome !== "OK"),
        `outcomes: first=${first.outcome}, second=${second.outcome}`
      );
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Retention ──────────────────────────────────────────────────────────────

describe("retention — protection rules", async () => {
  const retention = await import("../lib/backup/retention");

  test("newest COMPLETED backup is ALWAYS protected", async () => {
    const prisma = await makePrisma();
    try {
      // Make sure there's exactly one COMPLETED row.
      await prisma.backup.updateMany({
        where: { status: { in: ["COMPLETED", "VERIFIED"] } },
        data: { status: "DELETED" }
      });
      const newest = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), // 200d ago
          completedAt: new Date()
        }
      });
      // Force aggressive retention (retentionCount=1, age=1d).
      await resetSchedule(prisma, {
        retentionCount: 1,
        retentionAgeDays: 1
      });
      await retention.runRetention({ client: prisma });
      // The single COMPLETED row must remain COMPLETED — it is inside
      // the newest-N retained-count set so retention must never touch it.
      const still = await prisma.backup.findUnique({
        where: { id: newest.id },
        select: { status: true }
      });
      assert.equal(still?.status, "COMPLETED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("safety-floor: never leave the DB without a COMPLETED/VERIFIED row", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backup.updateMany({
        where: { status: { in: ["COMPLETED", "VERIFIED"] } },
        data: { status: "DELETED" }
      });
      // Two ancient COMPLETED rows. retentionCount=1 puts one outside the
      // retained set; retentionAgeDays=1 says both are too old. Even so
      // the safety-floor guard must keep at least one.
      const bA = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
          completedAt: new Date()
        }
      });
      const bB = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(Date.now() - 300 * 24 * 60 * 60 * 1000),
          completedAt: new Date()
        }
      });
      await resetSchedule(prisma, {
        retentionCount: 1,
        retentionAgeDays: 1
      });
      await retention.runRetention({ client: prisma });
      const remaining = await prisma.backup.count({
        where: {
          id: { in: [bA.id, bB.id] },
          status: { in: ["COMPLETED", "VERIFIED"] }
        }
      });
      assert.ok(remaining >= 1, `safety floor violated: remaining=${remaining}`);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("in-flight restore protects its source AND safety backup", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backup.updateMany({
        where: { status: { in: ["COMPLETED", "VERIFIED"] } },
        data: { status: "DELETED" }
      });
      // A newest known-good so the safety-floor guard is satisfied.
      await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(),
          completedAt: new Date()
        }
      });
      const source = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000),
          completedAt: new Date()
        }
      });
      const safety = await prisma.backup.create({
        data: {
          kind: "SAFETY",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000),
          completedAt: new Date()
        }
      });
      const initiator = await insertTestAdmin(prisma, "SUPER_ADMIN", "ret-flight");
      const op = await prisma.restoreOperation.create({
        data: {
          backupId: source.id,
          initiatedById: initiator,
          status: "RUNNING",
          safetyBackupId: safety.id
        }
      });
      await resetSchedule(prisma, {
        retentionCount: 1,
        retentionAgeDays: 1
      });
      await retention.runRetention({ client: prisma });
      const sourceAfter = await prisma.backup.findUnique({
        where: { id: source.id },
        select: { status: true }
      });
      const safetyAfter = await prisma.backup.findUnique({
        where: { id: safety.id },
        select: { status: true }
      });
      assert.equal(sourceAfter?.status, "COMPLETED", "in-flight restore source must survive");
      assert.equal(safetyAfter?.status, "COMPLETED", "in-flight safety must survive");
      // Cleanup.
      await prisma.restoreOperation.delete({ where: { id: op.id } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("age rule alone does not prune if outside retention count", async () => {
    const prisma = await makePrisma();
    try {
      await prisma.backup.updateMany({
        where: { status: { in: ["COMPLETED", "VERIFIED"] } },
        data: { status: "DELETED" }
      });
      // With retentionCount=5 and only 1 row, that row is inside the
      // count-retained set even if it's ancient — so no prune.
      const row = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "COMPLETED",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          startedAt: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000),
          completedAt: new Date()
        }
      });
      await resetSchedule(prisma, {
        retentionCount: 5,
        retentionAgeDays: 30
      });
      await retention.runRetention({ client: prisma });
      const still = await prisma.backup.findUnique({
        where: { id: row.id },
        select: { status: true }
      });
      assert.equal(still?.status, "COMPLETED");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── External cron endpoint — authentication helper ─────────────────────────
//
// The route file imports `next/server`, which pulls the React "shared-subset"
// build that a plain Node test loader cannot resolve. We test the extracted
// `isBackupTickAuthorized` helper directly — it is the only security-sensitive
// portion of the route. The route wrapper is a 4-line if/else adapter over it.

describe("backup tick endpoint — authentication helper", async () => {
  const tickAuth = await import("../lib/backup/tick-auth");

  function makeReq(headerValue: string | null): {
    headers: { get: (name: string) => string | null };
  } {
    return {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === tickAuth.BACKUP_TICK_HEADER
            ? headerValue
            : null
      }
    };
  }

  test("missing secret → false", async () => {
    assert.equal(tickAuth.isBackupTickAuthorized(makeReq(null)), false);
  });

  test("wrong secret → false (no enumeration)", async () => {
    assert.equal(
      tickAuth.isBackupTickAuthorized(makeReq("definitely-not-the-secret-abcdef01234")),
      false
    );
  });

  test("empty string secret → false", async () => {
    assert.equal(tickAuth.isBackupTickAuthorized(makeReq("")), false);
  });

  test("correct secret → true", async () => {
    const secret = process.env.INTERNAL_BACKUP_TICK_SECRET!;
    assert.equal(tickAuth.isBackupTickAuthorized(makeReq(secret)), true);
  });

  test("config error (secret unset or too short) → false", async () => {
    const original = process.env.INTERNAL_BACKUP_TICK_SECRET;
    try {
      // Too short.
      process.env.INTERNAL_BACKUP_TICK_SECRET = "too-short";
      assert.equal(tickAuth.isBackupTickAuthorized(makeReq("too-short")), false);
      // Missing entirely.
      delete process.env.INTERNAL_BACKUP_TICK_SECRET;
      assert.equal(tickAuth.isBackupTickAuthorized(makeReq("anything")), false);
    } finally {
      process.env.INTERNAL_BACKUP_TICK_SECRET = original;
    }
  });
});

// Tests for lib/backup/service.ts — the Phase 6 RBAC/audit/sanitization
// layer. Run with:
//   npm run test:backup-rbac
//
// The service layer is the actual security boundary for backup ops. The
// server-action wrappers under app/admin/(protected)/backups/actions.ts
// only add a `requirePermission(...)` gate on top; we cannot invoke those
// from a plain Node test (no cookies / Next runtime), so we exercise the
// service directly with synthetic `actor: { id, role }` values.
//
// Every mutating service function:
//   1. Rejects an actor without the correct permission (UNAUTHORIZED).
//   2. Validates input via zod (INVALID_INPUT).
//   3. Refuses invalid state transitions (STATE_CONFLICT).
//   4. Writes an audit row on both success and failure paths.
//   5. Never leaks internal error text — only `code` + `publicMessage`
//      + `operationId` come back.

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

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

async function insertTestAdmin(
  prisma: InstanceType<PrismaModule["PrismaClient"]>,
  emailTag: string,
  role: "SUPER_ADMIN" | "ADMIN" | "REGISTRATION_MANAGER" | "VIEWER"
): Promise<string> {
  const { hashPassword } = await import("../lib/admin/password");
  const email = `backup-rbac-test-${emailTag}-${Date.now()}-${Math.random().toString(36).slice(2)}@bis.dz`;
  const admin = await prisma.adminUser.create({
    data: {
      email,
      name: `Backup RBAC ${emailTag}`,
      passwordHash: hashPassword("test-only-do-not-use"),
      role,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  return admin.id;
}

before(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bis-backup-rbac-"));
  process.env.BACKUP_STORAGE_DIR = tmp;
  scratchRoots.push(tmp);
  testWindowStart = new Date();
});

after(async () => {
  const prisma = await makePrisma();
  try {
    // Best-effort cleanup — only rows touched by this test.
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
      where: { email: { startsWith: "backup-rbac-test-" } }
    });
    await prisma.backupSchedule.deleteMany({}).catch(() => undefined);
  } finally {
    await prisma.$disconnect();
  }
  for (const dir of scratchRoots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ─── Authorization matrix ────────────────────────────────────────────────────

describe("service — authorization matrix", async () => {
  const service = await import("../lib/backup/service");

  test("VIEWER cannot create a backup → UNAUTHORIZED", async () => {
    const prisma = await makePrisma();
    try {
      const viewerId = await insertTestAdmin(prisma, "authz-viewer", "VIEWER");
      const r = await service.createBackupService({
        actor: { id: viewerId, role: "VIEWER" }
      });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, "UNAUTHORIZED");
        assert.equal(typeof r.publicMessage, "string");
        assert.equal(typeof r.operationId, "string");
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("ADMIN cannot delete a backup (destructive) → UNAUTHORIZED", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "authz-admin", "ADMIN");
      const r = await service.deleteBackupService({
        actor: { id: adminId, role: "ADMIN" },
        backupId: makeCuid()
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "UNAUTHORIZED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("ADMIN cannot change backup schedule → UNAUTHORIZED", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "authz-admin-sched", "ADMIN");
      const r = await service.updateScheduleService({
        actor: { id: adminId, role: "ADMIN" },
        enabled: true,
        frequencyHours: 24,
        retentionCount: 14
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "UNAUTHORIZED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("ADMIN can create + verify a backup (baseline permissions)", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "authz-admin-create", "ADMIN");
      const create = await service.createBackupService({
        actor: { id: adminId, role: "ADMIN" }
      });
      assert.equal(create.ok, true, JSON.stringify(create));
      if (!create.ok) throw new Error("guard");
      const verify = await service.verifyBackupService({
        actor: { id: adminId, role: "ADMIN" },
        backupId: create.backupId
      });
      assert.equal(verify.ok, true, JSON.stringify(verify));
      if (verify.ok) assert.equal(verify.outcome, "VERIFIED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("SUPER_ADMIN can perform every backup verb", async () => {
    const prisma = await makePrisma();
    try {
      const superId = await insertTestAdmin(prisma, "authz-super", "SUPER_ADMIN");
      const create = await service.createBackupService({
        actor: { id: superId, role: "SUPER_ADMIN" }
      });
      assert.equal(create.ok, true);
      if (!create.ok) throw new Error("guard");
      const sched = await service.updateScheduleService({
        actor: { id: superId, role: "SUPER_ADMIN" },
        enabled: false,
        frequencyHours: 24,
        retentionCount: 14
      });
      assert.equal(sched.ok, true);
      // Note: deletion of the just-created backup would violate the
      // retention floor (=1) since this is often the only backup. Skip
      // here — retention-floor guard is tested separately below.
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Input validation / IDOR ─────────────────────────────────────────────────

describe("service — input validation & IDOR", async () => {
  const service = await import("../lib/backup/service");

  test("verify with malformed backupId → INVALID_INPUT (no auth bypass)", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "iod-a", "ADMIN");
      const r = await service.verifyBackupService({
        actor: { id: adminId, role: "ADMIN" },
        backupId: "../../etc/passwd"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "INVALID_INPUT");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("verify with well-formed but nonexistent id → verify persists FAILED, but service returns ok=true with outcome FAILED", async () => {
    // We verify a synthesized valid cuid that has no matching row nor file.
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "iod-b", "ADMIN");
      const r = await service.verifyBackupService({
        actor: { id: adminId, role: "ADMIN" },
        backupId: makeCuid()
      });
      assert.equal(r.ok, true, "service call succeeds structurally");
      if (r.ok) {
        assert.equal(r.outcome, "FAILED");
        assert.equal(r.code, "STORAGE_MISSING");
        assert.equal(r.stage, "STORAGE_IDENTITY");
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("get with unknown id → NOT_FOUND (never leaks existence of unrelated rows)", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "iod-c", "ADMIN");
      const r = await service.getBackupService({
        actor: { id: adminId, role: "ADMIN" },
        backupId: makeCuid()
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "NOT_FOUND");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("delete with malformed backupId → INVALID_INPUT before any DB read", async () => {
    const prisma = await makePrisma();
    try {
      const superId = await insertTestAdmin(prisma, "iod-d", "SUPER_ADMIN");
      const r = await service.deleteBackupService({
        actor: { id: superId, role: "SUPER_ADMIN" },
        backupId: "c/../../root"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "INVALID_INPUT");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("updateSchedule refuses out-of-range values → INVALID_INPUT", async () => {
    const prisma = await makePrisma();
    try {
      const superId = await insertTestAdmin(prisma, "iod-e", "SUPER_ADMIN");
      const r1 = await service.updateScheduleService({
        actor: { id: superId, role: "SUPER_ADMIN" },
        enabled: true,
        frequencyHours: 0, // < 1
        retentionCount: 14
      });
      assert.equal(r1.ok, false);
      if (!r1.ok) assert.equal(r1.code, "INVALID_INPUT");

      const r2 = await service.updateScheduleService({
        actor: { id: superId, role: "SUPER_ADMIN" },
        enabled: true,
        frequencyHours: 24,
        retentionCount: 0 // < 1
      });
      assert.equal(r2.ok, false);
      if (!r2.ok) assert.equal(r2.code, "INVALID_INPUT");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── State transitions ──────────────────────────────────────────────────────

describe("service — state transition guards", async () => {
  const service = await import("../lib/backup/service");

  test("delete refuses when a backup is PENDING → STATE_CONFLICT", async () => {
    const prisma = await makePrisma();
    try {
      const superId = await insertTestAdmin(prisma, "state-a", "SUPER_ADMIN");
      // Directly create a row in PENDING to simulate a mid-dump race.
      const b = await prisma.backup.create({
        data: {
          kind: "MANUAL",
          status: "PENDING",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        },
        select: { id: true }
      });
      const r = await service.deleteBackupService({
        actor: { id: superId, role: "SUPER_ADMIN" },
        backupId: b.id
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "STATE_CONFLICT");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("delete refuses when it would violate retention floor of 1 → STATE_CONFLICT", async () => {
    const prisma = await makePrisma();
    try {
      const superId = await insertTestAdmin(prisma, "state-b", "SUPER_ADMIN");
      // Ensure at most one COMPLETED backup remains by leaving only this one.
      // We simulate the floor by counting: if the current DB has more than
      // one COMPLETED backup, this test's assertion could pass or fail
      // depending. So we assert the shape: creating one, then trying to
      // delete it must return STATE_CONFLICT if this is the ONLY completed.
      await prisma.backup.deleteMany({
        where: { startedAt: { gte: testWindowStart } }
      });
      const create = await service.createBackupService({
        actor: { id: superId, role: "SUPER_ADMIN" }
      });
      assert.equal(create.ok, true);
      if (!create.ok) throw new Error("guard");

      // Determine how many COMPLETED/VERIFIED backups exist overall.
      const completed = await prisma.backup.count({
        where: { status: { in: ["COMPLETED", "VERIFIED"] } }
      });
      const r = await service.deleteBackupService({
        actor: { id: superId, role: "SUPER_ADMIN" },
        backupId: create.backupId
      });
      if (completed === 1) {
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, "STATE_CONFLICT");
      } else {
        // Environment has other completed backups — floor is not violated.
        // The delete should succeed.
        assert.equal(r.ok, true);
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("concurrent create refused with IN_PROGRESS_CONFLICT", async () => {
    const prisma = await makePrisma();
    try {
      const superId = await insertTestAdmin(prisma, "state-c", "SUPER_ADMIN");
      // Inject a PENDING/RUNNING row to simulate a concurrent dump.
      const b = await prisma.backup.create({
        data: {
          kind: "SCHEDULED",
          status: "RUNNING",
          schemaSha256: "0".repeat(64),
          appVersion: "0.1.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });
      const r = await service.createBackupService({
        actor: { id: superId, role: "SUPER_ADMIN" }
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "IN_PROGRESS_CONFLICT");
      // Cleanup the injected row.
      await prisma.backup.delete({ where: { id: b.id } });
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Error sanitization ─────────────────────────────────────────────────────

describe("service — error sanitization (LOW-1 from Phase 5)", async () => {
  const service = await import("../lib/backup/service");

  test("failure result never contains raw Prisma or internal message", async () => {
    const prisma = await makePrisma();
    try {
      const superId = await insertTestAdmin(prisma, "sanit-a", "SUPER_ADMIN");
      const r = await service.deleteBackupService({
        actor: { id: superId, role: "SUPER_ADMIN" },
        backupId: makeCuid() // does not exist
      });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, "NOT_FOUND");
        // publicMessage must be one of the French static messages,
        // never a raw exception text or path.
        assert.doesNotMatch(r.publicMessage, /Error:/);
        assert.doesNotMatch(r.publicMessage, /Prisma/);
        assert.doesNotMatch(r.publicMessage, /\/|\\/);
        assert.equal(typeof r.operationId, "string");
        assert.match(r.operationId, /^[0-9a-f-]{36}$/);
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("verify returned shape never carries the internal `detail` string", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "sanit-b", "ADMIN");
      // Verify a missing file — verifier will produce STORAGE_MISSING
      // with `detail: "published .bin file does not exist"`. Service
      // must strip `detail` from the outbound shape.
      const r = await service.verifyBackupService({
        actor: { id: adminId, role: "ADMIN" },
        backupId: makeCuid()
      });
      assert.equal(r.ok, true);
      if (r.ok) {
        // Shape check: only these fields, no `detail`.
        const keys = Object.keys(r).sort();
        assert.deepEqual(
          keys.filter((k) => k !== "contentSha256" && k !== "totalRows" && k !== "schemaCompatible"),
          ["code", "ok", "operationId", "outcome", "stage"].sort()
        );
        assert.equal((r as unknown as { detail?: string }).detail, undefined);
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Audit logging ──────────────────────────────────────────────────────────

describe("service — audit logging on success and failure", async () => {
  const service = await import("../lib/backup/service");

  test("successful create writes backup.create.request + backup.create.success rows", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "audit-a", "ADMIN");
      // Snapshot audit count for this actor before op.
      const before = await prisma.auditLog.count({
        where: { userId: adminId, action: { startsWith: "backup." } }
      });
      const r = await service.createBackupService({
        actor: { id: adminId, role: "ADMIN" }
      });
      assert.equal(r.ok, true);
      const after = await prisma.auditLog.findMany({
        where: { userId: adminId, action: { startsWith: "backup." } },
        orderBy: { createdAt: "asc" }
      });
      assert.ok(after.length >= before + 2, `expected >=2 new rows, got ${after.length - before}`);
      const actions = after.map((a) => a.action);
      assert.ok(actions.includes("backup.create.request"));
      assert.ok(actions.includes("backup.create.success"));

      // The success row's entityId must be the created backupId.
      if (r.ok) {
        const success = after.find(
          (a) => a.action === "backup.create.success" && a.entityId === r.backupId
        );
        assert.ok(success, "success audit row missing or wrong entityId");
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("unauthorized attempt writes an audit row (with errorCode=UNAUTHORIZED)", async () => {
    const prisma = await makePrisma();
    try {
      const viewerId = await insertTestAdmin(prisma, "audit-b", "VIEWER");
      const r = await service.deleteBackupService({
        actor: { id: viewerId, role: "VIEWER" },
        backupId: makeCuid()
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "UNAUTHORIZED");

      // Assert the failure audit row was written.
      const row = await prisma.auditLog.findFirst({
        where: { userId: viewerId, action: "backup.delete.failure" },
        orderBy: { createdAt: "desc" }
      });
      assert.ok(row, "expected audit row for unauthorized delete attempt");
      const meta = row.meta as { errorCode?: string; operationId?: string };
      assert.equal(meta.errorCode, "UNAUTHORIZED");
      assert.equal(typeof meta.operationId, "string");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("verify.result audit row includes outcome and code", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "audit-c", "ADMIN");
      // Verify a nonexistent backup — should produce FAILED / STORAGE_MISSING.
      const backupId = makeCuid();
      await service.verifyBackupService({
        actor: { id: adminId, role: "ADMIN" },
        backupId
      });
      const row = await prisma.auditLog.findFirst({
        where: {
          userId: adminId,
          action: "backup.verify.result",
          entityId: backupId
        },
        orderBy: { createdAt: "desc" }
      });
      assert.ok(row, "expected verify.result audit row");
      const meta = row.meta as { outcome?: string; code?: string };
      assert.equal(meta.outcome, "FAILED");
      assert.equal(meta.code, "STORAGE_MISSING");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Public-shape hygiene ───────────────────────────────────────────────────

describe("service — public shapes hide internal fields", async () => {
  const service = await import("../lib/backup/service");

  test("list result excludes fileName / contentSha256 / manifestSha256 / errorMessage", async () => {
    const prisma = await makePrisma();
    try {
      const adminId = await insertTestAdmin(prisma, "shape-a", "ADMIN");
      // Ensure at least one backup exists.
      await service.createBackupService({ actor: { id: adminId, role: "ADMIN" } });
      const r = await service.listBackupsService({
        actor: { id: adminId, role: "ADMIN" },
        limit: 5,
        offset: 0
      });
      assert.equal(r.ok, true);
      if (r.ok && r.items.length > 0) {
        const keys = Object.keys(r.items[0]).sort();
        for (const forbidden of [
          "fileName",
          "contentSha256",
          "manifestSha256",
          "schemaSha256",
          "rowCounts",
          "errorMessage",
          "schemaPrisma"
        ]) {
          assert.ok(!keys.includes(forbidden), `list item leaks "${forbidden}"`);
        }
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

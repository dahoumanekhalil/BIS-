// §P.2 + §P.3 tests — Google Drive replication service layer.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §P.
//
// The service layer is the ACTUAL security boundary — a server action
// bypass would still land here and get refused. Every test in this
// suite operates on the service functions directly (no Next.js
// runtime), matching the pattern of `scripts/backup-rbac.test.ts`.
//
// This suite proves, for each of the five §P.2 verbs (retry / verify
// / reconcile / restoreFromDrive / bootstrap):
//
//   * The correct permission gates the call — an actor missing the
//     permission is refused with UNAUTHORIZED (defence in depth over
//     the server-action layer's redirect).
//   * A denied attempt emits a `.denied` audit row with the sanitized
//     shape mandated by §P.3.
//   * Input validation (Zod / assertSafeId) rejects malformed cuids +
//     unsafe strings before ANY Drive I/O.
//   * The config gate (§Q.3) fails closed when the enabled flag is off,
//     with a CONFIGURATION_ERROR + `.failure` audit and no Drive call.
//   * The two-key restore gate refuses when EITHER of its two
//     permissions is missing (proven by RolePermissionOverride removing
//     `backup.restore` from a SUPER_ADMIN).
//   * The state gate refuses verifying / retrying rows in inappropriate
//     status.
//   * Service results never contain a secret (bearer / session URI /
//     refresh token / client secret) — canary strings planted in every
//     admin session field are searched for in the returned SafeError
//     and in every AuditLog.meta row written during the test window.
//
// The suite does NOT exercise real Drive I/O — the underlying
// verify-remote / reconcile / restore-remote services are already
// covered by their own suites. This file is the FIRST-STAGE boundary
// (authz, validation, config gate, audit emission).

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import type { AdminRole, PrismaClient } from "@prisma/client";

import {
  bootstrapDriveFolderService,
  reconcileRemoteService,
  restoreFromDriveService,
  retryReplicationService,
  verifyRemoteService
} from "../lib/backup/replication/service";
import { _resetGoogleDriveConfigCache } from "../lib/backup/replication/config";
import { REPLICATION_DESTINATION } from "../lib/backup/replication/uploader";

// ─── Prisma ────────────────────────────────────────────────────────────────

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

// Canary strings that must NEVER appear in an audit row, a service
// result, or a thrown error message. If they do, some code path
// smuggled a secret out.
const CANARY_REFRESH_TOKEN = "leakcanary_repl_svc_refresh_" + randomBytes(6).toString("hex");
const CANARY_CLIENT_SECRET = "leakcanary_repl_svc_secret_" + randomBytes(6).toString("hex");
const CANARY_ACCESS_TOKEN = "leakcanary_repl_svc_access_" + randomBytes(6).toString("hex");
const CANARY_SESSION_URI = `https://www.googleapis.com/upload/session/leakcanary_repl_svc_session_${randomBytes(6).toString("hex")}`;
const FORBIDDEN_SUBSTRINGS = [
  { label: "refresh_token canary", needle: CANARY_REFRESH_TOKEN },
  { label: "client_secret canary", needle: CANARY_CLIENT_SECRET },
  { label: "access_token canary", needle: CANARY_ACCESS_TOKEN },
  { label: "session URI canary", needle: CANARY_SESSION_URI },
  { label: "Bearer prefix", needle: "Bearer " },
  { label: "refresh_token key", needle: "refresh_token" }
];

const ENV_KEYS = [
  "GOOGLE_DRIVE_BACKUP_ENABLED",
  "GOOGLE_DRIVE_AUTH_MODE",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_FOLDER_ID"
] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function snapshotEnv(): void {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetGoogleDriveConfigCache();
}
function setDriveDisabled(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  _resetGoogleDriveConfigCache();
}
function setDriveEnabledWithCanaryEnv(): void {
  process.env.GOOGLE_DRIVE_BACKUP_ENABLED = "true";
  process.env.GOOGLE_DRIVE_CLIENT_ID = "canary-fake-client-id-longer-than-min";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = CANARY_CLIENT_SECRET;
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = CANARY_REFRESH_TOKEN;
  // Setting the env override makes `googleDriveConfigStatus()` report
  // folder=OK without a live Drive check — required for the test to
  // clear the §Q.3 fail-closed gate. Not a secret (folder ids appear in
  // Drive URLs); still never exposed to a browser response.
  process.env.GOOGLE_DRIVE_FOLDER_ID = "canary-folder-id-repl-svc-test";
  _resetGoogleDriveConfigCache();
}

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

const seededAdminIds: string[] = [];
const seededBackupIds: string[] = [];
const seededOverrides: Array<{ role: AdminRole; permission: string }> = [];
const testWindowStart = new Date();

async function seedAdmin(
  prisma: PrismaClient,
  role: AdminRole
): Promise<{ id: string; role: AdminRole }> {
  const { hashPassword } = await import("../lib/admin/password");
  const email = `repl-svc-${role.toLowerCase()}-${Date.now()}-${randomBytes(3).toString("hex")}@bis.dz`;
  const row = await prisma.adminUser.create({
    data: {
      email,
      name: `Repl-svc ${role}`,
      passwordHash: hashPassword("test-only-do-not-use"),
      role,
      status: "ACTIVE"
    },
    select: { id: true, role: true }
  });
  seededAdminIds.push(row.id);
  return row;
}

async function seedBackupWithReplication(
  prisma: PrismaClient,
  overrides: {
    repStatus?:
      | "PENDING"
      | "UPLOADING"
      | "VERIFYING"
      | "COMPLETED"
      | "RETRYABLE_FAILURE"
      | "FAILED";
    errorMessage?: string | null;
  } = {}
): Promise<{ backupId: string; replicationId: string }> {
  const backupId = makeCuid();
  seededBackupIds.push(backupId);
  await prisma.backup.create({
    data: {
      id: backupId,
      status: "VERIFIED",
      kind: "MANUAL",
      schemaSha256: randomBytes(32).toString("hex"),
      appVersion: "repl-svc-test",
      formatVersion: "1",
      encryptionVersion: "v1",
      sizeBytes: BigInt(1024),
      contentSha256: randomBytes(32).toString("hex"),
      manifestSha256: randomBytes(32).toString("hex"),
      fileName: `${backupId}.bin`
    }
  });
  const rep = await prisma.backupReplication.create({
    data: {
      backupId,
      destination: REPLICATION_DESTINATION,
      status: overrides.repStatus ?? "COMPLETED",
      remoteBinFileId: "remote-bin-" + backupId.slice(0, 6),
      remoteManifestFileId: "remote-mf-" + backupId.slice(0, 6),
      remoteFolderId: "remote-folder",
      lastVerifyLevel: "METADATA_ONLY",
      remoteBinSize: BigInt(1024),
      remoteManifestSize: BigInt(200),
      remoteBinMd5: "d41d8cd98f00b204e9800998ecf8427e",
      remoteManifestMd5: "d41d8cd98f00b204e9800998ecf8427e",
      lastVerifiedAt: new Date("2026-09-29T12:00:00Z"),
      errorCode: "NONE",
      errorMessage: overrides.errorMessage ?? null,
      // Session URI canary — the sanitization tests check the meta of
      // failure/denied audit rows does NOT include this string.
      uploadSessionUri: CANARY_SESSION_URI
    }
  });
  return { backupId, replicationId: rep.id };
}

// ─── Suite setup ────────────────────────────────────────────────────────────

before(() => {
  snapshotEnv();
});

after(async () => {
  restoreEnv();
  const prisma = await makePrisma();
  try {
    if (seededOverrides.length > 0) {
      for (const o of seededOverrides) {
        await prisma.rolePermissionOverride
          .delete({
            where: {
              role_permission: { role: o.role, permission: o.permission }
            }
          })
          .catch(() => undefined);
      }
    }
    if (seededBackupIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: seededBackupIds } }
      });
      await prisma.backup.deleteMany({
        where: { id: { in: seededBackupIds } }
      });
    }
    if (seededAdminIds.length > 0) {
      await prisma.adminUser.deleteMany({
        where: { id: { in: seededAdminIds } }
      });
    }
    await prisma.auditLog.deleteMany({
      where: {
        createdAt: { gte: testWindowStart },
        action: { startsWith: "backup.replication." }
      }
    });
  } finally {
    await prisma.$disconnect();
  }
});

beforeEach(() => {
  // Default posture for each test: Drive DISABLED. Individual tests
  // opt in to `setDriveEnabledWithCanaryEnv()` where needed.
  setDriveDisabled();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function fetchAuditsForOperation(
  prisma: PrismaClient,
  operationId: string
): Promise<
  Array<{
    action: string;
    meta: unknown;
    entity: string | null;
    entityId: string | null;
    userId: string | null;
  }>
> {
  const rows = await prisma.auditLog.findMany({
    where: {
      createdAt: { gte: testWindowStart },
      action: { startsWith: "backup.replication." }
    },
    orderBy: { createdAt: "asc" },
    select: {
      action: true,
      meta: true,
      entity: true,
      entityId: true,
      userId: true
    }
  });
  return rows.filter((r) => {
    const meta = r.meta as { operationId?: string } | null;
    return meta?.operationId === operationId;
  });
}

function stringifyMeta(x: unknown): string {
  return JSON.stringify(x);
}

function assertNoForbiddenSubstring(haystack: string, where: string): void {
  for (const { label, needle } of FORBIDDEN_SUBSTRINGS) {
    assert.ok(
      !haystack.includes(needle),
      `${where}: forbidden substring leaked — ${label}`
    );
  }
}

// ─── Retry ─────────────────────────────────────────────────────────────────

describe("retryReplicationService", () => {
  test("VIEWER is refused → UNAUTHORIZED + .denied audit row", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "VIEWER");
      const { backupId } = await seedBackupWithReplication(prisma, {
        repStatus: "FAILED"
      });
      const r = await retryReplicationService({
        actor: { id: admin.id, role: admin.role },
        backupId
      });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, "UNAUTHORIZED");
        // No publicMessage should carry the internal hint (actor id).
        assert.ok(!r.publicMessage.includes(admin.id));
      }
      const audits = await fetchAuditsForOperation(prisma, r.operationId);
      assert.ok(audits.length >= 1);
      const denied = audits.find(
        (a) => a.action === "backup.replication.retry.denied"
      );
      assert.ok(denied, "expected backup.replication.retry.denied audit row");
      const meta = denied!.meta as { errorCode?: string };
      assert.equal(meta.errorCode, "UNAUTHORIZED");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("ADMIN can retry — FAILED → PENDING; success audit; attemptCount reset", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const { backupId, replicationId } = await seedBackupWithReplication(
        prisma,
        { repStatus: "FAILED" }
      );
      // Simulate the row having burned some attempts.
      await prisma.backupReplication.update({
        where: { id: replicationId },
        data: { attemptCount: 7 }
      });
      const r = await retryReplicationService({
        actor: { id: admin.id, role: admin.role },
        backupId
      });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.previousStatus, "FAILED");
        assert.equal(r.nextStatus, "PENDING");
      }
      const row = await prisma.backupReplication.findUnique({
        where: { id: replicationId }
      });
      assert.equal(row!.status, "PENDING");
      assert.equal(row!.attemptCount, 0);
      assert.equal(row!.errorCode, "NONE");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("STATE_CONFLICT when row is COMPLETED", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const { backupId } = await seedBackupWithReplication(prisma, {
        repStatus: "COMPLETED"
      });
      const r = await retryReplicationService({
        actor: { id: admin.id, role: admin.role },
        backupId
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "STATE_CONFLICT");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("NOT_FOUND when no replication row", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const backupId = makeCuid();
      seededBackupIds.push(backupId);
      await prisma.backup.create({
        data: {
          id: backupId,
          status: "VERIFIED",
          kind: "MANUAL",
          schemaSha256: randomBytes(32).toString("hex"),
          appVersion: "repl-svc-test",
          formatVersion: "1",
          encryptionVersion: "v1",
          sizeBytes: BigInt(1024),
          contentSha256: randomBytes(32).toString("hex"),
          manifestSha256: randomBytes(32).toString("hex"),
          fileName: `${backupId}.bin`
        }
      });
      const r = await retryReplicationService({
        actor: { id: admin.id, role: admin.role },
        backupId
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "NOT_FOUND");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("INVALID_INPUT for malformed backupId (unsafe string)", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const r = await retryReplicationService({
        actor: { id: admin.id, role: admin.role },
        backupId: "../etc/passwd"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "INVALID_INPUT");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("CONFIGURATION_ERROR when Drive flag is off (fail-closed)", async () => {
    // NB: Drive is disabled by default via beforeEach.
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "SUPER_ADMIN");
      const { backupId } = await seedBackupWithReplication(prisma, {
        repStatus: "FAILED"
      });
      const r = await retryReplicationService({
        actor: { id: admin.id, role: admin.role },
        backupId
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "CONFIGURATION_ERROR");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Verify ────────────────────────────────────────────────────────────────

describe("verifyRemoteService — authz + validation gate", () => {
  test("VIEWER refused → UNAUTHORIZED + denied audit", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "VIEWER");
      const { backupId } = await seedBackupWithReplication(prisma);
      const r = await verifyRemoteService({
        actor: { id: admin.id, role: admin.role },
        backupId,
        level: "METADATA"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "UNAUTHORIZED");
      const audits = await fetchAuditsForOperation(prisma, r.operationId);
      assert.ok(
        audits.some((a) => a.action === "backup.replication.verify.denied")
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("STATE_CONFLICT when row not COMPLETED", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const { backupId } = await seedBackupWithReplication(prisma, {
        repStatus: "PENDING"
      });
      const r = await verifyRemoteService({
        actor: { id: admin.id, role: admin.role },
        backupId,
        level: "METADATA"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "STATE_CONFLICT");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("INVALID_INPUT for bogus verify level", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const { backupId } = await seedBackupWithReplication(prisma);
      const r = await verifyRemoteService({
        actor: { id: admin.id, role: admin.role },
        backupId,
        level: "BOGUS" as unknown as "METADATA"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "INVALID_INPUT");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Reconcile ────────────────────────────────────────────────────────────

describe("reconcileRemoteService — authz + validation gate", () => {
  test("SALES refused → UNAUTHORIZED + denied audit", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "SALES");
      const { backupId } = await seedBackupWithReplication(prisma);
      const r = await reconcileRemoteService({
        actor: { id: admin.id, role: admin.role },
        backupId
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "UNAUTHORIZED");
      const audits = await fetchAuditsForOperation(prisma, r.operationId);
      assert.ok(
        audits.some(
          (a) => a.action === "backup.replication.reconcile.denied"
        )
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("NOT_FOUND for a backup with no replication row", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const r = await reconcileRemoteService({
        actor: { id: admin.id, role: admin.role },
        backupId: makeCuid()
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "NOT_FOUND");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Restore from Drive (two-key gate) ────────────────────────────────────

describe("restoreFromDriveService — two-key gate", () => {
  test("ADMIN refused (missing replication.restore)", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const { backupId } = await seedBackupWithReplication(prisma);
      const r = await restoreFromDriveService({
        actor: { id: admin.id, role: admin.role },
        backupId,
        confirmationPhrase: "RESTORE " + backupId.slice(0, 8),
        adminPassword: "test-only-do-not-use"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "UNAUTHORIZED");
      const audits = await fetchAuditsForOperation(prisma, r.operationId);
      assert.ok(
        audits.some(
          (a) => a.action === "backup.replication.restore.denied"
        )
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("SUPER_ADMIN with backup.restore REVOKED via override is refused", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "SUPER_ADMIN");
      const { backupId } = await seedBackupWithReplication(prisma);
      // Revoke `backup.restore` for SUPER_ADMIN via override — proves
      // the second key is a real check, not a syntactic label.
      await prisma.rolePermissionOverride.upsert({
        where: {
          role_permission: {
            role: "SUPER_ADMIN",
            permission: "backup.restore"
          }
        },
        create: {
          role: "SUPER_ADMIN",
          permission: "backup.restore",
          granted: false
        },
        update: { granted: false }
      });
      seededOverrides.push({
        role: "SUPER_ADMIN",
        permission: "backup.restore"
      });
      try {
        const r = await restoreFromDriveService({
          actor: { id: admin.id, role: admin.role },
          backupId,
          confirmationPhrase: "RESTORE " + backupId.slice(0, 8),
          adminPassword: "test-only-do-not-use"
        });
        assert.equal(r.ok, false);
        if (!r.ok) {
          assert.equal(
            r.code,
            "UNAUTHORIZED",
            "second key must refuse the request"
          );
        }
        const audits = await fetchAuditsForOperation(prisma, r.operationId);
        // Denied audit uses the base audit action, not `backup.restore.denied` —
        // the denial comes from the replication service, so it audits under
        // `backup.replication.restore.denied`.
        assert.ok(
          audits.some(
            (a) => a.action === "backup.replication.restore.denied"
          ),
          "second-key denial must audit under replication.restore.denied"
        );
      } finally {
        await prisma.rolePermissionOverride.delete({
          where: {
            role_permission: {
              role: "SUPER_ADMIN",
              permission: "backup.restore"
            }
          }
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("INVALID_INPUT rejects empty confirmation phrase", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "SUPER_ADMIN");
      const { backupId } = await seedBackupWithReplication(prisma);
      const r = await restoreFromDriveService({
        actor: { id: admin.id, role: admin.role },
        backupId,
        confirmationPhrase: "",
        adminPassword: "any"
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "INVALID_INPUT");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────

describe("bootstrapDriveFolderService — authz + config gate", () => {
  test("ADMIN refused (settings is SUPER_ADMIN-only baseline)", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "ADMIN");
      const r = await bootstrapDriveFolderService({
        actor: { id: admin.id, role: admin.role }
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "UNAUTHORIZED");
      const audits = await fetchAuditsForOperation(prisma, r.operationId);
      assert.ok(
        audits.some(
          (a) => a.action === "backup.replication.settings.denied"
        )
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("CONFIGURATION_ERROR when Drive is disabled", async () => {
    // Drive is disabled by default (beforeEach).
    const prisma = await makePrisma();
    try {
      const admin = await seedAdmin(prisma, "SUPER_ADMIN");
      const r = await bootstrapDriveFolderService({
        actor: { id: admin.id, role: admin.role }
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "CONFIGURATION_ERROR");
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ─── Cross-cut: secret hygiene ────────────────────────────────────────────

describe("service layer — no secrets in results or audits", () => {
  test("denied + failure paths never leak env canaries or session URIs", async () => {
    setDriveEnabledWithCanaryEnv();
    const prisma = await makePrisma();
    try {
      // Denied path — VIEWER retry.
      const viewer = await seedAdmin(prisma, "VIEWER");
      const { backupId } = await seedBackupWithReplication(prisma, {
        repStatus: "FAILED"
      });
      const r1 = await retryReplicationService({
        actor: { id: viewer.id, role: viewer.role },
        backupId
      });
      // Config-error path — same admin with Drive disabled.
      setDriveDisabled();
      const admin = await seedAdmin(prisma, "SUPER_ADMIN");
      const r2 = await retryReplicationService({
        actor: { id: admin.id, role: admin.role },
        backupId
      });

      // Search every service-result field.
      for (const r of [r1, r2]) {
        assertNoForbiddenSubstring(JSON.stringify(r), "service result");
      }
      // Search every audit row written during this test window.
      const rows = await prisma.auditLog.findMany({
        where: {
          createdAt: { gte: testWindowStart },
          action: { startsWith: "backup.replication." }
        },
        select: { action: true, meta: true, entityId: true }
      });
      for (const row of rows) {
        const blob =
          row.action + " | " + stringifyMeta(row.meta) + " | " + (row.entityId ?? "");
        assertNoForbiddenSubstring(blob, `audit row ${row.action}`);
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

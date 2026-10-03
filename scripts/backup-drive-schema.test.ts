// Layer A schema shape assertions for the Google Drive off-site backup
// replication subsystem. Run with:
//   npm run test:backup-drive-schema
//
// This test verifies the additive Prisma model + SQL delta from
// prisma/sql/2026-backup-drive-replication.sql are correctly in place:
//
//   1. The four new enums exist and hold the expected members
//      (checked via Prisma's generated types + a raw pg_type query).
//   2. The `BackupReplication` table exists with the expected columns
//      and constraints (unique on (backupId, destination), FK to Backup,
//      the two secondary indexes).
//   3. The `BackupReplicationConfig` singleton row exists at id='google_drive'
//      (seeded by the SQL delta) and has the expected default folderName
//      and folderMarker values.
//   4. Insert / update / delete round-trips work end-to-end against a
//      real dev Postgres, including the unique-constraint enforcement on
//      (backupId, destination).
//
// NOTHING in this test writes to `Backup.status` or exercises any
// lib/backup/replication code — Layer A is schema-only. Layers B onwards
// will add their own test suites.
//
// All test rows are windowed by `testWindowStart` and cleaned up in
// `after` — the test is safe to run repeatedly on a live dev DB.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "crypto";

type PrismaModule = typeof import("@prisma/client");

async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

function makeCuid(): string {
  return "c" + randomBytes(12).toString("hex");
}

function makeSha256Placeholder(): string {
  return createHash("sha256").update(randomBytes(16)).digest("hex");
}

let testWindowStart: Date;
const testBackupIds: string[] = [];

before(async () => {
  testWindowStart = new Date();
  // The SQL delta seeds the singleton config row. `prisma db push` (the
  // dev convention) does NOT run seed INSERTs, so ensure the row exists
  // before we assert on it. Layer C's runtime code will use the same
  // upsert-on-first-use pattern that BackupSchedule already uses.
  const prisma = await makePrisma();
  try {
    await prisma.backupReplicationConfig.upsert({
      where: { id: "google_drive" },
      create: { id: "google_drive" },
      update: {}
    });
  } finally {
    await prisma.$disconnect();
  }
});

after(async () => {
  const prisma = await makePrisma();
  try {
    // Delete replication rows first (they FK to Backup with RESTRICT).
    if (testBackupIds.length > 0) {
      await prisma.backupReplication.deleteMany({
        where: { backupId: { in: testBackupIds } }
      });
      await prisma.backup.deleteMany({
        where: { id: { in: testBackupIds } }
      });
    }
    // Belt-and-braces: also purge any rows we may have created by time window.
    await prisma.backupReplication.deleteMany({
      where: { createdAt: { gte: testWindowStart } }
    });
  } finally {
    await prisma.$disconnect();
  }
});

describe("Google Drive replication schema — Layer A", () => {
  test("Prisma-generated enum types include the expected members", async () => {
    // Compile-time: importing the enum triggers a type-check failure if the
    // Prisma client was not regenerated with the new schema.
    const {
      BackupReplicationDestination,
      BackupReplicationStatus,
      BackupReplicationErrorCode,
      BackupReplicationVerifyLevel
    } = await import("@prisma/client");

    assert.deepEqual(
      Object.keys(BackupReplicationDestination).sort(),
      ["GOOGLE_DRIVE"]
    );

    assert.deepEqual(
      Object.keys(BackupReplicationStatus).sort(),
      [
        "COMPLETED",
        "FAILED",
        "PENDING",
        "RETRYABLE_FAILURE",
        "UPLOADING",
        "VERIFYING"
      ]
    );

    assert.deepEqual(
      Object.keys(BackupReplicationVerifyLevel).sort(),
      ["FULL_SHA256", "METADATA_ONLY", "NONE"]
    );

    // Only spot-check the error enum's shape (19 members after Layer J
    // added REMOTE_MISSING) — full list is asserted at the DB level below.
    const errorCodes = Object.keys(BackupReplicationErrorCode);
    assert.ok(
      errorCodes.includes("NONE"),
      "BackupReplicationErrorCode must include NONE"
    );
    assert.ok(
      errorCodes.includes("REVOKED_AUTHORIZATION"),
      "BackupReplicationErrorCode must include REVOKED_AUTHORIZATION"
    );
    assert.ok(
      errorCodes.includes("REMOTE_CHECKSUM_MISMATCH"),
      "BackupReplicationErrorCode must include REMOTE_CHECKSUM_MISMATCH"
    );
    assert.ok(
      errorCodes.includes("REMOTE_MISSING"),
      "BackupReplicationErrorCode must include REMOTE_MISSING (Layer J)"
    );
    assert.equal(
      errorCodes.length,
      19,
      `BackupReplicationErrorCode expected 19 members, got ${errorCodes.length}: ${errorCodes.join(", ")}`
    );
  });

  test("Postgres enum types exist with the expected members", async () => {
    const prisma = await makePrisma();
    try {
      // pg_enum joins pg_type to give us the labels per enum name.
      const rows = await prisma.$queryRaw<
        Array<{ typname: string; enumlabel: string }>
      >`
        SELECT t.typname, e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN (
          'BackupReplicationDestination',
          'BackupReplicationStatus',
          'BackupReplicationErrorCode',
          'BackupReplicationVerifyLevel'
        )
        ORDER BY t.typname, e.enumsortorder
      `;

      const byName: Record<string, string[]> = {};
      for (const r of rows) {
        (byName[r.typname] ??= []).push(r.enumlabel);
      }

      assert.deepEqual(
        byName["BackupReplicationDestination"] ?? [],
        ["GOOGLE_DRIVE"]
      );
      assert.deepEqual(
        byName["BackupReplicationStatus"] ?? [],
        [
          "PENDING",
          "UPLOADING",
          "VERIFYING",
          "COMPLETED",
          "RETRYABLE_FAILURE",
          "FAILED"
        ]
      );
      assert.deepEqual(
        byName["BackupReplicationVerifyLevel"] ?? [],
        ["NONE", "METADATA_ONLY", "FULL_SHA256"]
      );
      // Full error-code list (19 members after Layer J added
      // REMOTE_MISSING via `ALTER TYPE ... ADD VALUE`). The trailing
      // REMOTE_MISSING is at the end because Postgres appends new enum
      // labels in insertion order — see prisma/sql/2026-backup-drive-remote-missing.sql.
      // If a member is missing this catches it clearly.
      assert.deepEqual(
        byName["BackupReplicationErrorCode"] ?? [],
        [
          "NONE",
          "AUTHENTICATION_ERROR",
          "REVOKED_AUTHORIZATION",
          "AUTHORIZATION_ERROR",
          "DESTINATION_NOT_FOUND",
          "QUOTA_EXCEEDED",
          "RATE_LIMITED",
          "NETWORK_ERROR",
          "TIMEOUT",
          "SERVER_ERROR",
          "UPLOAD_SESSION_EXPIRED",
          "REMOTE_VERIFICATION_FAILED",
          "REMOTE_SIZE_MISMATCH",
          "REMOTE_CHECKSUM_MISMATCH",
          "LOCAL_SOURCE_MISSING",
          "LOCAL_SOURCE_CORRUPTED",
          "CONFIGURATION_ERROR",
          "UNKNOWN",
          // Layer J (§O.2) addition — trailing per ALTER TYPE ordering.
          "REMOTE_MISSING"
        ]
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("BackupReplication table has the expected indexes + unique constraint", async () => {
    const prisma = await makePrisma();
    try {
      const rows = await prisma.$queryRaw<
        Array<{ indexname: string }>
      >`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'BackupReplication'
        ORDER BY indexname
      `;
      const names = rows.map((r) => r.indexname);

      assert.ok(
        names.includes("BackupReplication_pkey"),
        `expected primary key index; got ${names.join(", ")}`
      );
      assert.ok(
        names.includes("BackupReplication_backupId_destination_key"),
        `expected unique(backupId, destination) index; got ${names.join(", ")}`
      );
      assert.ok(
        names.includes("BackupReplication_status_nextRetryAt_idx"),
        `expected (status, nextRetryAt) index; got ${names.join(", ")}`
      );
      assert.ok(
        names.includes("BackupReplication_destination_status_idx"),
        `expected (destination, status) index; got ${names.join(", ")}`
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("BackupReplicationConfig singleton row is seeded", async () => {
    const prisma = await makePrisma();
    try {
      const row = await prisma.backupReplicationConfig.findUnique({
        where: { id: "google_drive" }
      });
      assert.ok(
        row,
        "BackupReplicationConfig row with id='google_drive' must be present after applying the SQL delta"
      );
      assert.equal(row!.id, "google_drive");
      assert.equal(row!.folderId, null, "folderId is null until bootstrap");
      assert.match(
        row!.folderName,
        /BIS 2027/,
        "folderName default should mention BIS 2027"
      );
      assert.equal(row!.folderMarker, "bis2027-backup-folder-v1");
      assert.equal(row!.bootstrappedAt, null);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("insert + read + unique-constraint enforcement round-trip", async () => {
    const prisma = await makePrisma();
    try {
      // Create a minimal COMPLETED Backup row so the FK is satisfied. This
      // is NOT a real backup — no crypto, no on-disk file. The FK is what
      // we exercise; nothing here touches Backup.status downstream.
      const backupId = makeCuid();
      testBackupIds.push(backupId);
      await prisma.backup.create({
        data: {
          id: backupId,
          status: "COMPLETED",
          kind: "MANUAL",
          schemaSha256: makeSha256Placeholder(),
          appVersion: "test-drive-schema-0.0.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });

      // Insert a fresh replication row.
      const rep = await prisma.backupReplication.create({
        data: {
          backupId,
          destination: "GOOGLE_DRIVE"
          // status, errorCode, lastVerifyLevel, attemptCount all default.
        }
      });
      assert.equal(rep.backupId, backupId);
      assert.equal(rep.destination, "GOOGLE_DRIVE");
      assert.equal(rep.status, "PENDING");
      assert.equal(rep.errorCode, "NONE");
      assert.equal(rep.lastVerifyLevel, "NONE");
      assert.equal(rep.attemptCount, 0);
      assert.equal(rep.attestedContentSha256, null);
      assert.equal(rep.uploadSessionUri, null);

      // Unique constraint on (backupId, destination): a second insert must fail.
      let duplicateRejected = false;
      try {
        await prisma.backupReplication.create({
          data: {
            backupId,
            destination: "GOOGLE_DRIVE"
          }
        });
      } catch (err) {
        // Prisma throws a PrismaClientKnownRequestError with code P2002 for
        // a unique-index violation.
        if ((err as { code?: string }).code === "P2002") {
          duplicateRejected = true;
        } else {
          throw err;
        }
      }
      assert.equal(
        duplicateRejected,
        true,
        "second row with same (backupId, destination) must be rejected by the unique index"
      );

      // State transition through the machine — verify updates work end-to-end.
      const updated = await prisma.backupReplication.update({
        where: { id: rep.id },
        data: {
          status: "UPLOADING",
          uploadStartedAt: new Date(),
          uploadSessionUri: "https://example.invalid/session/opaque",
          uploadBytesSent: BigInt(1024),
          attemptCount: { increment: 1 }
        }
      });
      assert.equal(updated.status, "UPLOADING");
      assert.equal(updated.attemptCount, 1);
      assert.equal(updated.uploadBytesSent, BigInt(1024));

      // Advance to COMPLETED with a METADATA_ONLY verify — mimics the
      // happy path Layer J documents. attestedContentSha256 stays null
      // because METADATA_ONLY does not populate it.
      const completed = await prisma.backupReplication.update({
        where: { id: rep.id },
        data: {
          status: "COMPLETED",
          uploadCompletedAt: new Date(),
          remoteBinFileId: "1AbcDefGhiJklMno",
          remoteManifestFileId: "1PqrStuVwxYz1234",
          remoteFolderId: "1FolderIdAbcDef",
          remoteBinSize: BigInt(4096),
          remoteManifestSize: BigInt(512),
          remoteBinMd5: "d41d8cd98f00b204e9800998ecf8427e",
          remoteManifestMd5: "d41d8cd98f00b204e9800998ecf8427e",
          lastVerifyLevel: "METADATA_ONLY",
          lastVerifiedAt: new Date()
        }
      });
      assert.equal(completed.status, "COMPLETED");
      assert.equal(completed.lastVerifyLevel, "METADATA_ONLY");
      assert.equal(
        completed.attestedContentSha256,
        null,
        "METADATA_ONLY verify must NOT populate attestedContentSha256 — see Layer J"
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("errorMessage column enforces the 512-char cap", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = makeCuid();
      testBackupIds.push(backupId);
      await prisma.backup.create({
        data: {
          id: backupId,
          status: "COMPLETED",
          kind: "MANUAL",
          schemaSha256: makeSha256Placeholder(),
          appVersion: "test-drive-schema-0.0.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });

      // Exactly 512 chars — accepted.
      const okMsg = "x".repeat(512);
      await prisma.backupReplication.create({
        data: {
          backupId,
          destination: "GOOGLE_DRIVE",
          status: "RETRYABLE_FAILURE",
          errorCode: "NETWORK_ERROR",
          errorMessage: okMsg
        }
      });

      // 513 chars — must fail. Postgres VarChar(512) rejects with a value
      // too long error surfaced as PrismaClientKnownRequestError code
      // P2000 ("The provided value for the column is too long").
      let overflowRejected = false;
      const tooBigMsg = "x".repeat(513);
      try {
        await prisma.backupReplication.update({
          where: {
            backupId_destination: {
              backupId,
              destination: "GOOGLE_DRIVE"
            }
          },
          data: { errorMessage: tooBigMsg }
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "P2000" || code === "22001") {
          overflowRejected = true;
        } else {
          throw err;
        }
      }
      assert.equal(
        overflowRejected,
        true,
        "errorMessage > 512 chars must be rejected by the VarChar(512) constraint"
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  test("Backup → replications reverse relation is queryable", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = makeCuid();
      testBackupIds.push(backupId);
      await prisma.backup.create({
        data: {
          id: backupId,
          status: "VERIFIED",
          kind: "SCHEDULED",
          schemaSha256: makeSha256Placeholder(),
          appVersion: "test-drive-schema-0.0.0",
          formatVersion: "1",
          encryptionVersion: "v1",
          replications: {
            create: [{ destination: "GOOGLE_DRIVE" }]
          }
        }
      });

      const withRep = await prisma.backup.findUnique({
        where: { id: backupId },
        include: { replications: true }
      });
      assert.ok(withRep, "backup must be findable after creation");
      assert.equal(withRep!.replications.length, 1);
      assert.equal(withRep!.replications[0]!.destination, "GOOGLE_DRIVE");
      assert.equal(withRep!.replications[0]!.status, "PENDING");
    } finally {
      await prisma.$disconnect();
    }
  });

  test("FK RESTRICT on delete: cannot delete a Backup with a replication row", async () => {
    const prisma = await makePrisma();
    try {
      const backupId = makeCuid();
      testBackupIds.push(backupId);
      await prisma.backup.create({
        data: {
          id: backupId,
          status: "VERIFIED",
          kind: "MANUAL",
          schemaSha256: makeSha256Placeholder(),
          appVersion: "test-drive-schema-0.0.0",
          formatVersion: "1",
          encryptionVersion: "v1"
        }
      });
      await prisma.backupReplication.create({
        data: { backupId, destination: "GOOGLE_DRIVE" }
      });

      let restrictHit = false;
      try {
        await prisma.backup.delete({ where: { id: backupId } });
      } catch (err) {
        // Prisma surfaces RESTRICT violations in two shapes depending on
        // version / path:
        //   • PrismaClientKnownRequestError with code "P2003" (mapped)
        //   • PrismaClientUnknownRequestError whose message includes the
        //     raw Postgres SQLSTATE "23001" (restrict_violation) or
        //     "23503" (foreign_key_violation)
        // Both mean the DB correctly refused the delete.
        const e = err as { code?: string; message?: string };
        if (
          e.code === "P2003" ||
          (typeof e.message === "string" &&
            /23001|23503|violates .* constraint|RESTRICT/i.test(e.message))
        ) {
          restrictHit = true;
        } else {
          throw err;
        }
      }
      assert.equal(
        restrictHit,
        true,
        "deleting a Backup that has a replication row must be refused (FK RESTRICT)"
      );

      // Ensure we can still clean up: delete the replication first, then
      // the backup succeeds.
      await prisma.backupReplication.deleteMany({ where: { backupId } });
      await prisma.backup.delete({ where: { id: backupId } });
      // Remove from the after-hook cleanup list so it doesn't try to delete twice.
      const idx = testBackupIds.indexOf(backupId);
      if (idx >= 0) testBackupIds.splice(idx, 1);
    } finally {
      await prisma.$disconnect();
    }
  });
});

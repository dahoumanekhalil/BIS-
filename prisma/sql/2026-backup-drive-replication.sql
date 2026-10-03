-- ─────────────────────────────────────────────────────────────────────────────
-- Google Drive off-site backup replication — schema delta (Layer A)
-- ─────────────────────────────────────────────────────────────────────────────
-- Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md § A.
--
-- The project's canonical schema evolution flow is `npm run db:push`, which
-- diffs prisma/schema.prisma against the target DB. This file is provided as
-- a reviewable, idempotent SQL representation of the same delta for teams
-- that prefer `prisma migrate deploy` or manual application, mirroring the
-- pattern established by prisma/sql/2026-backup-restore.sql.
--
-- Additive only — no drops, no renames, no changes to existing tables.
-- Safe to run on an existing database carrying real Backup, RestoreOperation,
-- BackupSchedule, or any other application rows.
--
-- What this delta contains:
--
--   • Enums:  BackupReplicationDestination
--             BackupReplicationStatus
--             BackupReplicationErrorCode
--             BackupReplicationVerifyLevel
--
--   • Tables: BackupReplication          — one row per (Backup, destination);
--                                          unique (backupId, destination)
--             BackupReplicationConfig    — singleton (`id = 'google_drive'`);
--                                          holds the app-managed folderId
--
--   • Indexes + one FK from BackupReplication -> Backup (RESTRICT on delete)
--
-- NOT covered here (intentionally out of scope for Layer A):
--   • The `Backup.replications` reverse relation — this is a Prisma-level
--     virtual, no column is added to the "Backup" table.
--   • Any lib/backup/replication/ code (Layers B onwards).
--   • Any dependency addition (`googleapis` is Layer B).
--
-- Every operation is guarded so this file can be re-applied without error.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── Enums ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BackupReplicationDestination') THEN
    CREATE TYPE "BackupReplicationDestination" AS ENUM (
      'GOOGLE_DRIVE'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BackupReplicationStatus') THEN
    CREATE TYPE "BackupReplicationStatus" AS ENUM (
      'PENDING',
      'UPLOADING',
      'VERIFYING',
      'COMPLETED',
      'RETRYABLE_FAILURE',
      'FAILED'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BackupReplicationErrorCode') THEN
    CREATE TYPE "BackupReplicationErrorCode" AS ENUM (
      'NONE',
      'AUTHENTICATION_ERROR',
      'REVOKED_AUTHORIZATION',
      'AUTHORIZATION_ERROR',
      'DESTINATION_NOT_FOUND',
      'QUOTA_EXCEEDED',
      'RATE_LIMITED',
      'NETWORK_ERROR',
      'TIMEOUT',
      'SERVER_ERROR',
      'UPLOAD_SESSION_EXPIRED',
      'REMOTE_VERIFICATION_FAILED',
      'REMOTE_SIZE_MISMATCH',
      'REMOTE_CHECKSUM_MISMATCH',
      'LOCAL_SOURCE_MISSING',
      'LOCAL_SOURCE_CORRUPTED',
      'CONFIGURATION_ERROR',
      'UNKNOWN'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BackupReplicationVerifyLevel') THEN
    CREATE TYPE "BackupReplicationVerifyLevel" AS ENUM (
      'NONE',
      'METADATA_ONLY',
      'FULL_SHA256'
    );
  END IF;
END $$;

-- ─── BackupReplication ─────────────────────────────────────────────────────
--
-- FK to Backup uses ON DELETE RESTRICT to preserve audit history — mirrors
-- the RestoreOperation.backupId behaviour. Backup rows in this project are
-- soft-deleted (Backup.status = DELETED) rather than physically removed,
-- so RESTRICT is not an operational hazard.

CREATE TABLE IF NOT EXISTS "BackupReplication" (
  "id"                     TEXT NOT NULL PRIMARY KEY,
  "backupId"               TEXT NOT NULL,
  "destination"            "BackupReplicationDestination" NOT NULL,
  "status"                 "BackupReplicationStatus" NOT NULL DEFAULT 'PENDING',

  "remoteBinFileId"        VARCHAR(128),
  "remoteManifestFileId"   VARCHAR(128),
  "remoteFolderId"         VARCHAR(128),
  "remoteBinSize"          BIGINT,
  "remoteManifestSize"     BIGINT,
  "remoteBinMd5"           VARCHAR(64),
  "remoteManifestMd5"      VARCHAR(64),

  "attestedContentSha256"  VARCHAR(64),
  "lastVerifyLevel"        "BackupReplicationVerifyLevel" NOT NULL DEFAULT 'NONE',
  "lastVerifiedAt"         TIMESTAMP(3),

  "uploadSessionUri"       VARCHAR(2048),
  "uploadSessionExpiresAt" TIMESTAMP(3),
  "uploadBytesSent"        BIGINT,

  "uploadStartedAt"        TIMESTAMP(3),
  "uploadCompletedAt"      TIMESTAMP(3),
  "lastAttemptAt"          TIMESTAMP(3),
  "attemptCount"           INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt"            TIMESTAMP(3),

  "errorCode"              "BackupReplicationErrorCode" NOT NULL DEFAULT 'NONE',
  "errorMessage"           VARCHAR(512),

  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BackupReplication_backupId_fkey"
    FOREIGN KEY ("backupId") REFERENCES "Backup"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "BackupReplication_backupId_destination_key"
  ON "BackupReplication"("backupId", "destination");

CREATE INDEX IF NOT EXISTS "BackupReplication_status_nextRetryAt_idx"
  ON "BackupReplication"("status", "nextRetryAt");

CREATE INDEX IF NOT EXISTS "BackupReplication_destination_status_idx"
  ON "BackupReplication"("destination", "status");

-- ─── BackupReplicationConfig (singleton) ───────────────────────────────────
--
-- The id is a fixed string ('google_drive') so the operator cannot
-- accidentally insert a second config row. Prisma emits `@default("google_drive")`
-- for the id; we set the same DEFAULT here for the same reason.

CREATE TABLE IF NOT EXISTS "BackupReplicationConfig" (
  "id"               TEXT NOT NULL PRIMARY KEY DEFAULT 'google_drive',
  "folderId"         VARCHAR(128),
  "folderName"       TEXT NOT NULL DEFAULT 'BIS 2027 — Encrypted Backups (managed by application)',
  "folderMarker"     TEXT NOT NULL DEFAULT 'bis2027-backup-folder-v1',
  "bootstrappedAt"   TIMESTAMP(3),
  "lastReconciledAt" TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL
);

-- Seed the singleton row if it doesn't already exist. The bootstrap script
-- (Layer B) will populate folderId; until then, the row exists with
-- folderId = NULL so `googleDriveConfigStatus()` can report the config as
-- NOT_BOOTSTRAPPED cleanly without needing a nullable-row branch.
INSERT INTO "BackupReplicationConfig" ("id", "updatedAt")
  VALUES ('google_drive', CURRENT_TIMESTAMP)
  ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- POST-DEPLOY VERIFICATION QUERIES (not run automatically)
-- ─────────────────────────────────────────────────────────────────────────
-- After applying this delta, an operator should verify:
--
--   -- Enums exist
--   SELECT typname FROM pg_type
--    WHERE typname IN (
--      'BackupReplicationDestination',
--      'BackupReplicationStatus',
--      'BackupReplicationErrorCode',
--      'BackupReplicationVerifyLevel'
--    );  -- expect 4 rows
--
--   -- Tables exist
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'BackupReplication';        -- expect >= 24
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'BackupReplicationConfig';  -- expect >= 8
--
--   -- FK + unique + index constraints exist
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'BackupReplication'
--    ORDER BY indexname;
--   -- expect (at minimum):
--   --   BackupReplication_backupId_destination_key
--   --   BackupReplication_destination_status_idx
--   --   BackupReplication_pkey
--   --   BackupReplication_status_nextRetryAt_idx
--
--   -- Singleton row exists
--   SELECT id FROM "BackupReplicationConfig";       -- expect exactly 'google_drive'
-- ─────────────────────────────────────────────────────────────────────────

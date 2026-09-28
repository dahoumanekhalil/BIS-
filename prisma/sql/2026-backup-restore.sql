-- ─────────────────────────────────────────────────────────────────────────────
-- Backup / Restore subsystem — schema delta (Phase 1 + Phase 8)
-- ─────────────────────────────────────────────────────────────────────────────
-- The project's canonical schema evolution flow is `npm run db:push`, which
-- diffs prisma/schema.prisma against the target DB. This file is provided as
-- a reviewable, idempotent SQL representation of the same delta for teams
-- that prefer `prisma migrate deploy` or manual application.
--
-- Additive only — no drops, no renames. Safe to run on an existing database
-- carrying real Backup, RestoreOperation, or BackupSchedule rows.
--
-- What this delta contains:
--
--   Phase 1 (models + enums for the backup subsystem):
--     • Enums:    BackupStatus, BackupKind, RestoreStatus
--     • Tables:   Backup, RestoreOperation, BackupSchedule
--     • Indexes + FKs
--
--   Phase 8 (retention + scheduler state):
--     • BackupSchedule additions:  retentionAgeDays, lastRunAt,
--                                  lastRunOutcome, lastRunBackupId,
--                                  lastRunError
--
-- Not covered here (handled elsewhere in the project convention):
--   • The five inverse relations on AdminUser (BackupCreatedBy,
--     BackupVerifiedBy, RestoreOperation.initiatedBy) — these are pure
--     relation columns on other tables and add no columns to AdminUser
--     itself; they exist only as FK constraints below.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── Enums ────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BackupStatus') THEN
    CREATE TYPE "BackupStatus" AS ENUM (
      'PENDING',
      'RUNNING',
      'COMPLETED',
      'VERIFIED',
      'FAILED',
      'DELETED',
      'MISSING'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BackupKind') THEN
    CREATE TYPE "BackupKind" AS ENUM (
      'MANUAL',
      'SCHEDULED',
      'SAFETY'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RestoreStatus') THEN
    CREATE TYPE "RestoreStatus" AS ENUM (
      'INITIATED',
      'PREFLIGHT',
      'RUNNING',
      'COMPLETED',
      'FAILED',
      'ROLLED_BACK'
    );
  END IF;
END $$;

-- ─── Backup ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Backup" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "status"            "BackupStatus" NOT NULL DEFAULT 'PENDING',
  "kind"              "BackupKind" NOT NULL,
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"       TIMESTAMP(3),
  "sizeBytes"         BIGINT,
  "fileName"          VARCHAR(64),
  "contentSha256"     TEXT,
  "manifestSha256"    TEXT,
  "schemaSha256"      TEXT NOT NULL,
  "appVersion"        TEXT NOT NULL,
  "formatVersion"     TEXT NOT NULL DEFAULT '1',
  "encryptionVersion" TEXT NOT NULL DEFAULT 'v1',
  "rowCounts"         JSONB,
  "errorMessage"      TEXT,
  "createdById"       TEXT,
  "verifiedAt"        TIMESTAMP(3),
  "verifiedById"      TEXT,
  "verifyResult"      TEXT,
  CONSTRAINT "Backup_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id")
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "Backup_verifiedById_fkey"
    FOREIGN KEY ("verifiedById") REFERENCES "AdminUser"("id")
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "Backup_status_idx"
  ON "Backup"("status");
CREATE INDEX IF NOT EXISTS "Backup_startedAt_idx"
  ON "Backup"("startedAt");
CREATE INDEX IF NOT EXISTS "Backup_kind_idx"
  ON "Backup"("kind");
CREATE INDEX IF NOT EXISTS "Backup_status_startedAt_idx"
  ON "Backup"("status", "startedAt");

-- ─── RestoreOperation ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "RestoreOperation" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "backupId"       TEXT NOT NULL,
  "status"         "RestoreStatus" NOT NULL DEFAULT 'INITIATED',
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),
  "initiatedById"  TEXT NOT NULL,
  "safetyBackupId" TEXT,
  "errorMessage"   TEXT,
  "meta"           JSONB,
  CONSTRAINT "RestoreOperation_backupId_fkey"
    FOREIGN KEY ("backupId") REFERENCES "Backup"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "RestoreOperation_initiatedById_fkey"
    FOREIGN KEY ("initiatedById") REFERENCES "AdminUser"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "RestoreOperation_safetyBackupId_fkey"
    FOREIGN KEY ("safetyBackupId") REFERENCES "Backup"("id")
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "RestoreOperation_backupId_idx"
  ON "RestoreOperation"("backupId");
CREATE INDEX IF NOT EXISTS "RestoreOperation_startedAt_idx"
  ON "RestoreOperation"("startedAt");
CREATE INDEX IF NOT EXISTS "RestoreOperation_initiatedById_idx"
  ON "RestoreOperation"("initiatedById");
CREATE INDEX IF NOT EXISTS "RestoreOperation_safetyBackupId_idx"
  ON "RestoreOperation"("safetyBackupId");

-- ─── BackupSchedule (singleton row + Phase 8 additions) ───────────────────

CREATE TABLE IF NOT EXISTS "BackupSchedule" (
  "id"               TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
  "enabled"          BOOLEAN NOT NULL DEFAULT false,
  "frequencyHours"   INTEGER NOT NULL DEFAULT 24,
  "retentionCount"   INTEGER NOT NULL DEFAULT 14,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  "updatedById"      TEXT,
  -- Phase 8 additions:
  "retentionAgeDays" INTEGER NOT NULL DEFAULT 90,
  "lastRunAt"        TIMESTAMP(3),
  "lastRunOutcome"   TEXT,
  "lastRunBackupId"  TEXT,
  "lastRunError"     TEXT
);

-- Phase 8: on an existing pre-Phase-8 DB, add the new columns idempotently.
ALTER TABLE "BackupSchedule"
  ADD COLUMN IF NOT EXISTS "retentionAgeDays" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS "lastRunAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastRunOutcome"   TEXT,
  ADD COLUMN IF NOT EXISTS "lastRunBackupId"  TEXT,
  ADD COLUMN IF NOT EXISTS "lastRunError"     TEXT;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- POST-DEPLOY VERIFICATION QUERIES (not run automatically)
-- ─────────────────────────────────────────────────────────────────────────
-- After applying this delta, an operator should verify:
--
--   -- Enums exist
--   SELECT typname FROM pg_type
--    WHERE typname IN ('BackupStatus', 'BackupKind', 'RestoreStatus');
--
--   -- Tables exist with expected column counts (should be >= these numbers;
--   -- future additive columns are fine)
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'Backup';           -- expect 20
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'RestoreOperation'; -- expect 9
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'BackupSchedule';   -- expect 11
--
--   -- FKs exist
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = '"RestoreOperation"'::regclass
--      AND contype = 'f';
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Email Infrastructure — schema delta
-- ─────────────────────────────────────────────────────────────────────────────
-- The project's canonical schema evolution flow is `npm run db:push`, which
-- diffs prisma/schema.prisma against the target DB. This file is provided as
-- a reviewable, idempotent SQL representation of the same delta for teams
-- that prefer `prisma migrate deploy` or manual application.
--
-- Additive only — no drops, no renames. Safe to run on an existing database
-- carrying real EmailMessage rows.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- AccountUser.emailVerifiedAt
ALTER TABLE "AccountUser"
  ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- EmailMessage — orchestration columns
ALTER TABLE "EmailMessage"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "attemptCount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxAttempts"    INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastError"      TEXT,
  ADD COLUMN IF NOT EXISTS "locale"         TEXT NOT NULL DEFAULT 'fr',
  ADD COLUMN IF NOT EXISTS "provider"       TEXT,
  ADD COLUMN IF NOT EXISTS "providerMsgId"  TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "EmailMessage_idempotencyKey_key"
  ON "EmailMessage"("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "EmailMessage_status_nextAttemptAt_idx"
  ON "EmailMessage"("status", "nextAttemptAt");

-- EmailVerificationToken
CREATE TABLE IF NOT EXISTS "EmailVerificationToken" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "userId"       TEXT NOT NULL,
  "tokenHash"    TEXT NOT NULL,
  "emailAtIssue" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "usedAt"       TIMESTAMP(3),
  CONSTRAINT "EmailVerificationToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerificationToken_tokenHash_key"
  ON "EmailVerificationToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_userId_idx"
  ON "EmailVerificationToken"("userId");
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_expiresAt_idx"
  ON "EmailVerificationToken"("expiresAt");

-- PasswordResetToken
CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "requestIp" TEXT,
  CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key"
  ON "PasswordResetToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_idx"
  ON "PasswordResetToken"("userId");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx"
  ON "PasswordResetToken"("expiresAt");

COMMIT;

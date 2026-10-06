-- ─────────────────────────────────────────────────────────────────────────────
-- Persistent QR credential — schema delta
-- ─────────────────────────────────────────────────────────────────────────────
-- Same convention as the other prisma/sql files: the canonical flow is
-- `npm run db:push`; this file is the reviewable, idempotent SQL equivalent.
--
-- Additive only. Safe on a database with existing BadgeCredential rows:
-- legacy rows keep sequence = NULL (hash-only, not re-displayable).
--
-- It ALSO owns the single-ACTIVE-credential invariant. Previously this index
-- was created only by a manual script (scripts/apply-badge-index.ts). It is
-- now part of the managed schema delta and is verified by
-- scripts/badge-schema.test.ts. Apply this file on EVERY environment
-- (including production) after `db:push`.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE "BadgeCredential"
  ADD COLUMN IF NOT EXISTS "sequence"    INTEGER,
  ADD COLUMN IF NOT EXISTS "createdById" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BadgeCredential_participantId_sequence_key"
  ON "BadgeCredential" ("participantId", "sequence");

-- At most ONE ACTIVE credential per participant (database-level guarantee).
CREATE UNIQUE INDEX IF NOT EXISTS "BadgeCredential_one_active_per_participant_uidx"
  ON "BadgeCredential" ("participantId")
  WHERE status = 'ACTIVE';

-- Defence in depth: roles that may never hold badge.regenerate (the app also
-- enforces this at authorisation time, regardless of these rows).
UPDATE "RolePermissionOverride"
   SET "granted" = FALSE
 WHERE "permission" IN ('badge.regenerate', 'badge.view')
   AND "role" IN ('CHECKIN_OPERATOR', 'VIEWER', 'ANALYTICS')
   AND "granted" = TRUE;

COMMIT;

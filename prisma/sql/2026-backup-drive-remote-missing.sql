-- Layer J (plan §O) — add REMOTE_MISSING to BackupReplicationErrorCode.
--
-- The plan carries a distinct code for the case where an operator (or
-- any Drive-side actor) has deleted our backup file from Drive while
-- the local BackupReplication row still remembers its file id. The
-- reconcile service (lib/backup/replication/reconcile.ts) detects the
-- 404 on files.get and stamps errorCode = REMOTE_MISSING on the row
-- WITHOUT touching either the row's `status` (stays COMPLETED, so the
-- historical fact is preserved) or the local Backup row (Layer M
-- independence invariant).
--
-- Idempotent: `ALTER TYPE ... ADD VALUE IF NOT EXISTS` is a no-op when
-- the label already exists.
--
-- Ordering: added at the END of the enum. Postgres enum labels have an
-- implicit sort order derived from insertion. Nothing in the codebase
-- reads or writes on enum ORDER (only equality), so trailing addition
-- is safe.

ALTER TYPE "BackupReplicationErrorCode" ADD VALUE IF NOT EXISTS 'REMOTE_MISSING';

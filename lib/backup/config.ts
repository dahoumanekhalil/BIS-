import "server-only";

import path from "path";

// Centralized environment access for the backup subsystem. Every module
// that reads an env var goes through here so misconfiguration surfaces in
// one place and can be swapped for a config file or a KMS-backed loader
// later without touching call sites.
//
// Validation is done at first use (matching the email module's pattern),
// not at startup, so a partially-configured dev environment does not fail
// the entire Next.js boot. The trade-off: a config error appears only when
// an operator tries to run a backup — that is acceptable because the
// admin UI surfaces a clear "backup not configured" state before the
// first attempt.

export class BackupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupConfigError";
  }
}

const MIN_TICK_SECRET_LEN = 24;

/**
 * Resolved, validated storage root for the backup subsystem. NEVER accepts
 * a relative path — a relative path is almost always the sign of a
 * misconfiguration that would write backups into the app tree (and thus
 * into git status / next.js build output). The env var must be absolute.
 *
 * Every read/write path in `lib/backup/storage.ts` re-derives every
 * filesystem path from the return value of this function and re-verifies
 * the result stays under `root` before touching disk.
 */
export function loadBackupStorageDir(): string {
  const raw = process.env.BACKUP_STORAGE_DIR;
  if (!raw || raw.trim().length === 0) {
    throw new BackupConfigError(
      "BACKUP_STORAGE_DIR is not set. Set it to an absolute path outside the app tree, e.g. /var/lib/bis2027/backups (Linux) or C:\\bis2027-backups (Windows)."
    );
  }
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new BackupConfigError(
      "BACKUP_STORAGE_DIR must be an absolute path — refusing to store backups inside a relative directory."
    );
  }
  // Normalize once so downstream path.resolve() calls are deterministic.
  return path.resolve(trimmed);
}

/**
 * Shared secret verified by the scheduler tick endpoint. Enforces a floor
 * length so a typo like `changeme` cannot be silently accepted. Comparison
 * itself is constant-time — see `lib/backup/crypto.ts::timingSafeStringEquals`.
 */
export function loadBackupTickSecret(): string {
  const raw = process.env.INTERNAL_BACKUP_TICK_SECRET;
  if (!raw || raw.length < MIN_TICK_SECRET_LEN) {
    throw new BackupConfigError(
      `INTERNAL_BACKUP_TICK_SECRET must be at least ${MIN_TICK_SECRET_LEN} characters. Generate one with:  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"`
    );
  }
  return raw;
}

/**
 * Snapshot of the backup subsystem's configuration state — used by the
 * admin dashboard to render "configured / not configured" without ever
 * exposing the underlying values. Every field is a boolean; no keys, no
 * paths, no secrets ever leave this function.
 */
export function backupConfigStatus(): {
  encryptionKey: "OK" | "MISSING" | "MALFORMED";
  storageDir: "OK" | "MISSING" | "NOT_ABSOLUTE";
  tickSecret: "OK" | "MISSING" | "TOO_SHORT";
} {
  // Import lazily so a broken crypto config does not cascade into the
  // storage/tick status checks.
  let encryption: "OK" | "MISSING" | "MALFORMED" = "OK";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./crypto").loadBackupEncryptionKey();
  } catch (err) {
    encryption =
      err instanceof Error && /is not set/.test(err.message)
        ? "MISSING"
        : "MALFORMED";
  }

  let storage: "OK" | "MISSING" | "NOT_ABSOLUTE" = "OK";
  try {
    loadBackupStorageDir();
  } catch (err) {
    storage =
      err instanceof Error && /must be an absolute path/.test(err.message)
        ? "NOT_ABSOLUTE"
        : "MISSING";
  }

  let tick: "OK" | "MISSING" | "TOO_SHORT" = "OK";
  const rawTick = process.env.INTERNAL_BACKUP_TICK_SECRET;
  if (!rawTick) tick = "MISSING";
  else if (rawTick.length < MIN_TICK_SECRET_LEN) tick = "TOO_SHORT";

  return { encryptionKey: encryption, storageDir: storage, tickSecret: tick };
}

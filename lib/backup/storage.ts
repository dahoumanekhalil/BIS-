import "server-only";

import { promises as fs, constants as fsConstants, createReadStream } from "fs";
import path from "path";
import type { ReadStream } from "fs";
import type { Writable } from "stream";

import { loadBackupStorageDir, BackupConfigError } from "./config";

// ─── Safe local filesystem storage for encrypted backups ────────────────────
//
// LAYOUT
//   <BACKUP_STORAGE_DIR>/
//     staging/                 # in-progress writes; promoted atomically on success
//     published/               # completed, integrity-verified backups
//       <backupId>.bin         # ciphertext (iv || ciphertext || tag)
//       <backupId>.manifest.json  # signed manifest (see manifest.ts)
//
// SECURITY invariants:
//   * NEVER accepts an admin-supplied path, filename, or extension. Every
//     path is derived server-side from a backup ID we generated ourselves.
//   * Every filesystem operation re-resolves the target and asserts the
//     result stays under the storage root (defence against a bug that
//     tries to persist a `..` sequence via a malformed cuid).
//   * Backup IDs are validated with a strict allow-list regex before use.
//   * Files and directories are chmod'd to owner-only (0o600 / 0o700).
//     Windows: chmod is largely a no-op — documented; operator responsible
//     for the parent-directory ACL.
//   * Staging directory is swept on startup to clean up files older than
//     STAGING_MAX_AGE_MS — leftover from crashed dumps.

const STAGING_DIR = "staging";
const PUBLISHED_DIR = "published";

const BIN_EXT = ".bin";
const MANIFEST_EXT = ".manifest.json";

// cuid: 25 chars, starts with c, alnum lowercase. Strict — we never mint a
// backup ID any other way, so a mismatched shape is always a programming
// or tampering signal.
const CUID_RE = /^c[a-z0-9]{24}$/;

// Sweep threshold for orphaned staging files. 1 hour is generous — real
// dumps complete in seconds to minutes; anything older is a crashed run.
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

export class BackupStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupStorageError";
  }
}

// ─── Open-flag composition (defence against symlink swaps) ─────────────────
//
// Node's shorthand flag string "wx" expands to O_WRONLY | O_CREAT | O_EXCL —
// it prevents opening an EXISTING file, but on POSIX it happily follows a
// symlink at the target path AND creates the symlink's destination on the
// operator's filesystem. If an attacker with limited write access to the
// staging dir plants a symlink `<cuid>.bin -> /etc/anything`, "wx" would
// write ciphertext to `/etc/anything`. The `O_NOFOLLOW` flag closes that
// window on Linux/macOS by causing `open()` to fail with ELOOP on any
// symlink at the final path component.
//
// Windows does not expose `O_NOFOLLOW` (`fs.constants.O_NOFOLLOW` is
// undefined). On Windows the parent-directory ACL is the operational
// boundary — documented in the README backup section. We deliberately
// build the flags at module load time so the platform decision is made
// once and is inspectable via `STAGING_OPEN_FLAGS` in tests.
const O_NOFOLLOW_SUPPORTED = typeof fsConstants.O_NOFOLLOW === "number";
export const STAGING_OPEN_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (O_NOFOLLOW_SUPPORTED ? fsConstants.O_NOFOLLOW : 0);
export const O_NOFOLLOW_APPLIED = O_NOFOLLOW_SUPPORTED;

/**
 * Validate a backup ID. Returns the ID on success, throws on any deviation
 * from the cuid shape. Callers MUST call this before deriving any path.
 */
export function assertValidBackupId(id: unknown): string {
  if (typeof id !== "string" || !CUID_RE.test(id)) {
    throw new BackupStorageError("Invalid backup id.");
  }
  return id;
}

/**
 * Resolve a filename relative to a subdirectory of the storage root, then
 * verify the resolved path is strictly under the root. Any traversal
 * attempt (`..`, absolute path, symlink-jump via a name) is rejected.
 *
 * This is the single choke-point for path resolution — every read/write
 * helper below goes through it.
 */
function resolveSafe(subdir: string, filename: string): { root: string; full: string } {
  const root = loadBackupStorageDir();
  // Reject anything that could escape via absolute path or separator.
  if (
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename.startsWith(".") ||
    path.isAbsolute(filename)
  ) {
    throw new BackupStorageError("Invalid filename.");
  }
  const base = path.resolve(root, subdir);
  const full = path.resolve(base, filename);
  // The resolved path must be a direct child of `base`.
  if (path.dirname(full) !== base) {
    throw new BackupStorageError("Path traversal detected.");
  }
  // And `base` must be under `root`.
  if (!(base === root || base.startsWith(root + path.sep))) {
    throw new BackupStorageError("Path traversal detected.");
  }
  return { root, full };
}

/**
 * Ensure the `staging/` and `published/` directories exist. Called at the
 * top of every write path — cheap idempotent mkdir. Also chmods each to
 * 0o700 (owner-only) on POSIX; no-op on Windows.
 */
export async function ensureBackupDirs(): Promise<{ root: string; staging: string; published: string }> {
  const root = loadBackupStorageDir();
  const staging = path.resolve(root, STAGING_DIR);
  const published = path.resolve(root, PUBLISHED_DIR);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  await fs.mkdir(published, { recursive: true, mode: 0o700 });
  // chmod is a no-op on Windows but harmless.
  await safeChmod(root, 0o700);
  await safeChmod(staging, 0o700);
  await safeChmod(published, 0o700);
  return { root, staging, published };
}

async function safeChmod(target: string, mode: number): Promise<void> {
  try {
    await fs.chmod(target, mode);
  } catch {
    // Windows / non-POSIX: chmod is a no-op or unsupported. The parent
    // directory ACL is the real access control on Windows and is the
    // operator's responsibility per README.
  }
}

// ─── Filename helpers (single source of truth) ─────────────────────────────

export function binFileName(id: string): string {
  return `${assertValidBackupId(id)}${BIN_EXT}`;
}

export function manifestFileName(id: string): string {
  return `${assertValidBackupId(id)}${MANIFEST_EXT}`;
}

// ─── Staging writes ────────────────────────────────────────────────────────

/**
 * Open a write stream for the encrypted backup file in `staging/`. The
 * dump orchestrator:
 *   1. writes IV || ciphertext || tag through `stream`,
 *   2. awaits the stream's `finish` event,
 *   3. calls `fsyncStaging(id)` to flush the file to physical storage,
 *   4. calls `writeStagingManifest(id, manifestBytes)`,
 *   5. calls `promoteFromStaging(id)`.
 *
 * Only after step 5 returns successfully may the caller mark the
 * Backup row `COMPLETED` in the database. Any earlier state is not
 * safely publishable.
 *
 * Symlink safety: initial open uses `O_NOFOLLOW` on POSIX (see
 * `STAGING_OPEN_FLAGS`); Windows lacks `O_NOFOLLOW` and relies on the
 * parent-directory ACL (documented).
 */
export async function openStagingWriteStream(
  id: string
): Promise<{ full: string; stream: Writable }> {
  assertValidBackupId(id);
  await ensureBackupDirs();
  const { full } = resolveSafe(STAGING_DIR, binFileName(id));
  // O_EXCL rejects if the file exists — deliberate: two concurrent dumps
  // for the same id must not silently truncate one another. O_NOFOLLOW
  // (POSIX only) ensures we do not follow an attacker-planted symlink at
  // the exact target path.
  const handle = await fs.open(full, STAGING_OPEN_FLAGS, 0o600);
  // autoClose:true — the WriteStream owns the FileHandle lifecycle and
  // closes it on stream `end`/`error`. A separate `fsyncStaging(id)` call
  // reopens the file to invoke fsync — this is more portable than sharing
  // one FH between a WriteStream and a caller-driven sync (which had
  // finish/close event race issues on Windows).
  const stream = handle.createWriteStream({ autoClose: true });
  return { full, stream };
}

// Reopen-and-fsync flags: read-write, existing file, follow no symlink.
const FSYNC_REOPEN_FLAGS =
  fsConstants.O_RDWR | (O_NOFOLLOW_SUPPORTED ? fsConstants.O_NOFOLLOW : 0);

/**
 * Force the kernel to flush the staged .bin file to physical storage.
 * MUST be called by the dump orchestrator after the write stream has
 * emitted `finish` and BEFORE `promoteFromStaging`.
 *
 * Reopens the file with `O_NOFOLLOW` (POSIX) to close the small TOCTOU
 * window between write-stream close and this reopen — an attacker who
 * could unlink and replace the file with a symlink in that window is
 * stopped by `O_NOFOLLOW`. On Windows, the parent-directory ACL is the
 * only defence (documented limitation).
 *
 * Durability guarantee: `fsync` requests a device flush from the kernel.
 * It does NOT guarantee a device-level cache flush on SSDs without PLP.
 * On network filesystems, fsync provides only whatever durability the
 * server offers. Documented for operators in the README.
 */
export async function fsyncStaging(id: string): Promise<void> {
  assertValidBackupId(id);
  const { full } = resolveSafe(STAGING_DIR, binFileName(id));
  const handle = await fs.open(full, FSYNC_REOPEN_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write the manifest JSON (already serialized to bytes) into `staging/`.
 * Returns the on-disk path. Same file-mode + symlink-safety discipline
 * as the .bin file: `O_EXCL` + `O_NOFOLLOW` (POSIX only). Manifest is
 * small enough to write in one shot with an explicit `fsync` before
 * close, so no external orchestration is needed.
 */
export async function writeStagingManifest(id: string, body: Buffer): Promise<string> {
  assertValidBackupId(id);
  await ensureBackupDirs();
  const { full } = resolveSafe(STAGING_DIR, manifestFileName(id));
  const fh = await fs.open(full, STAGING_OPEN_FLAGS, 0o600);
  try {
    await fh.writeFile(body);
    // fsync so a crash immediately after does not lose the manifest.
    await fh.sync();
  } finally {
    await fh.close();
  }
  await safeChmod(full, 0o600);
  return full;
}

/**
 * Atomically promote both the .bin and .manifest.json from `staging/` to
 * `published/`. rename() on the same filesystem is atomic on POSIX; on
 * Windows it is atomic when the destination does not exist (which we
 * enforce below). If either rename fails, the .bin rename is attempted
 * first and the manifest second — a manifest-less .bin will fail
 * verification and be surfaced by the reconciliation sweep, so partial
 * promotion is detectable.
 */
export async function promoteFromStaging(id: string): Promise<{ binPath: string; manifestPath: string }> {
  assertValidBackupId(id);
  const { full: binStaging } = resolveSafe(STAGING_DIR, binFileName(id));
  const { full: binPublished } = resolveSafe(PUBLISHED_DIR, binFileName(id));
  const { full: manifestStaging } = resolveSafe(STAGING_DIR, manifestFileName(id));
  const { full: manifestPublished } = resolveSafe(PUBLISHED_DIR, manifestFileName(id));

  // Refuse to overwrite an existing published file. Callers must delete
  // first (via deleteBackup) if they intend to replace — this closes a
  // subtle path where a repeat-invocation could clobber a prior success.
  await assertDoesNotExist(binPublished);
  await assertDoesNotExist(manifestPublished);

  await fs.rename(binStaging, binPublished);
  try {
    await fs.rename(manifestStaging, manifestPublished);
  } catch (err) {
    // If manifest promotion fails, roll the .bin back to staging so we
    // do not leave a manifest-less .bin under `published/`.
    try {
      await fs.rename(binPublished, binStaging);
    } catch {
      // best-effort — the reconciliation sweep will flag this later.
    }
    throw err;
  }
  return { binPath: binPublished, manifestPath: manifestPublished };
}

async function assertDoesNotExist(full: string): Promise<void> {
  try {
    await fs.access(full);
  } catch {
    return; // does not exist — good
  }
  throw new BackupStorageError("Target file already exists.");
}

/**
 * Best-effort delete of the staging artifacts for a backup id. Called
 * when a dump aborts partway through. Never throws.
 */
export async function deleteStaging(id: string): Promise<void> {
  try {
    assertValidBackupId(id);
  } catch {
    return;
  }
  const targets = [
    resolveSafe(STAGING_DIR, binFileName(id)).full,
    resolveSafe(STAGING_DIR, manifestFileName(id)).full
  ];
  for (const t of targets) {
    try {
      await fs.unlink(t);
    } catch {
      /* ignore */
    }
  }
}

// ─── Published reads ────────────────────────────────────────────────────────

/**
 * Open a ReadStream over the published .bin file. The verify + restore
 * engines slice the IV off the front and the tag off the back before
 * feeding the middle to the decrypter — callers must NOT stream the raw
 * output through the decrypter without that framing.
 */
export function openPublishedReadStream(id: string, opts?: { start?: number; end?: number }): ReadStream {
  assertValidBackupId(id);
  const { full } = resolveSafe(PUBLISHED_DIR, binFileName(id));
  return createReadStream(full, {
    start: opts?.start,
    end: opts?.end
  });
}

export async function readPublishedManifest(id: string): Promise<Buffer> {
  assertValidBackupId(id);
  const { full } = resolveSafe(PUBLISHED_DIR, manifestFileName(id));
  return fs.readFile(full);
}

export async function statPublishedBackup(id: string): Promise<{
  binSize: number;
  manifestSize: number;
  binMtime: Date;
}> {
  assertValidBackupId(id);
  const bin = resolveSafe(PUBLISHED_DIR, binFileName(id));
  const manifest = resolveSafe(PUBLISHED_DIR, manifestFileName(id));
  const [binStat, manifestStat] = await Promise.all([fs.stat(bin.full), fs.stat(manifest.full)]);
  return {
    binSize: binStat.size,
    manifestSize: manifestStat.size,
    binMtime: binStat.mtime
  };
}

export async function publishedBackupExists(id: string): Promise<boolean> {
  try {
    assertValidBackupId(id);
    const { full } = resolveSafe(PUBLISHED_DIR, binFileName(id));
    await fs.access(full);
    return true;
  } catch {
    return false;
  }
}

/**
 * Permanently delete a published backup's on-disk artifacts. Caller MUST
 * hold the appropriate DB-level lock (see retention.ts) before calling —
 * this helper does not know about retention policy or restore-in-progress.
 */
export async function deletePublishedBackup(id: string): Promise<void> {
  assertValidBackupId(id);
  const bin = resolveSafe(PUBLISHED_DIR, binFileName(id));
  const manifest = resolveSafe(PUBLISHED_DIR, manifestFileName(id));
  // Delete manifest first so a crash between the two leaves an
  // unverifiable .bin that the reconciliation sweep can garbage-collect.
  for (const target of [manifest.full, bin.full]) {
    try {
      await fs.unlink(target);
    } catch {
      /* ignore missing */
    }
  }
}

// ─── Staged reads (Layer I: remote restore integration §N.2) ─────────────
//
// The remote-restore pipeline downloads a Drive-sourced .bin + manifest
// into an isolated staging subdirectory, then invokes `verifyBackup`
// with `source: { kind: "staging", dir, ... }`. These helpers give the
// verifier a bounded read surface over that staging dir, reusing the
// same filename validation as the published helpers so a caller
// cannot smuggle `..`, `/`, or a nul byte into the read path.
//
// Path-safety rules (identical to `resolveSafe`):
//   * `dir` MUST be an absolute path derived server-side. The caller
//     builds it via `assertStagingSubdir(subdirName)` below — never
//     from operator input.
//   * `name` is validated for `[/, \, \0]`, leading `.`, and absolute
//     path shape. A traversal attempt is refused with
//     `BackupStorageError`.
//   * The resolved file MUST be a direct child of `dir`. Symlink
//     traversal is refused by shape-check (no `..`, no separator).

/**
 * Ensure `subdirName` is a safe, non-traversing subdirectory of the
 * backup storage root's `staging/` directory. Returns its absolute path.
 * Used by the remote-restore pipeline to create per-operation staging
 * dirs such as `staging/drive-restore-<opId>/`.
 */
export async function assertStagingSubdir(subdirName: string): Promise<string> {
  if (
    typeof subdirName !== "string" ||
    subdirName.length === 0 ||
    subdirName.length > 128 ||
    subdirName.includes("/") ||
    subdirName.includes("\\") ||
    subdirName.includes("\0") ||
    subdirName.startsWith(".") ||
    path.isAbsolute(subdirName)
  ) {
    throw new BackupStorageError("Invalid staging subdirectory name.");
  }
  const root = loadBackupStorageDir();
  const stagingRoot = path.resolve(root, STAGING_DIR);
  const dir = path.resolve(stagingRoot, subdirName);
  if (path.dirname(dir) !== stagingRoot) {
    throw new BackupStorageError("Path traversal detected on staging subdir.");
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await safeChmod(dir, 0o700);
  return dir;
}

/**
 * Recursively delete a per-operation staging subdirectory. Best-effort;
 * swallows ENOENT. Refuses to touch anything outside the storage root's
 * `staging/`. Safe to call from a `finally` block.
 */
export async function deleteStagingSubdir(dir: string): Promise<void> {
  try {
    const root = loadBackupStorageDir();
    const stagingRoot = path.resolve(root, STAGING_DIR);
    const resolved = path.resolve(dir);
    // Refuse to rm anything that is not strictly inside stagingRoot.
    if (!resolved.startsWith(stagingRoot + path.sep)) {
      throw new BackupStorageError(
        "Refusing to delete: path is outside the staging root."
      );
    }
    await fs.rm(resolved, { recursive: true, force: true });
  } catch (err) {
    if (err instanceof BackupStorageError) throw err;
    // ENOENT / permission — best-effort semantics.
  }
}

/**
 * Same shape/traversal guard as `resolveSafe`, but the caller supplies
 * the absolute directory. Returns the resolved absolute path.
 */
function resolveInStaged(dir: string, name: string): string {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new BackupStorageError("Staged dir must be an absolute path.");
  }
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith(".") ||
    path.isAbsolute(name)
  ) {
    throw new BackupStorageError("Invalid staged filename.");
  }
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  if (path.dirname(full) !== base) {
    throw new BackupStorageError("Staged path traversal detected.");
  }
  return full;
}

/**
 * Open a ReadStream over a file inside a staging subdirectory. Mirrors
 * `openPublishedReadStream` semantics so `verifyBackup` can operate on
 * either source without a code fork.
 */
export function openStagedReadStream(
  dir: string,
  name: string,
  opts?: { start?: number; end?: number }
): ReadStream {
  const full = resolveInStaged(dir, name);
  return createReadStream(full, {
    start: opts?.start,
    end: opts?.end
  });
}

export async function readStagedManifest(
  dir: string,
  name: string
): Promise<Buffer> {
  const full = resolveInStaged(dir, name);
  return fs.readFile(full);
}

export async function statStagedFile(
  dir: string,
  name: string
): Promise<{ size: number; mtime: Date }> {
  const full = resolveInStaged(dir, name);
  const s = await fs.stat(full);
  return { size: s.size, mtime: s.mtime };
}

/**
 * Convenience pair-stat mirroring `statPublishedBackup` but keyed on
 * explicit filenames rather than a backupId. The remote-restore
 * pipeline calls this immediately after downloading both artefacts
 * and before invoking `verifyBackup(source=staging)`.
 */
export async function statStagedPair(
  dir: string,
  binName: string,
  manifestName: string
): Promise<{ binSize: number; manifestSize: number; binMtime: Date }> {
  const bin = await statStagedFile(dir, binName);
  const manifest = await statStagedFile(dir, manifestName);
  return {
    binSize: bin.size,
    manifestSize: manifest.size,
    binMtime: bin.mtime
  };
}

// ─── Reconciliation / cleanup ──────────────────────────────────────────────

/**
 * List all backup IDs currently present on disk under `published/`. Used
 * by the reconciliation sweep to cross-reference against the `Backup`
 * table (rows with no file → MISSING; files with no row → orphan).
 */
export async function listPublishedIds(): Promise<string[]> {
  await ensureBackupDirs();
  const root = loadBackupStorageDir();
  const publishedDir = path.resolve(root, PUBLISHED_DIR);
  const entries = await fs.readdir(publishedDir);
  const ids = new Set<string>();
  for (const name of entries) {
    if (name.endsWith(BIN_EXT)) {
      const id = name.slice(0, -BIN_EXT.length);
      if (CUID_RE.test(id)) ids.add(id);
    }
  }
  return Array.from(ids).sort();
}

/**
 * Best-effort cleanup of orphaned files in `staging/` older than
 * STAGING_MAX_AGE_MS. Runs at every scheduler tick (see scheduler.ts) so
 * a crashed dump does not leave partial ciphertext behind indefinitely.
 * Never throws.
 */
export async function sweepStaleStaging(nowMs = Date.now()): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  try {
    await ensureBackupDirs();
    const root = loadBackupStorageDir();
    const stagingDir = path.resolve(root, STAGING_DIR);
    const entries = await fs.readdir(stagingDir);
    for (const name of entries) {
      // Only touch files whose names match our own conventions. Anything
      // else is not ours to delete.
      if (!name.endsWith(BIN_EXT) && !name.endsWith(MANIFEST_EXT)) continue;
      const full = path.resolve(stagingDir, name);
      if (path.dirname(full) !== stagingDir) continue; // paranoia
      try {
        const st = await fs.stat(full);
        if (nowMs - st.mtimeMs > STAGING_MAX_AGE_MS) {
          await fs.unlink(full);
          removed.push(name);
        }
      } catch {
        /* ignore per-entry failures */
      }
    }
  } catch (err) {
    if (err instanceof BackupConfigError) {
      // Storage dir not configured — nothing to sweep. Not an error at
      // this layer; the admin dashboard will surface the misconfiguration.
      return { removed };
    }
    // Other errors: swallow. Sweep is best-effort.
  }
  return { removed };
}

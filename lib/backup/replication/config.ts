import "server-only";

import { prisma } from "@/lib/db";

// Google Drive off-site backup replication — env configuration accessors.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §C and §Q.
//
// Absolute rules enforced by this module (Layer R restated):
//   * `loadGoogleDriveConfig()` returns credentials only to the internal
//     drive-client factory. It is NEVER surfaced to server actions, logs,
//     UI serializers, audit rows, or exception messages.
//   * `googleDriveConfigStatus()` returns categorical status labels only —
//     no clientId, no client secret, no refresh token, no folder id.
//   * Every error message references the env var NAME. No error message,
//     class name, or stack trace ever contains an env var VALUE.
//   * The loader is memoized per Node process. A refresh token rotation
//     requires an application restart (documented in §C.4).
//   * `assertGoogleDriveEnabled()` is the fail-closed gate: every server
//     action + worker calls it before any Drive I/O.
//
// This module does NOT contact Google. It reads env + the singleton row
// from `BackupReplicationConfig`. Reachability is a live probe owned by
// the drive client (Layer B/D) and is not implemented here — callers of
// `googleDriveConfigStatus()` receive `reachable: "NOT_CHECKED"`.

// ─── Errors ─────────────────────────────────────────────────────────────────

export type GoogleDriveConfigErrorCode =
  | "DISABLED"
  | "MISSING"
  | "MALFORMED"
  | "MISMATCH";

export class GoogleDriveConfigError extends Error {
  readonly code: GoogleDriveConfigErrorCode;

  constructor(code: GoogleDriveConfigErrorCode, message: string) {
    super(message);
    this.name = "GoogleDriveConfigError";
    this.code = code;
  }
}

// ─── Env var names (safe to log — values never are) ────────────────────────

const ENV = {
  ENABLED: "GOOGLE_DRIVE_BACKUP_ENABLED",
  AUTH_MODE: "GOOGLE_DRIVE_AUTH_MODE",
  CLIENT_ID: "GOOGLE_DRIVE_CLIENT_ID",
  CLIENT_SECRET: "GOOGLE_DRIVE_CLIENT_SECRET",
  REFRESH_TOKEN: "GOOGLE_DRIVE_REFRESH_TOKEN",
  FOLDER_ID: "GOOGLE_DRIVE_FOLDER_ID",
  CHUNK_MIB: "GOOGLE_DRIVE_UPLOAD_CHUNK_MIB",
  TIMEOUT_MS: "GOOGLE_DRIVE_HTTP_TIMEOUT_MS"
} as const;

const ONLY_SUPPORTED_AUTH_MODE = "oauth_refresh_token";

// Reasonable floors — a value below these is almost certainly a paste error
// or a placeholder ("changeme"). We deliberately do NOT enforce shape checks
// against Google's exact string formats: those formats are contract-free
// and would change silently.
const MIN_CLIENT_ID_LEN = 5;
const MIN_CLIENT_SECRET_LEN = 8;
const MIN_REFRESH_TOKEN_LEN = 20;
const MAX_FOLDER_ID_LEN = 128;

const DEFAULT_CHUNK_MIB = 16;
const MIN_CHUNK_MIB = 1;
const MAX_CHUNK_MIB = 256;

const DEFAULT_HTTP_TIMEOUT_MS = 90_000;
const MIN_HTTP_TIMEOUT_MS = 1_000;
const MAX_HTTP_TIMEOUT_MS = 600_000;

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Resolved credentials + tuning. Consumed exclusively by the internal
 * drive-client factory. Callers must not log, JSON-serialize, expose over
 * IPC, embed in an audit row, or return from a server action.
 *
 * Marked `Readonly` so mutations that would land in a log surface are a
 * type error.
 */
export type GoogleDriveResolvedConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Non-null iff `GOOGLE_DRIVE_FOLDER_ID` env override is set. */
  folderIdFromEnv: string | null;
  uploadChunkBytes: number;
  httpTimeoutMs: number;
}>;

export type GoogleDriveFlagStatus = "DISABLED" | "ENABLED";
export type GoogleDriveCredentialsStatus = "OK" | "MISSING" | "MALFORMED";
export type GoogleDriveFolderStatus =
  | "OK"
  | "NOT_BOOTSTRAPPED"
  | "MISMATCH"
  | "UNKNOWN";
export type GoogleDriveReachableStatus = "OK" | "UNREACHABLE" | "NOT_CHECKED";

export type GoogleDriveConfigStatus = {
  flag: GoogleDriveFlagStatus;
  credentials: GoogleDriveCredentialsStatus;
  folder: GoogleDriveFolderStatus;
  reachable: GoogleDriveReachableStatus;
};

// ─── Enabled flag ──────────────────────────────────────────────────────────

/**
 * Returns true iff `GOOGLE_DRIVE_BACKUP_ENABLED` is the exact string
 * `"true"` (case-insensitive, whitespace trimmed). Any other value —
 * "1", "yes", "on", missing — is treated as disabled. This deliberate
 * strictness prevents a partial-config env from silently switching the
 * subsystem on.
 */
export function isGoogleDriveEnabled(): boolean {
  const raw = (process.env[ENV.ENABLED] ?? "").trim().toLowerCase();
  return raw === "true";
}

/**
 * Fail-closed gate. Every server action + worker tick calls this before
 * any Drive I/O. Throws `GoogleDriveConfigError("DISABLED")` when the
 * flag is off.
 */
export function assertGoogleDriveEnabled(): void {
  if (!isGoogleDriveEnabled()) {
    throw new GoogleDriveConfigError(
      "DISABLED",
      `${ENV.ENABLED} is not "true" — Google Drive replication is disabled.`
    );
  }
}

// ─── Env validation (throw-free; used by both loader + status) ─────────────

type ValidationResult =
  | { ok: true; config: GoogleDriveResolvedConfig }
  | {
      ok: false;
      status: "MISSING" | "MALFORMED";
      envVar: string;
    };

function trimOr(rawEnv: string | undefined): string {
  return (rawEnv ?? "").trim();
}

function validateEnv(): ValidationResult {
  const authRaw = trimOr(process.env[ENV.AUTH_MODE]);
  const authMode = authRaw === "" ? ONLY_SUPPORTED_AUTH_MODE : authRaw;
  if (authMode !== ONLY_SUPPORTED_AUTH_MODE) {
    return { ok: false, status: "MALFORMED", envVar: ENV.AUTH_MODE };
  }

  const clientId = trimOr(process.env[ENV.CLIENT_ID]);
  if (clientId.length === 0) {
    return { ok: false, status: "MISSING", envVar: ENV.CLIENT_ID };
  }
  if (clientId.length < MIN_CLIENT_ID_LEN) {
    return { ok: false, status: "MALFORMED", envVar: ENV.CLIENT_ID };
  }

  const clientSecret = trimOr(process.env[ENV.CLIENT_SECRET]);
  if (clientSecret.length === 0) {
    return { ok: false, status: "MISSING", envVar: ENV.CLIENT_SECRET };
  }
  if (clientSecret.length < MIN_CLIENT_SECRET_LEN) {
    return { ok: false, status: "MALFORMED", envVar: ENV.CLIENT_SECRET };
  }

  const refreshToken = trimOr(process.env[ENV.REFRESH_TOKEN]);
  if (refreshToken.length === 0) {
    return { ok: false, status: "MISSING", envVar: ENV.REFRESH_TOKEN };
  }
  if (refreshToken.length < MIN_REFRESH_TOKEN_LEN) {
    return { ok: false, status: "MALFORMED", envVar: ENV.REFRESH_TOKEN };
  }

  // Optional folder id override (§E.3 discovery preferred order).
  const folderRaw = trimOr(process.env[ENV.FOLDER_ID]);
  let folderIdFromEnv: string | null = null;
  if (folderRaw.length > 0) {
    if (folderRaw.length > MAX_FOLDER_ID_LEN) {
      return { ok: false, status: "MALFORMED", envVar: ENV.FOLDER_ID };
    }
    folderIdFromEnv = folderRaw;
  }

  const chunkParsed = parseIntStrict(
    process.env[ENV.CHUNK_MIB],
    DEFAULT_CHUNK_MIB,
    MIN_CHUNK_MIB,
    MAX_CHUNK_MIB
  );
  if (chunkParsed === null) {
    return { ok: false, status: "MALFORMED", envVar: ENV.CHUNK_MIB };
  }

  const timeoutParsed = parseIntStrict(
    process.env[ENV.TIMEOUT_MS],
    DEFAULT_HTTP_TIMEOUT_MS,
    MIN_HTTP_TIMEOUT_MS,
    MAX_HTTP_TIMEOUT_MS
  );
  if (timeoutParsed === null) {
    return { ok: false, status: "MALFORMED", envVar: ENV.TIMEOUT_MS };
  }

  return {
    ok: true,
    config: {
      clientId,
      clientSecret,
      refreshToken,
      folderIdFromEnv,
      uploadChunkBytes: chunkParsed * 1024 * 1024,
      httpTimeoutMs: timeoutParsed
    }
  };
}

/**
 * Strict integer parse: only decimal digits, no leading/trailing whitespace
 * (already trimmed by caller), no leading zeros beyond a single "0", no
 * exponents, no sign. Returns `null` for a malformed / out-of-range value.
 * An empty / undefined input yields the supplied default.
 */
function parseIntStrict(
  rawEnv: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number | null {
  const raw = trimOr(rawEnv);
  if (raw.length === 0) return defaultValue;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// ─── Memoized loader ───────────────────────────────────────────────────────

let cachedConfig: GoogleDriveResolvedConfig | null = null;

/**
 * Returns the resolved, validated Google Drive replication credentials.
 * Callers MUST NOT log the returned value or include any field of it in
 * any error, response body, audit row, or UI string.
 *
 * Failure modes (all throw `GoogleDriveConfigError`):
 *   * `code: "DISABLED"`  → the enabled flag is off.
 *   * `code: "MISSING"`   → a required env var is empty.
 *   * `code: "MALFORMED"` → a required env var has a value that is
 *                           obviously wrong (too short, wrong shape,
 *                           out of range, unsupported auth mode).
 *
 * Error messages reference the env var NAME only. They never contain
 * an env var VALUE — a truncated leak is still a leak.
 *
 * Memoized per Node process (§C.1 rule 4). A refresh token rotation
 * requires a process restart — documented in §C.4.
 */
export function loadGoogleDriveConfig(): GoogleDriveResolvedConfig {
  assertGoogleDriveEnabled();
  if (cachedConfig !== null) return cachedConfig;
  const result = validateEnv();
  if (!result.ok) {
    throw new GoogleDriveConfigError(
      result.status,
      result.status === "MISSING"
        ? `${result.envVar} is not set — Google Drive replication cannot start.`
        : `${result.envVar} has a malformed value — Google Drive replication cannot start.`
    );
  }
  cachedConfig = result.config;
  return cachedConfig;
}

/**
 * Test-only cache reset. Intended for `--test` scripts that mutate
 * `process.env.GOOGLE_DRIVE_*` between assertions. Not documented as a
 * public API; the leading underscore signals "do not import from
 * production code".
 */
export function _resetGoogleDriveConfigCache(): void {
  cachedConfig = null;
}

/**
 * Setup-only variant of `loadGoogleDriveConfig` that skips the
 * `GOOGLE_DRIVE_BACKUP_ENABLED` flag check. The bootstrap script
 * (`scripts/backup-drive-bootstrap.ts`) runs BEFORE the operator flips
 * the flag on — that is the whole point of a one-time bootstrap. Every
 * other validation (MISSING / MALFORMED / AUTH_MODE) is unchanged.
 *
 * Reuses the same memoized value as `loadGoogleDriveConfig` so a
 * bootstrap invocation followed by a normal load returns identical
 * references (and vice versa) — no duplicate env parsing.
 *
 * Intended callers: `scripts/backup-drive-bootstrap.ts` only. Do NOT
 * use from a server action, worker, or any runtime path — those paths
 * MUST honour the flag.
 */
export function loadGoogleDriveConfigForBootstrap(): GoogleDriveResolvedConfig {
  if (cachedConfig !== null) return cachedConfig;
  const result = validateEnv();
  if (!result.ok) {
    throw new GoogleDriveConfigError(
      result.status,
      result.status === "MISSING"
        ? `${result.envVar} is not set — Google Drive bootstrap cannot start.`
        : `${result.envVar} has a malformed value — Google Drive bootstrap cannot start.`
    );
  }
  cachedConfig = result.config;
  return cachedConfig;
}

// ─── Status snapshot (no live network I/O) ─────────────────────────────────

/**
 * Passive configuration snapshot for the admin dashboard and the
 * `backup:config-check` CLI. Reads env + the `BackupReplicationConfig`
 * singleton row. NEVER returns credential values or the folder id
 * itself — only categorical status labels.
 *
 * Semantics:
 *   * `flag`
 *       DISABLED — env flag is not `"true"`.
 *       ENABLED  — env flag is `"true"`.
 *   * `credentials`
 *       OK        — every required env var is present and well-formed.
 *       MISSING   — a required env var is unset / empty.
 *       MALFORMED — a required env var is present but obviously wrong.
 *     Reported regardless of `flag`, so the operator can pre-validate
 *     credentials before enabling.
 *   * `folder`
 *       OK               — a folder id is available (env override or
 *                          the DB singleton row's `folderId`).
 *       NOT_BOOTSTRAPPED — neither source has a folder id.
 *       MISMATCH         — env override and DB row hold *different* ids;
 *                          Layer B bootstrap must reconcile before use.
 *       UNKNOWN          — the DB read failed (e.g. Postgres down).
 *   * `reachable`
 *       NOT_CHECKED — this function never contacts Google. A live probe
 *                     is owned by the drive client (Layer B/D).
 *       OK / UNREACHABLE reserved for that future integration; this
 *                        function never returns them.
 *
 * Guarantees:
 *   * No `process.env` VALUE is ever returned or thrown.
 *   * On DB error, resolves with `folder: "UNKNOWN"` — never rejects.
 */
export async function googleDriveConfigStatus(): Promise<GoogleDriveConfigStatus> {
  const flag: GoogleDriveFlagStatus = isGoogleDriveEnabled()
    ? "ENABLED"
    : "DISABLED";

  const validation = validateEnv();
  const credentials: GoogleDriveCredentialsStatus = validation.ok
    ? "OK"
    : validation.status;

  const envFolderId = validation.ok ? validation.config.folderIdFromEnv : null;

  let folder: GoogleDriveFolderStatus;
  try {
    const row = await prisma.backupReplicationConfig.findUnique({
      where: { id: "google_drive" },
      select: { folderId: true }
    });
    const dbFolderId = row?.folderId ?? null;

    if (envFolderId !== null && dbFolderId !== null && envFolderId !== dbFolderId) {
      folder = "MISMATCH";
    } else if (envFolderId !== null || dbFolderId !== null) {
      folder = "OK";
    } else {
      folder = "NOT_BOOTSTRAPPED";
    }
  } catch {
    // Absorb the error — the status API is never allowed to reject. The
    // caller can distinguish an unavailable DB by the `UNKNOWN` label.
    folder = "UNKNOWN";
  }

  return {
    flag,
    credentials,
    folder,
    reachable: "NOT_CHECKED"
  };
}

/**
 * True iff `googleDriveConfigStatus()` reports a state in which the
 * worker + admin actions are permitted to touch Drive. Encapsulates
 * the fail-closed rule (§Q.3) so callers never re-derive it inline.
 */
export function isGoogleDriveConfigReady(
  status: GoogleDriveConfigStatus
): boolean {
  return (
    status.flag === "ENABLED" &&
    status.credentials === "OK" &&
    status.folder === "OK"
  );
}

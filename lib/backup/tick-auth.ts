import "server-only";

import { timingSafeStringEquals } from "./crypto";
import { loadBackupTickSecret, BackupConfigError } from "./config";

// ─── Backup tick endpoint auth helper (Phase 8) ─────────────────────────────
//
// Extracted out of `app/api/internal/backup/tick/route.ts` so it can be
// exercised by plain Node tests without pulling `next/server` — importing
// `next/server` in a bare Node runtime attempts to load the React
// "shared-subset" build which is not usable outside a Next.js server.
//
// The function has ONE responsibility: constant-time compare the caller
// header against the configured shared secret. It NEVER logs the secret,
// NEVER echoes the provided value, and NEVER surfaces the config error
// to the client — the response layer converts any "false" return into a
// uniform 404 so an unauthenticated caller cannot enumerate the endpoint.

export const BACKUP_TICK_HEADER = "x-internal-secret";

export function isBackupTickAuthorized(req: {
  headers: { get: (name: string) => string | null };
}): boolean {
  let expected: string;
  try {
    expected = loadBackupTickSecret();
  } catch (err) {
    if (err instanceof BackupConfigError) return false;
    return false;
  }
  const provided = req.headers.get(BACKUP_TICK_HEADER);
  if (!provided) return false;
  return timingSafeStringEquals(provided, expected);
}

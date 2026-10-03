import "server-only";

// Server-only projection helpers for the admin UI.
//
// The UI pages (dashboard, [id] detail, settings) load browser-safe
// replication data via these helpers rather than reading `prisma` +
// serializing inline — that keeps every never-public field (session
// URI, session expiry, bytes-sent) impossible to leak by construction.

import { prisma } from "@/lib/db";
import {
  googleDriveConfigStatus,
  isGoogleDriveConfigReady,
  type GoogleDriveConfigStatus
} from "@/lib/backup/replication/config";
import {
  serializeReplicationForBrowser,
  type PublicReplicationView
} from "@/lib/backup/replication/serializer";
import {
  labelForFailure,
  remoteVerifyLabel
} from "@/lib/backup/replication/verify-labels";

/**
 * Load the Drive replication row for a backup, projected through the
 * browser-safe serializer. Returns `null` if no replication row exists
 * yet (backup enqueued but not picked up, or Drive disabled).
 */
export async function loadReplicationForBackup(
  backupId: string
): Promise<PublicReplicationView | null> {
  const row = await prisma.backupReplication.findUnique({
    where: {
      backupId_destination: {
        backupId,
        destination: "GOOGLE_DRIVE"
      }
    }
  });
  if (!row) return null;
  return serializeReplicationForBrowser(row);
}

/**
 * Load the Drive replication rows for a list of backup ids, indexed
 * by backupId, projected through the browser-safe serializer. Used by
 * the backups dashboard column. Missing rows are simply absent from
 * the returned map.
 */
export async function loadReplicationsForBackups(
  backupIds: readonly string[]
): Promise<Map<string, PublicReplicationView>> {
  if (backupIds.length === 0) return new Map();
  const rows = await prisma.backupReplication.findMany({
    where: {
      backupId: { in: [...backupIds] },
      destination: "GOOGLE_DRIVE"
    }
  });
  const out = new Map<string, PublicReplicationView>();
  for (const row of rows) {
    out.set(row.backupId, serializeReplicationForBrowser(row));
  }
  return out;
}

/**
 * Snapshot of the Drive subsystem for the settings tab. Never returns
 * a secret / folder id — only the categorical status labels and the
 * "is bootstrapped" boolean derived from whether the config row holds
 * a folder id at all.
 */
export type DriveSubsystemSnapshot = {
  status: GoogleDriveConfigStatus;
  ready: boolean;
  bootstrapped: boolean;
  bootstrappedAt: string | null;
  lastReconciledAt: string | null;
  folderName: string;
};

export async function loadDriveSubsystemSnapshot(): Promise<DriveSubsystemSnapshot> {
  const [status, singleton] = await Promise.all([
    googleDriveConfigStatus(),
    prisma.backupReplicationConfig
      .findUnique({
        where: { id: "google_drive" },
        select: {
          folderId: true,
          folderName: true,
          bootstrappedAt: true,
          lastReconciledAt: true
        }
      })
      .catch(() => null)
  ]);
  return {
    status,
    ready: isGoogleDriveConfigReady(status),
    bootstrapped: (singleton?.folderId ?? null) !== null,
    bootstrappedAt: singleton?.bootstrappedAt?.toISOString() ?? null,
    lastReconciledAt: singleton?.lastReconciledAt?.toISOString() ?? null,
    // folderName is not a secret — it's just the operator's display
    // name for the app-managed folder and is documented in the plan.
    folderName: singleton?.folderName ?? "—"
  };
}

/**
 * Public label for the remote verification level of a replication row.
 * Encapsulates the §J.4 honesty rule (METADATA_ONLY vs FULL_SHA256) in
 * one place so a UI author cannot conflate them.
 *
 * Returns a stable string in every state — never a raw Google message,
 * never a session URI, never a bearer token.
 */
export function verifyLabel(row: PublicReplicationView): string {
  return remoteVerifyLabel({
    errorCode: row.errorCode as never,
    lastVerifyLevel: row.lastVerifyLevel as never
  });
}

/** Failure-side label helper for a replication row's errorCode. */
export function failureLabel(row: PublicReplicationView): string | null {
  if (row.errorCode === "NONE") return null;
  return labelForFailure(row.errorCode as never);
}

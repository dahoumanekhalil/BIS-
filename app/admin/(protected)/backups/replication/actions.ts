"use server";

// Google Drive replication server actions (Plan §P.2).
//
// Thin adapters between the "use server" boundary and the replication
// service layer at `lib/backup/replication/service.ts`. Every action:
//
//   1. Calls `requireReplicationPermission(...)` — which loads the
//      authenticated admin, checks the permission via
//      `canWithOverrides`, and on denial audits + redirects to the
//      dashboard. This is the PROJECT-LOCAL denied-attempt audit hook;
//      the global `lib/admin/auth.requirePermission` remains unchanged.
//   2. Passes an explicit `Actor` to the service, which re-checks the
//      same permission (defence in depth) and re-validates every input.
//   3. Revalidates the relevant admin path so the RSC layer picks up
//      DB changes on the next render.
//
// The service layer is the ACTUAL security boundary. If a malicious
// client bypasses the UI and posts directly to the action endpoint,
// the service still refuses (permission re-check + Zod re-validation +
// state-machine guards + fail-closed config check).
//
// TWO-KEY RESTORE GATE (Plan §P.1 + §N.4):
//   `restoreFromDriveAction` requires BOTH `backup.replication.restore`
//   AND `backup.restore`. Both checks fire at the action layer; the
//   service re-verifies both permissions before any Drive I/O.

import { revalidatePath } from "next/cache";

import {
  bootstrapDriveFolderService,
  reconcileRemoteService,
  restoreFromDriveService,
  retryReplicationService,
  verifyRemoteService,
  type ReplicationServiceResult
} from "@/lib/backup/replication/service";
import { requireReplicationPermission } from "./_helpers";

// Paths refreshed after a mutation. Every replication action touches
// either the list, the [id] detail, or the settings tab.
const REVALIDATE_PATHS = [
  "/admin/backups",
  "/admin/backups/history",
  "/admin/backups/settings"
];

function revalidate(): void {
  for (const p of REVALIDATE_PATHS) revalidatePath(p);
}

// ─── Retry ─────────────────────────────────────────────────────────────────

export async function retryReplicationAction(
  backupId: string
): Promise<
  ReplicationServiceResult<{
    backupId: string;
    previousStatus: string;
    nextStatus: "PENDING";
  }>
> {
  const admin = await requireReplicationPermission("backup.replication.retry", {
    baseAudit: "backup.replication.retry",
    backupId
  });
  const result = await retryReplicationService({
    actor: { id: admin.user.id, role: admin.user.role },
    backupId
  });
  if (result.ok) {
    revalidate();
    revalidatePath(`/admin/backups/${backupId}`);
  }
  return result;
}

// ─── Verify ────────────────────────────────────────────────────────────────

export async function verifyRemoteAction(
  backupId: string,
  level: "METADATA" | "FULL_SHA256"
): Promise<
  ReplicationServiceResult<{
    backupId: string;
    level: "METADATA_ONLY" | "FULL_SHA256";
    outcome: string;
    errorCode?: string;
  }>
> {
  const admin = await requireReplicationPermission("backup.replication.verify", {
    baseAudit: "backup.replication.verify",
    backupId
  });
  const result = await verifyRemoteService({
    actor: { id: admin.user.id, role: admin.user.role },
    backupId,
    level
  });
  if (result.ok) {
    revalidate();
    revalidatePath(`/admin/backups/${backupId}`);
  }
  return result;
}

// ─── Reconcile ────────────────────────────────────────────────────────────

export async function reconcileRemoteAction(
  backupId: string
): Promise<
  ReplicationServiceResult<{
    backupId: string;
    outcome: string;
    errorCode?: string;
  }>
> {
  const admin = await requireReplicationPermission("backup.replication.reconcile", {
    baseAudit: "backup.replication.reconcile",
    backupId
  });
  const result = await reconcileRemoteService({
    actor: { id: admin.user.id, role: admin.user.role },
    backupId
  });
  if (result.ok) {
    revalidate();
    revalidatePath(`/admin/backups/${backupId}`);
  }
  return result;
}

// ─── Restore from Drive (two-key gate) ────────────────────────────────────

/**
 * Download-first remote restore. §P.1 + §N.4 mandate BOTH
 * `backup.replication.restore` AND `backup.restore`. Both checks happen
 * here at the action boundary; the service and the eventual
 * `runRestore` call also re-check `backup.restore` independently — a
 * defence-in-depth chain so no single missed check unlocks a
 * destructive restore.
 */
export async function restoreFromDriveAction(input: {
  backupId: string;
  confirmationPhrase: string;
  adminPassword: string;
}): Promise<
  ReplicationServiceResult<{
    backupId: string;
    outcome: string;
    restoreOperationId?: string;
  }>
> {
  const admin = await requireReplicationPermission(
    "backup.replication.restore",
    { baseAudit: "backup.replication.restore", backupId: input.backupId }
  );
  // Second key. If missing, the same audit hook fires on the same
  // action so one action attempt = at most one denied audit row.
  await requireReplicationPermission("backup.restore", {
    baseAudit: "backup.replication.restore",
    backupId: input.backupId
  });
  const result = await restoreFromDriveService({
    actor: { id: admin.user.id, role: admin.user.role },
    backupId: input.backupId,
    confirmationPhrase: input.confirmationPhrase,
    adminPassword: input.adminPassword
  });
  if (result.ok) {
    revalidate();
    revalidatePath(`/admin/backups/${input.backupId}`);
  }
  return result;
}

// ─── Bootstrap Drive folder ────────────────────────────────────────────────

export async function bootstrapDriveFolderAction(): Promise<
  ReplicationServiceResult<{
    folderId: string;
    source: "env" | "db" | "marker";
    audit: "bootstrap" | "discovered";
  }>
> {
  const admin = await requireReplicationPermission(
    "backup.replication.settings",
    {
      baseAudit: "backup.replication.settings",
      entity: "BackupReplicationConfig",
      entityId: "google_drive"
    }
  );
  const result = await bootstrapDriveFolderService({
    actor: { id: admin.user.id, role: admin.user.role }
  });
  if (result.ok) revalidate();
  return result;
}

"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/admin/auth";
import {
  createBackupService,
  verifyBackupService,
  listBackupsService,
  getBackupService,
  deleteBackupService,
  getScheduleService,
  updateScheduleService,
  runSchedulerTickService,
  runRetentionService,
  type ServiceResult
} from "@/lib/backup/service";

// ─── Server actions for /admin/backups ──────────────────────────────────────
//
// This file is a THIN adapter between the "use server" boundary and the
// backup service layer. Its ONLY responsibilities:
//
//   1. Authenticate the user (requirePermission — redirects to login /
//      dashboard on failure, so control never reaches the service layer
//      when authz fails).
//   2. Wrap the service call.
//   3. Revalidate the relevant admin path so the RSC layer picks up
//      changes on the next render.
//
// The service layer is the ACTUAL security boundary: it re-checks
// permissions (defence in depth), validates every input via zod, and
// sanitizes every error. If a malicious client invokes these actions
// directly (bypassing the UI), the service still refuses.
//
// SafeResult contract — callers see:
//   { ok: true, operationId, ...data }
//   { ok: false, code, publicMessage, operationId }
// and NEVER an internal Prisma/filesystem/crypto message.

const REVALIDATE_PATHS = ["/admin/backups", "/admin/backups/history"];

function revalidate(): void {
  for (const p of REVALIDATE_PATHS) revalidatePath(p);
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createBackupAction(): Promise<
  ServiceResult<{ backupId: string; sizeBytes: number; totalRows: number }>
> {
  // requirePermission redirects on unauth — code below never runs for
  // an unauthorized caller.
  const { user } = await requirePermission("backup.create");
  const result = await createBackupService({
    actor: { id: user.id, role: user.role }
  });
  if (result.ok) revalidate();
  return result;
}

// ── Verify ──────────────────────────────────────────────────────────────────

export async function verifyBackupAction(
  backupId: string
): Promise<
  ServiceResult<{
    outcome: "VERIFIED" | "FAILED";
    code: string;
    stage: string;
    contentSha256?: string;
    totalRows?: number;
    schemaCompatible?: boolean;
  }>
> {
  const { user } = await requirePermission("backup.verify");
  const result = await verifyBackupService({
    actor: { id: user.id, role: user.role },
    backupId
  });
  if (result.ok) revalidate();
  return result;
}

// ── List ────────────────────────────────────────────────────────────────────

export async function listBackupsAction(input: {
  limit?: number;
  offset?: number;
  status?:
    | "PENDING"
    | "RUNNING"
    | "COMPLETED"
    | "VERIFIED"
    | "FAILED"
    | "DELETED"
    | "MISSING";
}): ReturnType<typeof listBackupsService> {
  const { user } = await requirePermission("backup.view");
  return listBackupsService({
    actor: { id: user.id, role: user.role },
    limit: input.limit,
    offset: input.offset,
    status: input.status
  });
}

// ── Get one ─────────────────────────────────────────────────────────────────

export async function getBackupAction(
  backupId: string
): ReturnType<typeof getBackupService> {
  const { user } = await requirePermission("backup.view");
  return getBackupService({
    actor: { id: user.id, role: user.role },
    backupId
  });
}

// ── Delete ──────────────────────────────────────────────────────────────────

export async function deleteBackupAction(
  backupId: string
): ReturnType<typeof deleteBackupService> {
  const { user } = await requirePermission("backup.delete");
  const result = await deleteBackupService({
    actor: { id: user.id, role: user.role },
    backupId
  });
  if (result.ok) revalidate();
  return result;
}

// ── Schedule ────────────────────────────────────────────────────────────────

export async function getScheduleAction(): ReturnType<typeof getScheduleService> {
  const { user } = await requirePermission("backup.view");
  return getScheduleService({ actor: { id: user.id, role: user.role } });
}

export async function updateScheduleAction(input: {
  enabled: boolean;
  frequencyHours: number;
  retentionCount: number;
  retentionAgeDays?: number;
}): ReturnType<typeof updateScheduleService> {
  const { user } = await requirePermission("backup.settings");
  const result = await updateScheduleService({
    actor: { id: user.id, role: user.role },
    enabled: input.enabled,
    frequencyHours: input.frequencyHours,
    retentionCount: input.retentionCount,
    retentionAgeDays: input.retentionAgeDays
  });
  if (result.ok) revalidate();
  return result;
}

// ── Manual scheduler + retention triggers (Phase 8) ─────────────────────────

export async function runSchedulerTickAction(): ReturnType<
  typeof runSchedulerTickService
> {
  const { user } = await requirePermission("backup.create");
  const result = await runSchedulerTickService({
    actor: { id: user.id, role: user.role }
  });
  if (result.ok) revalidate();
  return result;
}

export async function runRetentionAction(): ReturnType<typeof runRetentionService> {
  const { user } = await requirePermission("backup.settings");
  const result = await runRetentionService({
    actor: { id: user.id, role: user.role }
  });
  if (result.ok) revalidate();
  return result;
}

// ── Restore (Phase 7) ───────────────────────────────────────────────────────

/**
 * Kick off a destructive restore. Requires:
 *   • `backup.restore` permission on the calling admin
 *   • A confirmation phrase EXACTLY equal to `RESTORE <first 8 chars of backup id>`
 *   • The admin's password (re-authenticated server-side against the row)
 *   • For a schema-incompatible restore: `force=true` AND SUPER_ADMIN role
 *
 * This action does not create a safety backup itself — the service layer
 * (lib/backup/restore.ts::runRestore) handles that inline. On success,
 * every AdminSession + AccountSession row is wiped; the caller is
 * signed out client-side by the browser's next request.
 */
export async function restoreBackupAction(input: {
  backupId: string;
  confirmationPhrase: string;
  adminPassword: string;
  force?: boolean;
}) {
  const { user } = await requirePermission("backup.restore");
  // Lazy import so this server action file does not pull the restore
  // engine (and its Prisma types) into unrelated code paths.
  const { runRestore } = await import("@/lib/backup/restore");
  const result = await runRestore({
    actor: { id: user.id, role: user.role },
    backupId: input.backupId,
    confirmationPhrase: input.confirmationPhrase,
    adminPassword: input.adminPassword,
    force: input.force === true
  });
  if (result.ok) revalidate();
  return result;
}

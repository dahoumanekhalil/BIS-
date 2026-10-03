import "server-only";

// Helpers for the Google Drive replication server actions.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §P.
//
// The plan requires audit events for denied replication attempts
// (§P.3). The existing global `requirePermission()` redirects on denial
// WITHOUT emitting an audit row — that is deliberate at the project
// level and we do NOT modify it here (a global change would cascade
// through every admin flow).
//
// Instead we provide a REPLICATION-LOCAL wrapper that:
//   1. Loads the authenticated admin (redirect on missing session).
//   2. Runs `canWithOverrides` for the requested permission.
//   3. On denial, emits a `<baseAudit>.denied` audit row with the
//      actor id + role + needed permission, THEN redirects to the
//      dashboard — matching the existing global `requirePermission`
//      redirect UX.
//   4. On success, returns the authenticated admin.
//
// The two-key restore gate reuses this helper twice — one call per
// permission. If the FIRST permission is missing, the second is never
// checked (fail-fast on first missing verb, one audit row per attempt).

import { redirect } from "next/navigation";

import { getCurrentAdmin, type CurrentAdmin } from "@/lib/admin/auth";
import { canWithOverrides, type Permission } from "@/lib/admin/rbac";
import { audit } from "@/lib/admin/audit";

export async function requireReplicationPermission(
  perm: Permission,
  auditContext: {
    /** Base audit action name for this operation ("backup.replication.retry" etc.). */
    baseAudit:
      | "backup.replication.retry"
      | "backup.replication.verify"
      | "backup.replication.reconcile"
      | "backup.replication.restore"
      | "backup.replication.settings";
    /** Optional target backup id, for correlating the denied row. */
    backupId?: string;
    /**
     * Optional override for the audit `entity` field. Defaults to
     * `BackupReplication` (which fits retry / verify / reconcile /
     * restore). The `settings` verb targets `BackupReplicationConfig` —
     * callers should pass `{ entity: "BackupReplicationConfig",
     * entityId: "google_drive" }` for that action so the denied row
     * correlates to the right entity in the audit view.
     */
    entity?: "BackupReplication" | "BackupReplicationConfig";
    /** Optional entity id when `entity` is overridden. */
    entityId?: string;
  }
): Promise<CurrentAdmin> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    redirect("/admin/login");
  }
  const ok = await canWithOverrides(admin.user.role, perm);
  if (ok) return admin;
  // Sanitized metadata — no session token, no cookies, no request body.
  await audit({
    userId: admin.user.id,
    action: `${auditContext.baseAudit}.denied`,
    entity: auditContext.entity ?? "BackupReplication",
    entityId: auditContext.entityId ?? auditContext.backupId,
    meta: {
      neededPermission: perm,
      actorRole: admin.user.role
    }
  }).catch(() => undefined);
  redirect(`/admin/dashboard?denied=${perm}`);
}

import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db";

export const PERMISSIONS = [
  "dashboard.view",

  "registrants.view",
  "registrants.edit",
  "registrants.delete",
  "registrants.export",
  "registrants.email",

  "checkin.view",
  "checkin.validate",

  "gates.view",
  "gates.manage",

  "amenities.view",
  "amenities.manage",

  "sessions.view",
  "sessions.manage",

  "speakers.view",
  "speakers.manage",

  "itineraries.view",
  "itineraries.manage",

  "sponsors.view",
  "sponsors.manage",

  "applications.view",
  "applications.manage",

  // Payment-removal: `revenue.view`, `revenue.reconcile`,
  // `payment.confirm.room`, `payment.refund.room` were retired when
  // BIS 2027 switched to FREE-only room registration.

  "analytics.view",

  "users.manage",
  "roles.manage",

  "audit.view",
  "settings.manage",

  // ─── Email infrastructure (Email Infrastructure Phase) ────────────
  // settings.email.test — permission to invoke "Test SMTP connection"
  //   and "Send test email" on the /admin/settings/email page. Distinct
  //   from settings.manage so an oncall operator can be granted the
  //   ability to run diagnostics WITHOUT the ability to rotate the SMTP
  //   password. Baseline: inherited via ALL by SUPER_ADMIN and ADMIN
  //   (they can already save the config, so they can already test it);
  //   other roles must be granted via RolePermissionOverride.
  "settings.email.test",

  // ─── Email template management (Email Template Phase) ────────────────
  // settings.email.templates — permission to create / edit / activate /
  //   deactivate DB-backed email templates and modify the shared email
  //   branding config. Distinct from `settings.manage` so a content
  //   operator can be granted the ability to iterate on wording WITHOUT
  //   also being granted the ability to rotate the SMTP password or the
  //   Resend API key.
  "settings.email.templates",

  // ─── Badge / access-control (Phase 3) ────────────────────────────────
  // badge.manage             — issue / revoke / rotate a participant's BadgeCredential.
  // access.view              — read a participant's per-room access matrix.
  // access.manage            — grant / revoke ParticipantAccess rows.
  // access.validate.main     — scan QR at the MAIN_ENTRANCE access point.
  // access.validate.room     — scan QR at any ROOM access point.
  //
  // AUTHORIZATION SEPARATION — DO NOT CONFLATE:
  //
  //   LEGACY manual ticket-code flow (existing /admin/check-in)
  //       → gated by `checkin.validate` (unchanged, above).
  //
  //   NEW QR main-entrance validation (Phase 10)
  //       → gated by `access.validate.main` — STRICT, no legacy fallback.
  //
  //   NEW QR room validation (Phase 11)
  //       → gated by `access.validate.room` — STRICT, no legacy fallback.
  //
  // `checkin.validate` MUST NOT authorize any QR flow. A role that holds
  // only the legacy permission must not gain automatic scanner access
  // when Phase 10/11 lands. See the strict helpers below.
  "badge.manage",
  "access.view",
  "access.manage",
  "access.validate.main",
  "access.validate.room",

  // ─── Backup / Restore subsystem (Phase 6) ────────────────────────────
  //
  // Six discrete verbs so an operator can be granted low-risk observation
  // (`backup.view`) without also gaining destructive powers. Every mutating
  // server action under app/admin/(protected)/backups/ starts with
  // `await requirePermission("backup.<verb>")` — the UI's visibility of
  // these entries is UX only.
  //
  //   backup.view      — read the backup dashboard and list, view manifest
  //                      metadata and per-model row counts of any backup.
  //                      Non-destructive.
  //   backup.create    — trigger a manual encrypted database dump. Safe:
  //                      the operation is additive (creates a new file);
  //                      cannot damage existing data.
  //   backup.verify    — re-run the Phase 5 verifier against a backup and
  //                      persist the result. Non-destructive.
  //   backup.delete    — delete a specific backup's on-disk artefacts.
  //                      Restricted because retention-floor drift or an
  //                      accidental delete of the sole known-good backup
  //                      is an operational hazard.
  //   backup.restore   — HIGHEST PRIVILEGE. Kicks off a destructive
  //                      restore. Requires (in the server action) both a
  //                      typed confirmation phrase AND password re-auth
  //                      (see Phase 7). SUPER_ADMIN only in the baseline
  //                      role map; other roles must be granted via a
  //                      RolePermissionOverride if operations require it.
  //   backup.settings  — modify BackupSchedule (frequency, retention,
  //                      enabled). Distinct from `settings.manage`
  //                      because rotating a Postgres backup schedule
  //                      needs a narrower blast radius than the general
  //                      "settings.manage" scope.
  //
  // Baseline role assignments (see ROLE_PERMISSIONS below):
  //   SUPER_ADMIN → all six
  //   ADMIN       → view + create + verify (NOT delete/restore/settings)
  //   others      → none by default; grant via RolePermissionOverride if
  //                 operations delegates.
  "backup.view",
  "backup.create",
  "backup.verify",
  "backup.delete",
  "backup.restore",
  "backup.settings",

  // ─── Google Drive off-site replication (Plan §P.1) ───────────────────
  //
  // Six discrete verbs authorising the operator-driven replication
  // surface. The automated worker (invoked by the internal cron tick)
  // does NOT check these permissions — it authenticates via the shared
  // secret at the /api/internal/backup/replicate/tick endpoint. These
  // permissions gate the future admin-console surface for manual
  // intervention (retry a failed row, deep-verify, reconcile after a
  // Drive-side change, restore from Drive, or toggle the destination).
  //
  //   backup.replication.view       — read the "Google Drive" column /
  //                                    tab. Non-destructive.
  //   backup.replication.retry      — reset a FAILED replication row to
  //                                    PENDING so the worker picks it up
  //                                    again. Additive; the worker still
  //                                    refuses to touch Backup.status.
  //   backup.replication.verify     — trigger a deep verify (metadata or
  //                                    FULL_SHA256 re-download). Never
  //                                    mutates Backup or the row's
  //                                    status — only `errorCode`,
  //                                    `errorMessage`, `lastVerifiedAt`
  //                                    and (FULL_SHA256 only)
  //                                    `attestedContentSha256`.
  //   backup.replication.reconcile  — force a `files.get` sweep on both
  //                                    remote objects. Never mutates
  //                                    Backup; sets REMOTE_MISSING on
  //                                    the row if the Drive object is
  //                                    gone.
  //   backup.replication.restore    — HIGH PRIVILEGE. Kicks off the
  //                                    download-first remote restore
  //                                    pipeline. REQUIRED IN ADDITION TO
  //                                    `backup.restore` (both are
  //                                    checked). The existing restore
  //                                    control set (confirmation phrase,
  //                                    password re-auth, safety
  //                                    snapshot, actor-in-source check)
  //                                    is preserved by chaining into the
  //                                    Phase 7 restore action after the
  //                                    download.
  //   backup.replication.settings   — enable/disable off-site
  //                                    replication + bootstrap the
  //                                    application-managed Drive folder.
  //                                    Baseline: SUPER_ADMIN only.
  //
  // Baseline role assignments (see ROLE_PERMISSIONS below):
  //   SUPER_ADMIN → all six
  //   ADMIN       → view + retry + verify + reconcile
  //                 (NOT restore/settings — mirrors the Phase 6 pattern
  //                 that gates destructive verbs behind SUPER_ADMIN)
  //   others      → none by default; grant via RolePermissionOverride
  //                 if operations delegates.
  "backup.replication.view",
  "backup.replication.retry",
  "backup.replication.verify",
  "backup.replication.reconcile",
  "backup.replication.restore",
  "backup.replication.settings"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

// Role → Permissions map. Server-side is the source of truth.
// Permissions that ADMIN (non-super) does NOT automatically hold. These
// are elevated operations that would give an admin the ability to alter
// the RBAC map itself, replace application data, or reconfigure the
// backup subsystem — SUPER_ADMIN-only by baseline.
const ADMIN_DENIED: Permission[] = [
  "roles.manage",
  "users.manage",
  // Backup subsystem: ADMIN sees + creates + verifies backups. Deletion,
  // schedule changes, and (especially) restore require SUPER_ADMIN
  // baseline. Operators who need to delegate can grant these via a
  // RolePermissionOverride row without touching this table.
  "backup.delete",
  "backup.restore",
  "backup.settings",
  // Off-site replication: ADMIN handles day-to-day operator intervention
  // (retry / verify / reconcile) but NOT the destructive verbs. `restore`
  // and `settings` are SUPER_ADMIN-only by baseline; the former initiates
  // a destructive restore, the latter can disable the whole off-site
  // pipeline or rewire the Drive folder identity.
  "backup.replication.restore",
  "backup.replication.settings"
];

export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  SUPER_ADMIN: ALL,
  // Admin: everything except user/role admin AND the destructive backup verbs.
  ADMIN: ALL.filter((p) => !ADMIN_DENIED.includes(p)),
  // Sales: sees registrants, can edit + email + export, view-only elsewhere.
  SALES: [
    "dashboard.view",
    "registrants.view",
    "registrants.edit",
    "registrants.export",
    "registrants.email",
    "checkin.view",
    "sessions.view",
    "speakers.view",
    "analytics.view"
  ],
  REGISTRATION_MANAGER: [
    "dashboard.view",
    "registrants.view",
    "registrants.edit",
    "registrants.export",
    "registrants.email",
    "applications.view",
    "applications.manage",
    "checkin.view",
    "sessions.view",
    "speakers.view",
    "audit.view",
    // Owns credential issuance and per-room grant/revoke.
    "badge.manage",
    "access.view",
    "access.manage"
  ],
  CHECKIN_OPERATOR: [
    "dashboard.view",
    "checkin.view",
    "checkin.validate",
    "registrants.view",
    "gates.view",
    // Scanner operator — allowed at both the main entrance (new QR path)
    // and any room. Legacy `checkin.validate` above still authorizes the
    // manual code flow.
    "access.validate.main",
    "access.validate.room"
  ],
  CONTENT_MANAGER: [
    "dashboard.view",
    "sessions.view",
    "sessions.manage",
    "speakers.view",
    "speakers.manage",
    "itineraries.view",
    "itineraries.manage"
  ],
  SPONSOR_MANAGER: [
    "dashboard.view",
    "sponsors.view",
    "sponsors.manage",
    "applications.view",
    "applications.manage"
  ],
  FINANCE: [
    "dashboard.view",
    "registrants.view",
    "analytics.view",
    "audit.view"
  ],
  ANALYTICS: ["dashboard.view", "analytics.view", "registrants.view"],
  VIEWER: [
    "dashboard.view",
    "registrants.view",
    "sessions.view",
    "speakers.view",
    "sponsors.view",
    "applications.view"
  ]
};

export function can(role: AdminRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

export const ROLE_LABEL: Record<AdminRole, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  SALES: "Sales",
  REGISTRATION_MANAGER: "Registration Manager",
  CHECKIN_OPERATOR: "Check-in Operator",
  CONTENT_MANAGER: "Content Manager",
  SPONSOR_MANAGER: "Sponsor Manager",
  FINANCE: "Finance",
  ANALYTICS: "Analytics",
  VIEWER: "Viewer"
};

export async function canWithOverrides(
  role: AdminRole,
  perm: Permission
): Promise<boolean> {
  const override = await prisma.rolePermissionOverride.findUnique({
    where: { role_permission: { role, permission: perm } }
  });
  if (override) return override.granted;
  return can(role, perm);
}

// ─── Access-point validators (Phase 3, hardened pre-Phase 5) ───────────────
// Convenience wrappers Phase 10 / 11 scanner routes will call to authorize
// an operator. Both are STRICT — legacy `checkin.validate` is NEVER accepted.
// They go through canWithOverrides() so DB overrides are respected.
//
// Why strict, and why no legacy fallback:
//   The QR flow is a NEW access surface. A role that historically held only
//   `checkin.validate` (for the manual ticket-code flow at /admin/check-in)
//   must NOT gain automatic QR authorization simply because Phase 10/11
//   landed. Role holders who should operate a QR scanner must be granted
//   the new permission explicitly (either via ROLE_PERMISSIONS or via a
//   RolePermissionOverride).
//
//   The legacy manual flow (app/admin/(protected)/check-in/actions.ts)
//   continues to call `requirePermission("checkin.validate")` DIRECTLY
//   and does not use these helpers, so it is unaffected.
export async function canValidateMainEntrance(
  role: AdminRole
): Promise<boolean> {
  return canWithOverrides(role, "access.validate.main");
}

export async function canValidateRoom(role: AdminRole): Promise<boolean> {
  return canWithOverrides(role, "access.validate.room");
}

export async function getEffectivePermissions(
  role: AdminRole
): Promise<Permission[]> {
  const overrides = await prisma.rolePermissionOverride.findMany({
    where: { role }
  });
  const overrideMap = new Map<string, boolean>();
  for (const o of overrides) {
    overrideMap.set(o.permission, o.granted);
  }
  const baseline = ROLE_PERMISSIONS[role] ?? [];
  const result = new Set<Permission>();
  for (const p of baseline) {
    const ov = overrideMap.get(p);
    if (ov !== false) result.add(p);
  }
  for (const [perm, granted] of overrideMap) {
    if (granted && PERMISSIONS.includes(perm as Permission)) {
      result.add(perm as Permission);
    }
  }
  return Array.from(result);
}

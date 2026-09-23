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

  "revenue.view",
  "revenue.reconcile",

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

  // ─── Room-registration payment boundary (Sub-Phase D) ────────────────
  // payment.confirm.room  — trusted admin confirmation of a PENDING_PAYMENT
  //                         room registration → PAID. Held by SUPER_ADMIN,
  //                         ADMIN, and FINANCE. Distinct from the historic
  //                         `revenue.reconcile` permission because room
  //                         registration payments are a separate domain
  //                         from event-level registration revenue.
  // payment.refund.room   — trusted admin refund of a PAID room
  //                         registration → REFUNDED. Same holders as
  //                         confirm; a refund is a compensating financial
  //                         action and belongs in the same authorisation
  //                         circle.
  //
  // These permissions gate the admin server actions in
  // `app/admin/(protected)/registrants/[id]/room-payment-actions.ts`.
  // Cancellation (PENDING_PAYMENT / FREE_CONFIRMED / PAID → CANCELLED) is
  // NOT protected by a new permission — it re-uses `access.manage`, which
  // is the existing permission that already governs a registrant's per-
  // room access entitlement.
  "payment.confirm.room",
  "payment.refund.room"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

// Role → Permissions map. Server-side is the source of truth.
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  SUPER_ADMIN: ALL,
  // Admin: everything except money section (revenue) + no user/role admin.
  // SECURITY NOTE: Admin keeps registrants.export + analytics.view. When
  // those screens are implemented, they must NOT include payment amounts,
  // paymentRef, or aggregated revenue figures unless the caller also holds
  // revenue.view. Enforce at the query layer, not the UI.
  ADMIN: ALL.filter(
    (p) =>
      p !== "roles.manage" &&
      p !== "users.manage" &&
      p !== "revenue.view" &&
      p !== "revenue.reconcile" &&
      // Sub-Phase D — room payment confirmation/refund is a
      // financial action. ADMIN does not hold `revenue.reconcile`, so
      // by the same principle it does not hold the room payment
      // confirm/refund permissions. FINANCE + SUPER_ADMIN are the
      // authorised roles; a RolePermissionOverride can grant ADMIN
      // temporary access if operational needs require it.
      p !== "payment.confirm.room" &&
      p !== "payment.refund.room"
  ),
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
    "revenue.view",
    "revenue.reconcile",
    "registrants.view",
    "analytics.view",
    "audit.view",
    // Sub-Phase D — FINANCE is the primary holder of the room-payment
    // confirm/refund boundary. SUPER_ADMIN inherits these via ALL.
    // ADMIN is explicitly excluded above so a room payment confirm
    // requires a distinct financial authorisation.
    "payment.confirm.room",
    "payment.refund.room"
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

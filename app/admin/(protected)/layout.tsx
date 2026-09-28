import { requireAdmin } from "@/lib/admin/auth";
import { getEffectivePermissions } from "@/lib/admin/rbac";
import { AdminSidebar } from "@/components/admin/sidebar";

// Phase 10: switched from the baseline `ROLE_PERMISSIONS` map to
// `getEffectivePermissions()` so the sidebar reflects any
// RolePermissionOverride rows an operator has applied. This is a UX
// correctness fix, NOT a change to authorization: every page + server
// action still authorises via `requirePermission()` / `canWithOverrides()`
// server-side. Prior behaviour hid entries a role had been GRANTED via
// override, and left entries visible that a role had been REVOKED via
// override — both were cosmetic but confusing.
export default async function ProtectedAdminLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const { user } = await requireAdmin();
  const allowed = await getEffectivePermissions(user.role);

  return (
    <div className="flex min-h-screen bg-frost text-ink">
      <AdminSidebar allowedPermissions={allowed} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

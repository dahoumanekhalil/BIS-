import { requireAdmin } from "@/lib/admin/auth";
import { ROLE_PERMISSIONS } from "@/lib/admin/rbac";
import { AdminSidebar } from "@/components/admin/sidebar";

export default async function ProtectedAdminLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const { user } = await requireAdmin();
  const allowed = ROLE_PERMISSIONS[user.role];

  return (
    <div className="flex min-h-screen bg-frost text-ink">
      <AdminSidebar allowedPermissions={allowed} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

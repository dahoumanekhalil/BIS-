import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { prisma } from "@/lib/db";
import { ROLE_LABEL, type Permission } from "@/lib/admin/rbac";
import { AdminRole, AdminStatus } from "@prisma/client";
import { UserTable } from "./user-table";
import { CreateUserDialog } from "./create-user-dialog";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const { user } = await requirePermission("users.manage");

  const users = await prisma.adminUser.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  const stats = {
    total: users.length,
    active: users.filter((u) => u.status === AdminStatus.ACTIVE).length,
    disabled: users.filter((u) => u.status === AdminStatus.DISABLED).length,
  };

  return (
    <>
      <AdminHeader user={user} title="Utilisateurs" subtitle="Administration" />
      <div className="space-y-6 p-6">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Total" value={stats.total} tone="ink" />
          <StatCard label="Actifs" value={stats.active} tone="lime" />
          <StatCard label="Désactivés" value={stats.disabled} tone="red" />
        </div>

        {/* Actions bar */}
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[16px] font-black tracking-tight text-ink">
            Comptes administrateurs
          </h2>
          <CreateUserDialog />
        </div>

        {/* Users table */}
        <UserTable users={users} />
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ink" | "lime" | "red";
}) {
  const colors = {
    ink: "bg-white border-line text-ink",
    lime: "bg-lime/10 border-lime/30 text-ink",
    red: "bg-red-50 border-red-200 text-red-700",
  };

  return (
    <div className={`rounded-card border px-5 py-4 ${colors[tone]}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
        {label}
      </p>
      <p className="mt-1 font-display text-[28px] font-black leading-none tabular-nums">
        {value}
      </p>
    </div>
  );
}
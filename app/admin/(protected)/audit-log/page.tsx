import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminAuditLogPage() {
  const { user } = await requirePermission("audit.view");
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { user: { select: { name: true, email: true } } }
  });

  return (
    <>
      <AdminHeader user={user} title="Audit log" subtitle="System" />
      <div className="p-6">
        <div className="overflow-hidden rounded-card border border-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="bg-frost text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Utilisateur</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Entité</th>
                  <th className="px-4 py-3">Meta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-16">
                      <EmptyState title="Aucune activité enregistrée." />
                    </td>
                  </tr>
                )}
                {logs.map((l) => (
                  <tr key={l.id} className="hover:bg-frost">
                    <td className="px-4 py-3 text-[12px] text-ink/60">
                      {new Intl.DateTimeFormat("fr-FR", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit"
                      }).format(l.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-ink/75">
                      {l.user?.name ?? "system"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-cobalt">
                      {l.action}
                    </td>
                    <td className="px-4 py-3 text-ink/60">
                      {l.entity ? `${l.entity}${l.entityId ? ` · ${l.entityId.slice(0, 8)}…` : ""}` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-ink/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-ink/70">
                        {l.meta ? JSON.stringify(l.meta).slice(0, 60) : "—"}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

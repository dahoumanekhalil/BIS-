import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminSessionsPage() {
  const { user } = await requirePermission("sessions.view");
  const sessions = await prisma.session.findMany({
    orderBy: { startsAt: "asc" },
    include: {
      space: true,
      speakers: { include: { speaker: true } }
    }
  });

  const dt = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);

  return (
    <>
      <AdminHeader user={user} title="Sessions" subtitle="Event" />
      <div className="p-6">
        <div className="overflow-hidden rounded-card border border-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead className="bg-frost text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                <tr>
                  <th className="px-4 py-3">Titre</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Créneau</th>
                  <th className="px-4 py-3">Durée</th>
                  <th className="px-4 py-3">Espace</th>
                  <th className="px-4 py-3">Intervenants</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-16">
                      <EmptyState
                        title="Aucune session."
                        hint="Les sessions apparaissent ici dès qu'elles sont ajoutées via le seed ou l'API."
                      />
                    </td>
                  </tr>
                )}
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-frost">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-ink">{s.title}</p>
                      {s.summary && (
                        <p className="mt-0.5 line-clamp-1 text-[11.5px] text-ink/55">
                          {s.summary}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-cobalt/10 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-cobalt">
                        {s.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink/70">{dt(s.startsAt)}</td>
                    <td className="px-4 py-3 tabular-nums text-ink/70">
                      {s.durationMin} min
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      {s.space?.name ?? s.stage ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      {s.speakers
                        .map((ss) => ss.speaker.fullName)
                        .join(", ") || "—"}
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

import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { CheckInPanel } from "./check-in-panel";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function CheckInPage() {
  const { user } = await requirePermission("checkin.view");
  const [recent, gateCounts] = await Promise.all([
    prisma.checkIn.findMany({
      orderBy: { scannedAt: "desc" },
      take: 12,
      include: {
        participant: {
          select: { firstName: true, lastName: true, tier: true }
        }
      }
    }),
    prisma.checkIn.groupBy({
      by: ["gate"],
      _count: { _all: true },
      where: { result: "VALID" }
    })
  ]);

  const gateMap = new Map<string, number>();
  for (const g of gateCounts) gateMap.set(g.gate, g._count._all);

  return (
    <>
      <AdminHeader user={user} title="Check-in center" subtitle="Operations" />

      <div className="grid gap-6 p-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <CheckInPanel canValidate />
        </div>

        <aside className="space-y-5 lg:col-span-4">
          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Trafic par porte
            </p>
            <ul className="mt-4 space-y-3 text-[13px]">
              {["Gate A", "Gate B", "Gate C", "Gate D"].map((g) => {
                const c = gateMap.get(g) ?? 0;
                return (
                  <li
                    key={g}
                    className="flex items-center justify-between"
                  >
                    <span className="font-semibold text-ink">{g}</span>
                    <span className="tabular-nums text-ink/70">
                      {c.toLocaleString("fr-FR")}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Derniers scans
            </p>
            {recent.length === 0 ? (
              <p className="mt-4 text-[13px] text-ink/55">
                Aucun scan encore.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-line text-[13px]">
                {recent.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">
                        {r.participant
                          ? `${r.participant.firstName} ${r.participant.lastName}`
                          : r.ticketCode}
                      </p>
                      <p className="truncate text-[11px] text-ink/50">
                        {r.gate} ·{" "}
                        {new Intl.DateTimeFormat("fr-FR", {
                          hour: "2-digit",
                          minute: "2-digit"
                        }).format(r.scannedAt)}
                      </p>
                    </div>
                    <span
                      className={
                        r.result === "VALID"
                          ? "text-[10.5px] font-bold uppercase tracking-[0.16em] text-lime-600"
                          : r.result === "ALREADY_CHECKED_IN"
                            ? "text-[10.5px] font-bold uppercase tracking-[0.16em] text-amber-600"
                            : "text-[10.5px] font-bold uppercase tracking-[0.16em] text-red-600"
                      }
                    >
                      {r.result.replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

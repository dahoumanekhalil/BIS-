import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { getAdminOverview } from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import {
  KpiCard,
  StatusBadge,
  TierBadge,
  EmptyState
} from "@/components/admin/ui";
import { RegistrationTier } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage({
  searchParams
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const { user } = await requirePermission("dashboard.view");
  const sp = await searchParams;
  const data = await getAdminOverview();

  const tierCount = (t: RegistrationTier | null) =>
    data.tierCounts.get(t) ?? 0;

  return (
    <>
      <AdminHeader user={user} title="Command Center" subtitle="Dashboard" />

      <div className="space-y-8 p-6">
        {sp?.denied && (
          <div
            role="alert"
            className="rounded-btn border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900"
          >
            Vous n&apos;avez pas la permission « {sp.denied} ».
          </div>
        )}

        {/* Primary KPIs */}
        <section>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Summit overview · 3-5 Janvier 2027 · CIC Alger
          </p>
          {/* Payment-removal Phase 3: `Paid` and `Revenue` KPIs are gone
              alongside the payment schema drop. The overview is now
              registrants + check-ins only. */}
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <KpiCard
              label="Total registrants"
              value={data.totalRegistrants.toLocaleString("fr-FR")}
              hint={`${data.pending} en attente · ${data.cancelled} annulés`}
              tone="cobalt"
              href="/admin/registrants"
            />
            <KpiCard
              label="Checked-in"
              value={data.checkedIn.toLocaleString("fr-FR")}
              hint={
                data.totalRegistrants > 0
                  ? `${Math.round((data.checkedIn / data.totalRegistrants) * 100)}% des inscrits`
                  : "Aucun check-in encore"
              }
              tone="lime"
              href="/admin/check-in"
            />
            <KpiCard
              label="À confirmer"
              value={data.pending}
              hint="Inscriptions en attente de confirmation"
              tone="warn"
              href="/admin/registrants?status=REGISTERED"
            />
          </div>
        </section>

        {/* Tier breakdown */}
        <section>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Répartition par tier
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="VVIP"
              value={tierCount("VVIP")}
              tone="cobalt"
              href="/admin/registrants?tier=VVIP"
            />
            <KpiCard
              label="VIP"
              value={tierCount("VIP")}
              tone="cobalt"
              href="/admin/registrants?tier=VIP"
            />
            <KpiCard
              label="Content Creator"
              value={tierCount("CONTENT_CREATOR")}
              tone="lime"
              href="/admin/registrants?tier=CONTENT_CREATOR"
            />
            <KpiCard
              label="À confirmer"
              value={data.pending}
              hint="Inscriptions en attente de confirmation"
              tone="warn"
              href="/admin/registrants?status=REGISTERED"
            />
          </div>
        </section>

        {/* Live ops */}
        <section className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-card border border-line bg-white p-5 lg:col-span-2">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
                Live operations · Gate traffic
              </p>
              <Link
                href="/admin/check-in"
                className="text-[11.5px] font-semibold text-cobalt hover:underline"
              >
                Check-in center →
              </Link>
            </div>
            {data.gateCounts.size === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title="Aucun check-in enregistré."
                  hint="Les statistiques par porte apparaissent dès qu'un opérateur valide un ticket."
                />
              </div>
            ) : (
              <ul className="mt-5 space-y-3">
                {["Gate A", "Gate B", "Gate C", "Gate D"].map((g) => {
                  const count = data.gateCounts.get(g) ?? 0;
                  const pct =
                    data.checkedIn > 0
                      ? Math.round((count / data.checkedIn) * 100)
                      : 0;
                  return (
                    <li key={g}>
                      <div className="flex items-baseline justify-between text-[12.5px]">
                        <span className="font-semibold text-ink">{g}</span>
                        <span className="tabular-nums text-ink/70">
                          {count.toLocaleString("fr-FR")} · {pct}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink/[0.06]">
                        <div
                          className="h-full rounded-full bg-cobalt"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Alertes opérationnelles
            </p>
            {/* Payment-removal Phase 3: the "unpaid" bullet is gone; the
                other two are non-financial signals about registration
                state. */}
            <ul className="mt-4 space-y-3 text-[13px] text-ink/75">
              {data.pending > 0 && (
                <li className="flex items-start gap-2">
                  <Dot color="amber" />
                  {data.pending} inscription{data.pending > 1 ? "s" : ""} à confirmer
                </li>
              )}
              {data.cancelled > 0 && (
                <li className="flex items-start gap-2">
                  <Dot color="red" />
                  {data.cancelled} inscription{data.cancelled > 1 ? "s" : ""} annulée{data.cancelled > 1 ? "s" : ""}
                </li>
              )}
              {data.pending === 0 && data.cancelled === 0 && (
                <li className="text-ink/50">
                  Aucune alerte pour le moment.
                </li>
              )}
            </ul>
          </div>
        </section>

        {/* Recent activity */}
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-card border border-line bg-white p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
                Dernières inscriptions
              </p>
              <Link
                href="/admin/registrants"
                className="text-[11.5px] font-semibold text-cobalt hover:underline"
              >
                Voir tout →
              </Link>
            </div>
            {data.recentRegistrants.length === 0 ? (
              <div className="mt-4">
                <EmptyState title="Aucune inscription pour le moment." />
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {data.recentRegistrants.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/admin/registrants/${r.id}`}
                        className="truncate font-semibold text-ink hover:underline"
                      >
                        {r.firstName} {r.lastName}
                      </Link>
                      <p className="truncate text-[11.5px] text-ink/55">
                        {r.email}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <TierBadge tier={r.tier} />
                      <StatusBadge status={r.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-card border border-line bg-white p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
                Derniers check-ins
              </p>
              <Link
                href="/admin/audit-log"
                className="text-[11.5px] font-semibold text-cobalt hover:underline"
              >
                Journal →
              </Link>
            </div>
            {data.recentCheckIns.length === 0 ? (
              <div className="mt-4">
                <EmptyState title="Aucun check-in enregistré." />
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {data.recentCheckIns.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">
                        {c.participant
                          ? `${c.participant.firstName} ${c.participant.lastName}`
                          : c.ticketCode}
                      </p>
                      <p className="truncate text-[11.5px] text-ink/55">
                        {c.gate} ·{" "}
                        {new Intl.DateTimeFormat("fr-FR", {
                          hour: "2-digit",
                          minute: "2-digit",
                          day: "2-digit",
                          month: "short"
                        }).format(c.scannedAt)}
                      </p>
                    </div>
                    <StatusBadge status={c.result} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function Dot({ color }: { color: "amber" | "red" | "cobalt" | "lime" }) {
  const map = {
    amber: "bg-amber-400",
    red: "bg-red-500",
    cobalt: "bg-cobalt",
    lime: "bg-lime"
  } as const;
  return (
    <span
      aria-hidden
      className={`mt-[7px] h-1.5 w-1.5 flex-none rounded-full ${map[color]}`}
    />
  );
}

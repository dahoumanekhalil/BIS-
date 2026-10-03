import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { getAdminOverview } from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { StatusBadge, TierBadge, EmptyState } from "@/components/admin/ui";
import type { RegistrationTier } from "@prisma/client";

export const dynamic = "force-dynamic";

const fr = (n: number) => n.toLocaleString("fr-FR");

const TIER_ROWS: Array<{
  key: RegistrationTier | null;
  label: string;
  bar: string;
  href: string;
}> = [
  { key: "VVIP", label: "VVIP", bar: "bg-cobalt", href: "?tier=VVIP" },
  { key: "VIP", label: "VIP", bar: "bg-cobalt/70", href: "?tier=VIP" },
  {
    key: "CONTENT_CREATOR",
    label: "Content Creator",
    bar: "bg-lime",
    href: "?tier=CONTENT_CREATOR"
  },
  {
    key: "IMPACT_MAKER",
    label: "Impact Maker",
    bar: "bg-lime-600",
    href: "?tier=IMPACT_MAKER"
  },
  { key: "VISITOR", label: "Visiteur", bar: "bg-ink/40", href: "?tier=VISITOR" },
  { key: null, label: "Sans catégorie", bar: "bg-ink/20", href: "" }
];

export default async function AdminDashboardPage({
  searchParams
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const { user } = await requirePermission("dashboard.view");
  const sp = await searchParams;
  const data = await getAdminOverview();

  const total = data.totalRegistrants;
  const checkedInPct =
    total > 0 ? Math.round((data.checkedIn / total) * 100) : 0;
  const firstName = user.name.split(" ")[0] || user.name;

  return (
    <>
      <AdminHeader
        user={user}
        title="Tableau de bord"
        subtitle="Vue d'ensemble"
      />

      <div className="min-h-[calc(100vh-76px)] space-y-6 bg-frost p-6 lg:p-8">
        {sp?.denied && (
          <div
            role="alert"
            className="rounded-card border border-amber-300 bg-amber-50 px-4 py-3 text-[14px] text-amber-900"
          >
            Vous n&apos;avez pas la permission « {sp.denied} ».
          </div>
        )}

        {/* Welcome */}
        <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-6 shadow-[0_1px_2px_rgba(15,25,60,0.05)] sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-[24px] font-black tracking-tight text-ink">
              Bonjour, {firstName}
            </h2>
            <p className="mt-1 text-[14.5px] text-ink/70">
              Voici l&apos;état du sommet · 3-5 janvier 2027 · CIC Alger
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <Link
              href="/admin/registrants"
              className="inline-flex items-center rounded-btn bg-ink px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-ink/85"
            >
              Voir les inscrits
            </Link>
            <Link
              href="/admin/check-in"
              className="inline-flex items-center rounded-btn border border-line bg-white px-4 py-2.5 text-[13.5px] font-semibold text-ink transition-colors hover:border-ink/30"
            >
              Ouvrir le check-in
            </Link>
          </div>
        </section>

        {/* Key figures */}
        <section
          aria-label="Chiffres clés"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <StatCard
            href="/admin/registrants"
            icon="users"
            tone="cobalt"
            label="Inscrits"
            value={fr(total)}
            hint="Total des inscriptions"
          />
          <StatCard
            href="/admin/check-in"
            icon="check"
            tone="lime"
            label="Check-ins"
            value={fr(data.checkedIn)}
            hint={
              total > 0
                ? `${checkedInPct} % des inscrits sont arrivés`
                : "Aucun check-in pour le moment"
            }
            progress={checkedInPct}
          />
          <StatCard
            href="/admin/registrants?status=REGISTERED"
            icon="clock"
            tone="amber"
            label="À confirmer"
            value={fr(data.pending)}
            hint={
              data.pending > 0
                ? "En attente de confirmation"
                : "Tout est confirmé"
            }
          />
          <StatCard
            href="/admin/registrants?status=CANCELLED"
            icon="x"
            tone="red"
            label="Annulés"
            value={fr(data.cancelled)}
            hint={
              data.cancelled > 0 ? "Inscriptions annulées" : "Aucune annulation"
            }
          />
        </section>

        {/* Tiers + gates */}
        <section className="grid gap-6 lg:grid-cols-2">
          <Card
            title="Répartition par catégorie"
            description="Nombre d'inscrits par type de pass."
          >
            <ul className="space-y-4">
              {TIER_ROWS.map((row) => {
                const count = data.tierCounts.get(row.key) ?? 0;
                if (row.key === null && count === 0) return null;
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                const label = (
                  <span className="text-[14px] font-semibold text-ink">
                    {row.label}
                  </span>
                );
                return (
                  <li key={row.label}>
                    <div className="flex items-baseline justify-between gap-3">
                      {row.href ? (
                        <Link
                          href={`/admin/registrants${row.href}`}
                          className="hover:underline"
                        >
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                      <span className="text-[14px] tabular-nums text-ink/70">
                        <strong className="font-bold text-ink">
                          {fr(count)}
                        </strong>{" "}
                        · {pct} %
                      </span>
                    </div>
                    <Bar pct={pct} color={row.bar} />
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card
            title="Affluence par porte"
            description="Répartition des check-ins validés."
            action={{ href: "/admin/check-in", label: "Centre de check-in" }}
          >
            {data.gateCounts.size === 0 ? (
              <EmptyState
                title="Aucun check-in enregistré."
                hint="Les statistiques par porte apparaissent dès qu'un opérateur valide un ticket."
              />
            ) : (
              <ul className="space-y-4">
                {["Gate A", "Gate B", "Gate C", "Gate D"].map((g) => {
                  const count = data.gateCounts.get(g) ?? 0;
                  const pct =
                    data.checkedIn > 0
                      ? Math.round((count / data.checkedIn) * 100)
                      : 0;
                  return (
                    <li key={g}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[14px] font-semibold text-ink">
                          {g.replace("Gate", "Porte")}
                        </span>
                        <span className="text-[14px] tabular-nums text-ink/70">
                          <strong className="font-bold text-ink">
                            {fr(count)}
                          </strong>{" "}
                          · {pct} %
                        </span>
                      </div>
                      <Bar pct={pct} color="bg-cobalt" />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>

        {/* Alerts */}
        <Card
          title="À surveiller"
          description="Les points qui demandent votre attention."
        >
          {data.pending === 0 && data.cancelled === 0 ? (
            <p className="flex items-center gap-3 rounded-card bg-lime/15 px-4 py-3 text-[14px] font-medium text-ink">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-lime-600" />
              Tout est en ordre, aucune alerte pour le moment.
            </p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {data.pending > 0 && (
                <li>
                  <Link
                    href="/admin/registrants?status=REGISTERED"
                    className="flex items-center gap-3 rounded-card bg-amber-50 px-4 py-3 text-[14px] text-amber-950 transition-colors hover:bg-amber-100"
                  >
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                    <span>
                      <strong>{fr(data.pending)}</strong> inscription
                      {data.pending > 1 ? "s" : ""} à confirmer
                    </span>
                  </Link>
                </li>
              )}
              {data.cancelled > 0 && (
                <li>
                  <Link
                    href="/admin/registrants?status=CANCELLED"
                    className="flex items-center gap-3 rounded-card bg-red-50 px-4 py-3 text-[14px] text-red-950 transition-colors hover:bg-red-100"
                  >
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    <span>
                      <strong>{fr(data.cancelled)}</strong> inscription
                      {data.cancelled > 1 ? "s" : ""} annulée
                      {data.cancelled > 1 ? "s" : ""}
                    </span>
                  </Link>
                </li>
              )}
            </ul>
          )}
        </Card>

        {/* Recent activity */}
        <section className="grid gap-6 lg:grid-cols-2">
          <Card
            title="Dernières inscriptions"
            action={{ href: "/admin/registrants", label: "Voir tout" }}
          >
            {data.recentRegistrants.length === 0 ? (
              <EmptyState title="Aucune inscription pour le moment." />
            ) : (
              <ul className="divide-y divide-line">
                {data.recentRegistrants.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={`${r.firstName} ${r.lastName}`} />
                      <div className="min-w-0">
                        <Link
                          href={`/admin/registrants/${r.id}`}
                          className="block truncate text-[14.5px] font-semibold text-ink hover:underline"
                        >
                          {r.firstName} {r.lastName}
                        </Link>
                        <p className="truncate text-[13px] text-ink/60">
                          {r.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <TierBadge tier={r.tier} />
                      <StatusBadge status={r.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Derniers check-ins"
            action={{ href: "/admin/audit-log", label: "Journal" }}
          >
            {data.recentCheckIns.length === 0 ? (
              <EmptyState title="Aucun check-in enregistré." />
            ) : (
              <ul className="divide-y divide-line">
                {data.recentCheckIns.map((c) => {
                  const who = c.participant
                    ? `${c.participant.firstName} ${c.participant.lastName}`
                    : c.ticketCode;
                  return (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar name={who} />
                        <div className="min-w-0">
                          <p className="truncate text-[14.5px] font-semibold text-ink">
                            {who}
                          </p>
                          <p className="truncate text-[13px] text-ink/60">
                            {c.gate} ·{" "}
                            {new Intl.DateTimeFormat("fr-FR", {
                              hour: "2-digit",
                              minute: "2-digit",
                              day: "2-digit",
                              month: "short"
                            }).format(c.scannedAt)}
                          </p>
                        </div>
                      </div>
                      <StatusBadge status={c.result} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </>
  );
}

// ─── Presentational helpers ────────────────────────────────────────────────

function Card({
  title,
  description,
  action,
  children
}: {
  title: string;
  description?: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white p-6 shadow-[0_1px_2px_rgba(15,25,60,0.05)]">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-bold tracking-tight text-ink">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-[13px] text-ink/60">{description}</p>
          )}
        </div>
        {action && (
          <Link
            href={action.href}
            className="shrink-0 text-[13px] font-semibold text-cobalt hover:underline"
          >
            {action.label} →
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-ink/[0.07]">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${Math.min(100, Math.max(pct > 0 ? 3 : 0, pct))}%` }}
      />
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?";
  return (
    <span
      aria-hidden
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cobalt/10 text-[12.5px] font-bold text-cobalt"
    >
      {initials}
    </span>
  );
}

const TONE = {
  cobalt: { chip: "bg-cobalt/10 text-cobalt", bar: "bg-cobalt" },
  lime: { chip: "bg-lime/25 text-ink", bar: "bg-lime-600" },
  amber: { chip: "bg-amber-100 text-amber-800", bar: "bg-amber-500" },
  red: { chip: "bg-red-100 text-red-700", bar: "bg-red-500" }
} as const;

function StatCard({
  href,
  icon,
  tone,
  label,
  value,
  hint,
  progress
}: {
  href: string;
  icon: "users" | "check" | "clock" | "x";
  tone: keyof typeof TONE;
  label: string;
  value: string;
  hint: string;
  progress?: number;
}) {
  const t = TONE[tone];
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-line bg-white p-6 shadow-[0_1px_2px_rgba(15,25,60,0.05)] transition-shadow hover:shadow-[0_12px_32px_-18px_rgba(15,25,60,0.3)]"
    >
      <div className="flex items-center justify-between">
        <p className="text-[14px] font-semibold text-ink/75">{label}</p>
        <span
          aria-hidden
          className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${t.chip}`}
        >
          <Icon name={icon} />
        </span>
      </div>
      <p className="mt-3 font-display text-[38px] font-black leading-none tracking-tight text-ink tabular-nums">
        {value}
      </p>
      {progress !== undefined && (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink/[0.07]">
          <div
            className={`h-full rounded-full ${t.bar}`}
            style={{ width: `${Math.min(100, progress)}%` }}
          />
        </div>
      )}
      <p className="mt-3 text-[13px] text-ink/60">{hint}</p>
    </Link>
  );
}

function Icon({ name }: { name: "users" | "check" | "clock" | "x" }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
  switch (name) {
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
          <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.3c2 .6 3.5 2.6 3.5 5.2" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12.3 2.4 2.4 4.6-5" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </svg>
      );
  }
}

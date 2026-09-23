import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { KpiCard, StatusBadge, EmptyState } from "@/components/admin/ui";
import { cn } from "@/lib/utils";
import {
  getCheckinAnalytics,
  listAccessPointsForAnalytics,
  EVENT_TIMEZONE,
  type CheckinAnalyticsFilters,
  type SpaceMetrics,
  type HourlyBucket,
  type CoverageResult,
  type ResultBreakdownRow,
  type RecentActivityRow,
  type OperatorActivityRow,
  type DetailedRow,
  type MainEntranceMetrics
} from "@/lib/admin/checkin-analytics";
import { AccessPointType, CheckInResult } from "@prisma/client";
import { AnalyticsFilters, type FacetPoint } from "./analytics-filters";

// Check-in & Attendance Analytics dashboard.
//
// URL: /admin/scan/analytics
// Permission: analytics.view (existing).
//
// The page is fully server-rendered — the only client component is
// the filter bar (URL-driven). Every metric is a whitelist select
// query in lib/admin/checkin-analytics.ts. No participant IDs, no
// tokens, no payment amounts, no operator emails.

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics des check-ins" };

const CHECKIN_RESULTS: readonly CheckInResult[] = [
  "VALID",
  "ALREADY_CHECKED_IN",
  "WRONG_GATE",
  "WRONG_TIME",
  "CANCELLED",
  "UNKNOWN",
  "UNPAID"
] as const;

const PRESET_KEYS = new Set([
  "today",
  "yesterday",
  "7d",
  "event",
  "all"
]);

const EVENT_START = new Date("2017-01-03T00:00:00Z");
const EVENT_END = new Date("2017-01-05T23:59:59.999Z");

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// ─── Query-param parsing (server-side, defensive) ─────────────────

function pickString(
  v: string | string[] | undefined,
  maxLen = 64
): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.length > maxLen) return undefined;
  return s;
}

function pickDate(
  v: string | string[] | undefined,
  endOfDay = false
): Date | undefined {
  const s = pickString(v, 32);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(s + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function pickResult(
  v: string | string[] | undefined
): CheckInResult | undefined {
  const s = pickString(v, 32);
  if (!s) return undefined;
  return (CHECKIN_RESULTS as readonly string[]).includes(s)
    ? (s as CheckInResult)
    : undefined;
}

// Africa/Algiers-anchored day boundaries. `Date` operations use
// server-local time, which is UTC in production and drifts the
// "today" / "yesterday" boundaries by up to an hour off the event's
// operational day. Phase 21 audit A1 — every preset now uses the
// event timezone.
function startOfAlgiersDay(d: Date): Date {
  // Parts of d expressed in Algiers.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  // Africa/Algiers is a fixed UTC+1 zone (no DST). Anchor the day at
  // 00:00 Algiers → 23:00 UTC of the previous UTC-day.
  return new Date(`${y}-${m}-${day}T00:00:00+01:00`);
}

function endOfAlgiersDay(d: Date): Date {
  const start = startOfAlgiersDay(d);
  // +24h - 1ms
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function resolvePreset(
  preset: string | undefined
): { from: Date; to: Date } | undefined {
  if (!preset || !PRESET_KEYS.has(preset)) return undefined;
  const now = new Date();
  if (preset === "today") {
    return { from: startOfAlgiersDay(now), to: endOfAlgiersDay(now) };
  }
  if (preset === "yesterday") {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
      from: startOfAlgiersDay(yesterday),
      to: endOfAlgiersDay(yesterday)
    };
  }
  if (preset === "7d") {
    const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    return {
      from: startOfAlgiersDay(sixDaysAgo),
      to: endOfAlgiersDay(now)
    };
  }
  if (preset === "event") {
    return { from: EVENT_START, to: EVENT_END };
  }
  return undefined;
}

// ─── Page component ───────────────────────────────────────────────

export default async function CheckinAnalyticsPage({ searchParams }: PageProps) {
  const { user } = await requirePermission("analytics.view");
  const raw = await searchParams;

  const presetKey = pickString(raw.preset, 16);
  const preset = resolvePreset(presetKey);

  // Resolve access-point catalog once, upfront. Used to (a) drop a
  // hostile / unknown accessPointId before it hits the parallel
  // analytics loader (avoids 8 wasted queries with a random string)
  // and (b) drive the filter form's option list.
  const accessPoints = await listAccessPointsForAnalytics();
  const knownIds = new Set(accessPoints.map((p) => p.id));
  const rawApId = pickString(raw.accessPointId, 64);
  const scopedApId = rawApId && knownIds.has(rawApId) ? rawApId : undefined;

  const filters: CheckinAnalyticsFilters = {
    from: preset?.from ?? pickDate(raw.from),
    to: preset?.to ?? pickDate(raw.to, true),
    accessPointId: scopedApId,
    result: pickResult(raw.result)
  };

  const data = await getCheckinAnalytics(filters, accessPoints);

  const facetPoints: FacetPoint[] = accessPoints.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    type: p.type
  }));

  // Format Date → yyyy-mm-dd in Africa/Algiers so the date picker
  // shows the day the operator actually experienced (not the UTC day
  // that might land the day before). See Phase 21 audit A1 / A6.
  const filtersInitial = {
    from: filters.from ? algiersDayString(filters.from) : undefined,
    to: filters.to ? algiersDayString(filters.to) : undefined,
    accessPointId: scopedApId,
    result: filters.result,
    preset: presetKey && PRESET_KEYS.has(presetKey) ? presetKey : undefined
  };

  const totalActiveSpaces = accessPoints.filter(
    (p) => p.active && p.type === AccessPointType.ROOM
  ).length;

  const dt = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);
  const t = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);

  const totalValidScansAllPoints = data.spaces.reduce(
    (a, s) => a + s.validScans,
    0
  );

  return (
    <>
      <AdminHeader
        user={user}
        title="Analytics des check-ins"
        subtitle="Fréquentation, espaces & activité opérationnelle"
      />

      <div className="space-y-8 p-6">
        {/* Breadcrumb + refresh */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/admin/scan"
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
          >
            ← Centre de scan
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-ink/50">
              Dernière mise à jour : {t(data.generatedAt)}
            </span>
            <Link
              href={buildRefreshHref(raw)}
              prefetch={false}
              className="rounded-btn border border-line bg-white px-3 py-1.5 text-[11.5px] font-semibold text-ink/70 transition-colors hover:border-cobalt hover:text-cobalt"
            >
              Actualiser
            </Link>
            <Link
              href="/admin/scan/history"
              className="rounded-btn border border-line bg-white px-3 py-1.5 text-[11.5px] font-semibold text-ink/70 transition-colors hover:border-cobalt hover:text-cobalt"
            >
              Historique →
            </Link>
          </div>
        </div>

        <AnalyticsFilters points={facetPoints} initial={filtersInitial} />

        {/* KPI ROW ─ Top level */}
        <section aria-label="Indicateurs clés">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Vue d'ensemble
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Visiteurs entrés dans le salon"
              value={data.main.uniqueVisitors.toLocaleString("fr-FR")}
              hint="Participants distincts avec entrée principale validée"
              tone="cobalt"
            />
            <KpiCard
              label="Scans validés (tous points)"
              value={totalValidScansAllPoints.toLocaleString("fr-FR")}
              hint="Chaque scan valide compte, entrée + salles"
              tone="lime"
            />
            <KpiCard
              label="Entrées répétées"
              value={data.main.repeatScans.toLocaleString("fr-FR")}
              hint="Scans « déjà entré » à l'entrée principale"
              tone="default"
            />
            <KpiCard
              label="Espaces actifs"
              value={totalActiveSpaces.toLocaleString("fr-FR")}
              hint={`${accessPoints.length} point${accessPoints.length > 1 ? "s" : ""} d'accès au total`}
              tone="cobalt"
            />
          </div>
        </section>

        {/* Main entrance detail */}
        <MainAttendanceSection main={data.main} totalActiveSpaces={totalActiveSpaces} />

        {/* Space performance grid */}
        <SpacePerformanceSection
          spaces={data.spaces}
          uniqueMainVisitors={data.main.uniqueVisitors}
        />

        {/* Hourly traffic */}
        <HourlyTrafficSection buckets={data.hourly} />

        {/* Space comparison — side-by-side table */}
        <SpaceComparisonSection
          spaces={data.spaces}
          uniqueMainVisitors={data.main.uniqueVisitors}
        />

        {/* Cross-space coverage */}
        <CoverageSection coverage={data.coverage} />

        {/* Recent activity */}
        <RecentActivitySection rows={data.recent} formatDt={dt} />

        {/* Denied / rejected scans */}
        <DeniedScansSection
          breakdown={data.breakdown}
          points={accessPoints}
        />

        {/* Operator activity */}
        <OperatorActivitySection operators={data.operators} />

        {/* Detailed table */}
        <DetailedActivitySection rows={data.detailed} formatDt={dt} />
      </div>
    </>
  );
}

// ─── Sections ──────────────────────────────────────────────────────

function MainAttendanceSection({
  main,
  totalActiveSpaces
}: {
  main: MainEntranceMetrics;
  totalActiveSpaces: number;
}) {
  const total = main.uniqueVisitors + main.repeatScans + main.deniedScans;
  const validPct = total > 0 ? (main.uniqueVisitors / total) * 100 : 0;
  const repeatPct = total > 0 ? (main.repeatScans / total) * 100 : 0;
  const deniedPct = total > 0 ? (main.deniedScans / total) * 100 : 0;

  return (
    <section aria-label="Fréquentation du salon">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Fréquentation du salon
        </p>
        <p className="text-[11px] text-ink/50">
          Source : entrée principale (VALID)
        </p>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/50">
            Décomposition de l'activité à l'entrée principale
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Stat
              label="Visiteurs uniques"
              value={main.uniqueVisitors}
              accent="cobalt"
            />
            <Stat
              label="Entrées répétées"
              value={main.repeatScans}
              accent="lime"
            />
            <Stat
              label="Refus"
              value={main.deniedScans}
              accent="warn"
            />
          </div>
          {total === 0 ? (
            <div className="mt-6">
              <EmptyState
                title="Aucun scan à l'entrée principale pour cette période."
                hint="Ajustez la période, ou attendez le premier passage."
              />
            </div>
          ) : (
            <div className="mt-6">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                Répartition
              </p>
              <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-ink/[0.06]">
                <span
                  className="bg-cobalt"
                  style={{ width: `${validPct}%` }}
                  aria-label={`Visiteurs uniques ${validPct.toFixed(1)}%`}
                />
                <span
                  className="bg-lime"
                  style={{ width: `${repeatPct}%` }}
                  aria-label={`Entrées répétées ${repeatPct.toFixed(1)}%`}
                />
                <span
                  className="bg-amber-400"
                  style={{ width: `${deniedPct}%` }}
                  aria-label={`Refus ${deniedPct.toFixed(1)}%`}
                />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-ink/60">
                <LegendDot color="bg-cobalt" label={`Uniques ${validPct.toFixed(1)}%`} />
                <LegendDot color="bg-lime" label={`Répétées ${repeatPct.toFixed(1)}%`} />
                <LegendDot color="bg-amber-400" label={`Refus ${deniedPct.toFixed(1)}%`} />
              </div>
            </div>
          )}
        </div>
        <div className="rounded-card border border-cobalt/25 bg-cobalt/[0.03] p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
            Lecture rapide
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink/80">
            <strong>{main.uniqueVisitors.toLocaleString("fr-FR")}</strong>{" "}
            personne{main.uniqueVisitors > 1 ? "s" : ""} sont entrée
            {main.uniqueVisitors > 1 ? "s" : ""} dans le salon. Chaque
            personne n'est comptée qu'une seule fois, quel que soit le
            nombre de scans.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-ink/65">
            {totalActiveSpaces} espace{totalActiveSpaces > 1 ? "s" : ""} actif
            {totalActiveSpaces > 1 ? "s" : ""} — voir la grille par espace
            ci-dessous pour la couverture.
          </p>
        </div>
      </div>
    </section>
  );
}

function SpacePerformanceSection({
  spaces,
  uniqueMainVisitors
}: {
  spaces: SpaceMetrics[];
  uniqueMainVisitors: number;
}) {
  const mains = spaces.filter((s) => s.type === AccessPointType.MAIN_ENTRANCE);
  const rooms = spaces.filter((s) => s.type === AccessPointType.ROOM);

  const dt = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("fr-FR", {
          hour: "2-digit",
          minute: "2-digit"
        }).format(d)
      : "—";

  return (
    <section aria-label="Fréquentation par espace">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Fréquentation par espace
        </p>
        <p className="text-[11px] text-ink/50">
          {rooms.length} salle{rooms.length > 1 ? "s" : ""} · {mains.length} entrée{mains.length > 1 ? "s" : ""}
        </p>
      </div>

      {spaces.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="Aucun point d'accès configuré."
            hint="Créez au moins un point depuis « Access points »."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...mains, ...rooms].map((s) => (
            <SpaceCard
              key={s.accessPointId}
              space={s}
              uniqueMainVisitors={uniqueMainVisitors}
              formatTime={dt}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SpaceCard({
  space,
  uniqueMainVisitors,
  formatTime
}: {
  space: SpaceMetrics;
  uniqueMainVisitors: number;
  formatTime: (d: Date | null) => string;
}) {
  const isMain = space.type === AccessPointType.MAIN_ENTRANCE;
  const share =
    // For rooms, share is against unique main-entrance visitors (the
    // spec's requested definition, §12). MAIN_ENTRANCE cards omit it.
    !isMain && uniqueMainVisitors > 0
      ? (space.uniqueVisitors / uniqueMainVisitors) * 100
      : undefined;

  const detailHref =
    !isMain && space.active
      ? `/admin/scan/analytics/${encodeURIComponent(space.slug)}`
      : undefined;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-card border bg-white p-5 transition-shadow",
        space.active
          ? "border-line hover:shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]"
          : "border-ink/15 opacity-70"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-[16px] font-black tracking-tight text-ink">
            {space.name}
          </p>
          <p className="mt-1 flex flex-wrap gap-1.5">
            <span
              className={cn(
                "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
                isMain ? "bg-cobalt/15 text-cobalt" : "bg-lime/25 text-ink"
              )}
            >
              {isMain ? "Entrée" : "Salle"}
            </span>
            {!space.active && (
              <span className="rounded-full bg-ink/10 px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink/55">
                Désactivé
              </span>
            )}
          </p>
        </div>
        {share !== undefined && (
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink/50">
              % du salon
            </p>
            <p className="mt-0.5 font-display text-[20px] font-black leading-none text-cobalt tabular-nums">
              {share.toFixed(1)}%
            </p>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 border-t border-line pt-3">
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink/50">
            Visiteurs uniques
          </dt>
          <dd className="mt-0.5 font-display text-[22px] font-black leading-none text-ink tabular-nums">
            {space.uniqueVisitors.toLocaleString("fr-FR")}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink/50">
            {isMain ? "Scans validés" : "Entrées validées"}
          </dt>
          <dd className="mt-0.5 font-display text-[22px] font-black leading-none text-ink tabular-nums">
            {space.validScans.toLocaleString("fr-FR")}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink/50">
            {isMain ? "Répétées" : "Ré-entrées"}
          </dt>
          <dd className="mt-0.5 text-[13.5px] font-semibold text-ink tabular-nums">
            {space.repeatEntries.toLocaleString("fr-FR")}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink/50">
            Refus
          </dt>
          <dd
            className={cn(
              "mt-0.5 text-[13.5px] font-semibold tabular-nums",
              space.deniedScans > 0 ? "text-amber-700" : "text-ink"
            )}
          >
            {space.deniedScans.toLocaleString("fr-FR")}
          </dd>
        </div>
      </dl>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11px] text-ink/60">
        <span>
          {space.peakHour !== undefined && space.peakHourCount !== undefined ? (
            <>
              <strong>Pic :</strong> {formatHour(space.peakHour)} –{" "}
              {formatHour(space.peakHour + 1)} ·{" "}
              {space.peakHourCount.toLocaleString("fr-FR")} scans
            </>
          ) : (
            "Pas encore de pic"
          )}
        </span>
        <span>
          <strong>Dernier :</strong> {formatTime(space.lastScanAt)}
        </span>
      </div>

      {detailHref && (
        <Link
          href={detailHref}
          className="mt-1 inline-flex items-center justify-center gap-2 rounded-btn border border-line bg-frost/60 px-3 py-2 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
        >
          Détails de l&apos;espace →
        </Link>
      )}
    </div>
  );
}

function HourlyTrafficSection({ buckets }: { buckets: HourlyBucket[] }) {
  const maxVal = Math.max(...buckets.map((b) => Math.max(b.validScans, b.uniqueVisitors)), 1);
  const hasData = buckets.some((b) => b.validScans > 0);

  const width = 720;
  const height = 220;
  const padL = 36;
  const padR = 16;
  const padT = 16;
  const padB = 32;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const bandW = innerW / 24;

  return (
    <section aria-label="Trafic par heure">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Trafic par heure
        </p>
        <div className="flex items-center gap-3 text-[11px] text-ink/60">
          <LegendDot color="bg-cobalt" label="Scans validés" />
          <LegendDot color="bg-lime" label="Visiteurs uniques (entrée)" />
        </div>
      </div>

      {!hasData ? (
        <div className="mt-4">
          <EmptyState
            title="Aucun scan validé pour cette période."
            hint="La courbe apparaît dès que les opérateurs valident les premiers badges."
          />
        </div>
      ) : (
        <div className="mt-4 rounded-card border border-line bg-white p-4">
          <svg
            role="img"
            aria-label="Trafic horaire — scans validés et visiteurs uniques"
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
          >
            {/* Gridlines */}
            {[0.25, 0.5, 0.75, 1].map((r) => (
              <line
                key={r}
                x1={padL}
                x2={width - padR}
                y1={padT + innerH * (1 - r)}
                y2={padT + innerH * (1 - r)}
                stroke="#E6E8ED"
                strokeWidth={1}
              />
            ))}

            {/* Y-axis labels */}
            {[0, 0.5, 1].map((r) => (
              <text
                key={r}
                x={padL - 8}
                y={padT + innerH * (1 - r) + 4}
                textAnchor="end"
                fontSize={10}
                fill="#0A0A0A"
                opacity={0.5}
              >
                {Math.round(maxVal * r).toLocaleString("fr-FR")}
              </text>
            ))}

            {/* Bars — validScans */}
            {buckets.map((b, i) => {
              const x = padL + bandW * i + bandW * 0.15;
              const w = bandW * 0.35;
              const h = (b.validScans / maxVal) * innerH;
              return (
                <rect
                  key={`s-${i}`}
                  x={x}
                  y={padT + innerH - h}
                  width={w}
                  height={h}
                  rx={2}
                  fill="#2453E0"
                >
                  <title>
                    {formatHour(b.hour)} · {b.validScans} scans validés
                  </title>
                </rect>
              );
            })}
            {/* Bars — uniqueVisitors */}
            {buckets.map((b, i) => {
              const x = padL + bandW * i + bandW * 0.5;
              const w = bandW * 0.35;
              const h = (b.uniqueVisitors / maxVal) * innerH;
              return (
                <rect
                  key={`u-${i}`}
                  x={x}
                  y={padT + innerH - h}
                  width={w}
                  height={h}
                  rx={2}
                  fill="#B8E62E"
                >
                  <title>
                    {formatHour(b.hour)} · {b.uniqueVisitors} visiteurs uniques
                    à l'entrée
                  </title>
                </rect>
              );
            })}

            {/* X-axis labels every 3 hours */}
            {buckets
              .filter((_, i) => i % 3 === 0)
              .map((b) => (
                <text
                  key={`x-${b.hour}`}
                  x={padL + bandW * b.hour + bandW / 2}
                  y={height - padB + 16}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#0A0A0A"
                  opacity={0.55}
                >
                  {formatHour(b.hour)}
                </text>
              ))}
          </svg>
        </div>
      )}
    </section>
  );
}

function SpaceComparisonSection({
  spaces,
  uniqueMainVisitors
}: {
  spaces: SpaceMetrics[];
  uniqueMainVisitors: number;
}) {
  // Only rooms — the main entrance sits alone at the top. Sorted by
  // unique visitors DESC so operations sees the highest-traffic
  // spaces first. Deliberately factual: no "score" / "quality" column.
  const rooms = spaces
    .filter((s) => s.type === AccessPointType.ROOM)
    .slice()
    .sort((a, b) => b.uniqueVisitors - a.uniqueVisitors);

  return (
    <section aria-label="Comparaison des espaces">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Comparaison des espaces
        </p>
        <p className="text-[11px] text-ink/50">
          {rooms.length} salle{rooms.length > 1 ? "s" : ""} · triée{rooms.length > 1 ? "s" : ""} par visiteurs uniques
        </p>
      </div>
      {rooms.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="Aucune salle configurée."
            hint="Créez une salle depuis « Access points » pour la faire apparaître ici."
          />
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-frost/60 text-[10px] font-bold uppercase tracking-[0.16em] text-ink/55">
                <tr>
                  <th className="px-4 py-2.5">Espace</th>
                  <th className="px-4 py-2.5">Visiteurs uniques</th>
                  <th className="px-4 py-2.5">Entrées validées</th>
                  <th className="px-4 py-2.5">Ré-entrées</th>
                  <th className="px-4 py-2.5">Refus</th>
                  <th className="px-4 py-2.5">% du salon</th>
                  <th className="px-4 py-2.5">Pic</th>
                  <th className="px-4 py-2.5 sr-only">Détail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rooms.map((s) => {
                  const share =
                    uniqueMainVisitors > 0
                      ? (s.uniqueVisitors / uniqueMainVisitors) * 100
                      : null;
                  return (
                    <tr
                      key={s.accessPointId}
                      className={cn(!s.active && "opacity-60")}
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col">
                          <span className="font-semibold text-ink">
                            {s.name}
                          </span>
                          {!s.active && (
                            <span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/50">
                              Désactivé
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-display text-[15px] font-black tabular-nums text-ink">
                        {s.uniqueVisitors.toLocaleString("fr-FR")}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-ink/80">
                        {s.validScans.toLocaleString("fr-FR")}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-ink/70">
                        {s.repeatEntries.toLocaleString("fr-FR")}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2.5 tabular-nums",
                          s.deniedScans > 0 ? "text-amber-700" : "text-ink/70"
                        )}
                      >
                        {s.deniedScans.toLocaleString("fr-FR")}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-cobalt">
                        {share !== null ? `${share.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-ink/70">
                        {s.peakHour !== undefined ? formatHour(s.peakHour) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {s.active && (
                          <Link
                            href={`/admin/scan/analytics/${encodeURIComponent(s.slug)}`}
                            className="text-[11.5px] font-semibold text-cobalt hover:underline"
                          >
                            Détails →
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function CoverageSection({ coverage }: { coverage: CoverageResult }) {
  if (coverage.activeRoomCount === 0) {
    return (
      <section aria-label="Couverture des espaces">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Couverture des espaces
        </p>
        <div className="mt-4">
          <EmptyState
            title="Aucune salle active."
            hint="Activez au moins une salle pour mesurer la couverture."
          />
        </div>
      </section>
    );
  }

  const totalVisitorsInBuckets = coverage.buckets.reduce(
    (a, b) => a + (b.spacesVisited > 0 ? b.uniqueVisitors : 0),
    0
  );
  const maxBucketCount = Math.max(
    1,
    ...coverage.buckets.filter((b) => b.spacesVisited > 0).map((b) => b.uniqueVisitors)
  );

  return (
    <section aria-label="Couverture des espaces">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Couverture des espaces
        </p>
        <p className="text-[11px] text-ink/50">
          Sur {coverage.activeRoomCount} salle{coverage.activeRoomCount > 1 ? "s" : ""} active{coverage.activeRoomCount > 1 ? "s" : ""}
        </p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Nombre de salles visitées (visiteurs uniques)
          </p>
          <ul className="mt-4 space-y-3">
            {coverage.buckets
              .filter((b) => b.spacesVisited > 0)
              .map((b) => {
                const pct = (b.uniqueVisitors / maxBucketCount) * 100;
                return (
                  <li key={b.spacesVisited}>
                    <div className="flex items-baseline justify-between text-[12.5px]">
                      <span className="font-semibold text-ink">
                        {b.spacesVisited} salle{b.spacesVisited > 1 ? "s" : ""}
                        {b.spacesVisited === coverage.activeRoomCount &&
                          coverage.activeRoomCount > 0 && (
                            <span className="ml-2 rounded-full bg-lime/25 px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.14em] text-ink">
                              Tous les espaces
                            </span>
                          )}
                      </span>
                      <span className="tabular-nums text-ink/70">
                        {b.uniqueVisitors.toLocaleString("fr-FR")} visiteur
                        {b.uniqueVisitors > 1 ? "s" : ""}
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
            {totalVisitorsInBuckets === 0 && (
              <li className="rounded-btn border border-dashed border-line px-3 py-3 text-center text-[12px] text-ink/55">
                Aucun visiteur n'a encore été enregistré dans une salle.
              </li>
            )}
          </ul>
        </div>

        <div className="rounded-card border border-lime/40 bg-lime/10 p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink">
            Salon intégral
          </p>
          <p className="mt-3 font-display text-[36px] font-black leading-none text-ink tabular-nums">
            {coverage.fullExhibitionVisitors.toLocaleString("fr-FR")}
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink/70">
            Visiteurs uniques qui ont validé leur entrée dans les{" "}
            <strong>{coverage.activeRoomCount}</strong> salle
            {coverage.activeRoomCount > 1 ? "s" : ""} active
            {coverage.activeRoomCount > 1 ? "s" : ""}.
          </p>
        </div>
      </div>
    </section>
  );
}

function RecentActivitySection({
  rows,
  formatDt
}: {
  rows: RecentActivityRow[];
  formatDt: (d: Date) => string;
}) {
  return (
    <section aria-label="Dernières entrées">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Dernières entrées
      </p>
      <div className="mt-4 rounded-card border border-line bg-white">
        {rows.length === 0 ? (
          <div className="p-2">
            <EmptyState
              title="Aucune entrée récente."
              hint="La liste se remplit dès qu'un opérateur scanne un badge validé."
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-16 shrink-0 font-mono text-[11.5px] text-ink/70 tabular-nums">
                    {formatDt(r.scannedAt)}
                  </span>
                  <span className="text-[13px] font-semibold text-ink">
                    {r.participant
                      ? `${r.participant.firstName} ${r.participant.lastNameInitial}.`
                      : "Participant non résolu"}
                  </span>
                  {r.participant?.tier && (
                    <span className="rounded-full bg-cobalt/10 px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.14em] text-cobalt">
                      {r.participant.tier.replace("_", " ")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-ink/70">
                    {r.accessPoint ? r.accessPoint.name : "—"}
                  </span>
                  <StatusBadge status={r.result} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DeniedScansSection({
  breakdown,
  points
}: {
  breakdown: ResultBreakdownRow[];
  points: { id: string; name: string; type: AccessPointType }[];
}) {
  // Roll (accessPointId, result, reason) into per-AP tables.
  const pointName = new Map(points.map((p) => [p.id, p.name]));

  // Only surface non-VALID rows in this operational section.
  const nonValid = breakdown.filter(
    (r) => r.result !== CheckInResult.VALID && r.count > 0
  );

  const byPoint = new Map<
    string,
    { name: string; rows: ResultBreakdownRow[]; total: number }
  >();
  for (const r of nonValid) {
    const id = r.accessPointId ?? "__unknown__";
    const name =
      id === "__unknown__"
        ? "Point non répertorié"
        : pointName.get(id) ?? "Point supprimé";
    let entry = byPoint.get(id);
    if (!entry) {
      entry = { name, rows: [], total: 0 };
      byPoint.set(id, entry);
    }
    entry.rows.push(r);
    entry.total += r.count;
  }

  const list = Array.from(byPoint.entries()).sort(
    (a, b) => b[1].total - a[1].total
  );

  return (
    <section aria-label="Scans refusés">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Scans refusés / problèmes
        </p>
        <p className="text-[11px] text-ink/50">
          Résumé opérationnel — regroupé par point
        </p>
      </div>

      {list.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="Aucun refus enregistré."
            hint="Rien à signaler côté opérations."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {list.map(([id, entry]) => (
            <div
              key={id}
              className="rounded-card border border-line bg-white p-4"
            >
              <div className="flex items-baseline justify-between">
                <p className="font-display text-[14px] font-black text-ink">
                  {entry.name}
                </p>
                <p className="text-[11px] font-semibold text-amber-700 tabular-nums">
                  {entry.total.toLocaleString("fr-FR")} refus
                </p>
              </div>
              <ul className="mt-3 space-y-1.5">
                {entry.rows.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 text-[12px]"
                  >
                    <span className="flex items-center gap-2">
                      <StatusBadge status={r.result} />
                      <span className="font-mono text-[11px] text-ink/60">
                        {r.reason ?? "—"}
                      </span>
                    </span>
                    <span className="tabular-nums text-ink/70">
                      {r.count.toLocaleString("fr-FR")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function OperatorActivitySection({
  operators
}: {
  operators: OperatorActivityRow[];
}) {
  if (operators.length === 0) return null;
  const max = Math.max(1, ...operators.map((o) => o.totalScans));

  return (
    <section aria-label="Activité des opérateurs">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Activité des opérateurs
      </p>
      <div className="mt-4 rounded-card border border-line bg-white p-5">
        <ul className="space-y-3">
          {operators.slice(0, 10).map((o) => {
            const pct = (o.totalScans / max) * 100;
            return (
              <li key={o.operatorId}>
                <div className="flex items-baseline justify-between text-[12.5px]">
                  <span className="font-semibold text-ink">{o.name}</span>
                  <span className="tabular-nums text-ink/70">
                    {o.validScans.toLocaleString("fr-FR")} validés ·{" "}
                    {o.deniedScans.toLocaleString("fr-FR")} refus
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
      </div>
    </section>
  );
}

function DetailedActivitySection({
  rows,
  formatDt
}: {
  rows: DetailedRow[];
  formatDt: (d: Date) => string;
}) {
  return (
    <section aria-label="Journal détaillé">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Journal détaillé
        </p>
        <p className="text-[11px] text-ink/50">
          {rows.length} ligne{rows.length > 1 ? "s" : ""} · limité à 200
        </p>
      </div>
      <div className="mt-4 overflow-hidden rounded-card border border-line bg-white">
        {rows.length === 0 ? (
          <div className="p-2">
            <EmptyState
              title="Aucun scan pour ces filtres."
              hint="Ajustez les filtres ou élargissez la période."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-frost/60 text-[10px] font-bold uppercase tracking-[0.16em] text-ink/55">
                <tr>
                  <th className="px-4 py-2.5">Quand</th>
                  <th className="px-4 py-2.5">Point d'accès</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Résultat</th>
                  <th className="px-4 py-2.5">Motif</th>
                  <th className="px-4 py-2.5">Opérateur</th>
                  <th className="px-4 py-2.5">Participant</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2 font-mono text-[11px] text-ink/70 tabular-nums">
                      {formatDt(r.scannedAt)}
                    </td>
                    <td className="px-4 py-2 text-ink">
                      {r.accessPoint ? r.accessPoint.name : "—"}
                    </td>
                    <td className="px-4 py-2 text-ink/70">
                      {r.accessPoint
                        ? r.accessPoint.type === "MAIN_ENTRANCE"
                          ? "Entrée"
                          : "Salle"
                        : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={r.result} />
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-ink/65">
                      {r.reason ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-ink/70">
                      {r.operator ? r.operator.name : "—"}
                    </td>
                    <td className="px-4 py-2 text-ink">
                      {r.participant
                        ? `${r.participant.firstName} ${r.participant.lastNameInitial}.`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Utils ────────────────────────────────────────────────────────

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn("h-2 w-2 rounded-full", color)}
      />
      {label}
    </span>
  );
}

function Stat({
  label,
  value,
  accent
}: {
  label: string;
  value: number;
  accent: "cobalt" | "lime" | "warn";
}) {
  const bar =
    accent === "cobalt"
      ? "before:bg-cobalt"
      : accent === "lime"
        ? "before:bg-lime"
        : "before:bg-amber-400";
  return (
    <div
      className={cn(
        "relative rounded-btn border border-line bg-frost/60 p-4",
        "before:absolute before:left-0 before:top-4 before:h-6 before:w-[3px] before:rounded-r-full",
        bar
      )}
    >
      <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </p>
      <p className="mt-2 font-display text-[26px] font-black leading-none text-ink tabular-nums">
        {value.toLocaleString("fr-FR")}
      </p>
    </div>
  );
}

function formatHour(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  return `${hh.toString().padStart(2, "0")}h`;
}

// yyyy-mm-dd in Africa/Algiers. Used to project a Date back into a
// filter input value that matches the user's operational day.
function algiersDayString(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const y = p.find((x) => x.type === "year")?.value ?? "1970";
  const m = p.find((x) => x.type === "month")?.value ?? "01";
  const day = p.find((x) => x.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function buildRefreshHref(
  raw: Record<string, string | string[] | undefined>
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") params.set(k, v);
  }
  // Bust any client-side cache — the page is force-dynamic anyway,
  // but this makes the "Actualiser" affordance explicit.
  params.set("_", Date.now().toString());
  const q = params.toString();
  return q ? `/admin/scan/analytics?${q}` : "/admin/scan/analytics";
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessPointType, CheckInResult } from "@prisma/client";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState, StatusBadge } from "@/components/admin/ui";
import { cn } from "@/lib/utils";
import {
  EVENT_TIMEZONE,
  getSpaceDetail,
  resolveAccessPointBySlug,
  type CheckinAnalyticsFilters,
  type SpaceDetailPayload
} from "@/lib/admin/checkin-analytics";

// Phase 21 — per-space (per-AccessPoint) analytics detail page.
//
// URL: /admin/scan/analytics/[access-point-slug]
// Permission: analytics.view (server-side, at the top of the page).
//
// Handles four AccessPoint states explicitly:
//   • unknown slug            → notFound() (404)
//   • MAIN_ENTRANCE           → notFound() (this page is ROOM-only —
//                               the main entrance is fully covered on
//                               the top-level dashboard). Rejecting
//                               MAIN_ENTRANCE here also protects
//                               against operators being redirected
//                               to a page that assumes ROOM semantics.
//   • inactive ROOM           → rendered with a clear "désactivé"
//                               banner and reduced affordances (no
//                               scanner link)
//   • active ROOM             → full detail view
//
// Slug is a URL param — never trusted as authorization. The permission
// gate runs BEFORE the resolver call, and the resolver select is a
// whitelist that never exposes credential material.

export const dynamic = "force-dynamic";
export const metadata = { title: "Détail d'un espace" };

const PRESET_KEYS = new Set(["today", "yesterday", "7d", "event", "all"]);
const EVENT_START = new Date("2026-11-15T00:00:00+01:00");
const EVENT_END = new Date("2026-11-17T22:59:59.999+01:00");

type PageProps = {
  params: Promise<{ "access-point-slug": string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

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

function resolvePreset(
  preset: string | undefined
): { from: Date; to: Date } | undefined {
  if (!preset || !PRESET_KEYS.has(preset)) return undefined;
  const now = new Date();
  const startOfAlgiersDay = (d: Date): Date => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: EVENT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value ?? "1970";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return new Date(`${y}-${m}-${day}T00:00:00+01:00`);
  };
  const endOfAlgiersDay = (d: Date): Date =>
    new Date(startOfAlgiersDay(d).getTime() + 24 * 60 * 60 * 1000 - 1);
  if (preset === "today")
    return { from: startOfAlgiersDay(now), to: endOfAlgiersDay(now) };
  if (preset === "yesterday") {
    const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return { from: startOfAlgiersDay(y), to: endOfAlgiersDay(y) };
  }
  if (preset === "7d") {
    const s = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from: startOfAlgiersDay(s), to: endOfAlgiersDay(now) };
  }
  if (preset === "event") return { from: EVENT_START, to: EVENT_END };
  return undefined;
}

export default async function SpaceAnalyticsDetailPage({
  params,
  searchParams
}: PageProps) {
  // 1) Authorization — SERVER-SIDE, unconditionally, before any DB
  //    read that depends on the URL slug.
  const { user } = await requirePermission("analytics.view");

  const rawParams = await params;
  const rawSearch = await searchParams;

  // 2) Slug is trimmed + length-clamped BEFORE it reaches Prisma.
  //    The DB lookup returns whitelist fields only.
  const slug = pickString(rawParams["access-point-slug"], 64);
  if (!slug) notFound();

  const point = await resolveAccessPointBySlug(slug);
  if (!point) notFound();

  // 3) Type gate — this page is ROOM-only. MAIN_ENTRANCE has richer
  //    UI on the top-level dashboard and different semantics
  //    (atomic-first-scan claim, no repeats-as-fresh-VALID). We
  //    refuse rather than render a page that would silently apply
  //    the wrong metric definitions.
  if (point.type !== AccessPointType.ROOM) {
    notFound();
  }

  // 4) Filters — same defensive parsing as the top-level dashboard.
  const presetKey = pickString(rawSearch.preset, 16);
  const preset = resolvePreset(presetKey);
  const filters: CheckinAnalyticsFilters = {
    from: preset?.from ?? pickDate(rawSearch.from),
    to: preset?.to ?? pickDate(rawSearch.to, true)
    // No accessPointId filter here — this page is INHERENTLY scoped
    // by the URL slug. No result filter either — the detail view is
    // curated: overview KPIs (VALID), hourly (VALID), breakdown
    // (VALID), denied (non-VALID), recent (VALID).
  };

  const detail = await getSpaceDetail(point, filters);

  const dtLong = new Intl.DateTimeFormat("fr-FR", {
    timeZone: EVENT_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const dtShort = new Intl.DateTimeFormat("fr-FR", {
    timeZone: EVENT_TIMEZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
  const timeOnly = new Intl.DateTimeFormat("fr-FR", {
    timeZone: EVENT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit"
  });

  return (
    <>
      <AdminHeader
        user={user}
        title={detail.overview.name}
        subtitle="Détail d'un espace d'exposition"
      />

      <div className="space-y-8 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/admin/scan/analytics"
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
          >
            ← Analytics des check-ins
          </Link>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink/50">
            <span>
              Dernière mise à jour : {timeOnly.format(detail.generatedAt)}
            </span>
            <span aria-hidden>·</span>
            <span>Fuseau {EVENT_TIMEZONE}</span>
          </div>
        </div>

        {!detail.overview.active && (
          <div
            role="status"
            className="rounded-btn border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900"
          >
            <strong>Espace désactivé.</strong> Aucune nouvelle entrée
            ne sera enregistrée sur ce point. Les statistiques ci-dessous
            portent sur les entrées déjà collectées.
          </div>
        )}

        <SpaceOverviewSection
          detail={detail}
          formatDt={dtLong.format.bind(dtLong)}
        />

        <SpaceHourlyChart hourly={detail.hourly} name={detail.overview.name} />

        <SpaceBreakdownSection breakdown={detail.breakdown} />

        <SpaceRecentSection
          rows={detail.recent}
          formatDt={dtShort.format.bind(dtShort)}
        />

        <SpaceDeniedSection denied={detail.denied} />

        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Aller plus loin
          </p>
          <p className="mt-2 text-[13px] text-ink/70">
            Cette page synthétise l&apos;activité de {detail.overview.name}.
            Pour les lignes brutes (opérateur par opérateur, chaque
            scan, y compris les échecs de badge), consultez
            l&apos;historique global filtré.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href={`/admin/scan/history?accessPointId=${encodeURIComponent(point.id)}`}
              className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
            >
              Historique des scans →
            </Link>
            {detail.overview.active && (
              <Link
                href={`/admin/scan/${encodeURIComponent(point.slug)}`}
                className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
              >
                Ouvrir le scanner de cet espace →
              </Link>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Sections ─────────────────────────────────────────────────────

function SpaceOverviewSection({
  detail,
  formatDt
}: {
  detail: SpaceDetailPayload;
  formatDt: (d: Date) => string;
}) {
  const o = detail.overview;
  const share = detail.shareOfSalon;

  return (
    <section aria-label="Vue d'ensemble de l'espace">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Vue d&apos;ensemble
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricBox
          label="Visiteurs uniques"
          value={o.uniqueVisitors.toLocaleString("fr-FR")}
          hint="Participants distincts avec une entrée validée"
          tone="cobalt"
        />
        <MetricBox
          label="Entrées validées"
          value={o.validScans.toLocaleString("fr-FR")}
          hint="Chaque scan validé compte"
          tone="lime"
        />
        <MetricBox
          label="Ré-entrées"
          value={o.repeatEntries.toLocaleString("fr-FR")}
          hint="Entrées supplémentaires par les mêmes visiteurs"
          tone="default"
        />
        <MetricBox
          label="Refus"
          value={o.deniedScans.toLocaleString("fr-FR")}
          hint={
            o.deniedScans > 0
              ? "Vérifiez la section « Refus » ci-dessous"
              : "Aucun refus enregistré"
          }
          tone={o.deniedScans > 0 ? "warn" : "default"}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Première & dernière entrée
          </p>
          <div className="mt-3 space-y-1.5 text-[13px] text-ink/80">
            <p>
              <strong>Première :</strong>{" "}
              {o.firstEntryAt ? formatDt(o.firstEntryAt) : "—"}
            </p>
            <p>
              <strong>Dernière :</strong>{" "}
              {o.lastEntryAt ? formatDt(o.lastEntryAt) : "—"}
            </p>
          </div>
        </div>
        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Pic d&apos;activité
          </p>
          {o.peakHour !== undefined && o.peakHourCount !== undefined ? (
            <>
              <p className="mt-3 font-display text-[24px] font-black leading-none text-ink tabular-nums">
                {formatHour(o.peakHour)} – {formatHour(o.peakHour + 1)}
              </p>
              <p className="mt-1 text-[12px] text-ink/60">
                {o.peakHourCount.toLocaleString("fr-FR")} entrée
                {o.peakHourCount > 1 ? "s" : ""} sur cette heure
              </p>
            </>
          ) : (
            <p className="mt-3 text-[13px] text-ink/55">
              Pas encore de pic identifiable.
            </p>
          )}
        </div>
        <div className="rounded-card border border-cobalt/25 bg-cobalt/[0.03] p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
            Part du salon
          </p>
          {share !== null ? (
            <>
              <p className="mt-3 font-display text-[32px] font-black leading-none text-cobalt tabular-nums">
                {(share * 100).toFixed(1)}%
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-ink/70">
                Des visiteurs entrés dans le salon sur la période,
                cette proportion est aussi entrée ici.
              </p>
            </>
          ) : (
            <p className="mt-3 text-[13px] text-ink/70">
              Ratio indisponible — aucune entrée principale enregistrée
              sur la période.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function SpaceHourlyChart({
  hourly,
  name
}: {
  hourly: SpaceDetailPayload["hourly"];
  name: string;
}) {
  const maxVal = Math.max(
    ...hourly.map((b) => Math.max(b.validScans, b.uniqueVisitors)),
    1
  );
  const hasData = hourly.some((b) => b.validScans > 0);

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
    <section aria-label="Trafic par heure de l'espace">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Trafic par heure
        </p>
        <div className="flex items-center gap-3 text-[11px] text-ink/60">
          <LegendDot color="bg-cobalt" label="Entrées validées" />
          <LegendDot color="bg-lime" label="Visiteurs uniques" />
        </div>
      </div>
      {!hasData ? (
        <div className="mt-4">
          <EmptyState
            title="Aucune entrée pour cette période."
            hint="La courbe apparaîtra dès que les opérateurs valident les premières entrées."
          />
        </div>
      ) : (
        <div className="mt-4 rounded-card border border-line bg-white p-4">
          <svg
            role="img"
            aria-label={`Trafic horaire à ${name} — entrées validées et visiteurs uniques`}
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
          >
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
            {hourly.map((b, i) => {
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
                    {formatHour(b.hour)} · {b.validScans} entrée
                    {b.validScans > 1 ? "s" : ""} validée
                    {b.validScans > 1 ? "s" : ""}
                  </title>
                </rect>
              );
            })}
            {hourly.map((b, i) => {
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
                    {formatHour(b.hour)} · {b.uniqueVisitors} visiteur
                    {b.uniqueVisitors > 1 ? "s" : ""} unique
                    {b.uniqueVisitors > 1 ? "s" : ""}
                  </title>
                </rect>
              );
            })}
            {hourly
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

function SpaceBreakdownSection({
  breakdown
}: {
  breakdown: SpaceDetailPayload["breakdown"];
}) {
  const sections: {
    title: string;
    hint: string;
    rows: Array<{ key: string; count: number }>;
    labelFn?: (key: string) => string;
  }[] = [
    {
      title: "Par tier",
      hint: "Visiteurs uniques par tier de badge",
      rows: breakdown.byTier,
      labelFn: (k) => k.replace(/_/g, " ")
    },
    {
      title: "Par choix de participation",
      hint: "Chaîne complétée à l'étape 2 de l'inscription",
      rows: breakdown.byParticipationChoice,
      labelFn: (k) => k.replace(/_/g, " ")
    },
    {
      title: "Par type d'inscription",
      hint: "Catégorie opérationnelle",
      rows: breakdown.byRegistrationType,
      labelFn: (k) => k.charAt(0) + k.slice(1).toLowerCase()
    },
    {
      title: "Par profil",
      hint: "Visiteur individuel ou organisation",
      rows: breakdown.byProfile,
      labelFn: (k) => (k === "COMPANY" ? "Entreprise" : "Visiteur")
    }
  ];

  const hasAny = sections.some((s) => s.rows.length > 0);

  return (
    <section aria-label="Profil des visiteurs">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Profil des visiteurs
      </p>

      {!hasAny ? (
        <div className="mt-4">
          <EmptyState
            title="Pas encore de visiteurs classifiés."
            hint="Le détail par tier et par profil apparaît dès la première entrée validée."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {sections.map((s) => {
            const total = s.rows.reduce((a, r) => a + r.count, 0);
            return (
              <div
                key={s.title}
                className="rounded-card border border-line bg-white p-5"
              >
                <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                  {s.title}
                </p>
                <p className="mt-1 text-[11px] text-ink/55">{s.hint}</p>
                {s.rows.length === 0 ? (
                  <p className="mt-3 text-[12px] text-ink/50">
                    Aucune donnée sur cet axe.
                  </p>
                ) : (
                  <ul className="mt-4 space-y-2.5">
                    {s.rows.map((r) => {
                      const pct = total > 0 ? (r.count / total) * 100 : 0;
                      return (
                        <li key={r.key}>
                          <div className="flex items-baseline justify-between text-[12.5px]">
                            <span className="font-semibold text-ink">
                              {s.labelFn ? s.labelFn(r.key) : r.key}
                            </span>
                            <span className="tabular-nums text-ink/70">
                              {r.count.toLocaleString("fr-FR")} · {pct.toFixed(0)}%
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
            );
          })}
        </div>
      )}
    </section>
  );
}

function SpaceRecentSection({
  rows,
  formatDt
}: {
  rows: SpaceDetailPayload["recent"];
  formatDt: (d: Date) => string;
}) {
  return (
    <section aria-label="Dernières entrées de l'espace">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Dernières entrées
      </p>
      <div className="mt-4 rounded-card border border-line bg-white">
        {rows.length === 0 ? (
          <div className="p-2">
            <EmptyState
              title="Aucune entrée validée pour cette période."
              hint="La liste se remplit dès qu'un opérateur valide une entrée à cet espace."
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
                  <span className="w-28 shrink-0 font-mono text-[11.5px] text-ink/70 tabular-nums">
                    {formatDt(r.scannedAt)}
                  </span>
                  <span className="text-[13px] font-semibold text-ink">
                    {r.participant
                      ? `${r.participant.firstName} ${r.participant.lastNameInitial}.`
                      : "Participant non résolu"}
                  </span>
                  {r.participant?.tier && (
                    <span className="rounded-full bg-cobalt/10 px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.14em] text-cobalt">
                      {r.participant.tier.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {r.operator && (
                    <span className="text-[11.5px] text-ink/55">
                      Op. {r.operator.name}
                    </span>
                  )}
                  <StatusBadge status={CheckInResult.VALID} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SpaceDeniedSection({
  denied
}: {
  denied: SpaceDetailPayload["denied"];
}) {
  const rows = denied.filter((r) => r.count > 0);
  if (rows.length === 0) {
    return (
      <section aria-label="Refus enregistrés">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Refus enregistrés
        </p>
        <div className="mt-4 rounded-card border border-line bg-white p-5">
          <p className="text-[13px] text-ink/60">
            Aucun refus enregistré à cet espace sur la période. Rien à
            signaler côté opérations.
          </p>
        </div>
      </section>
    );
  }

  const total = rows.reduce((a, r) => a + r.count, 0);

  return (
    <section aria-label="Refus enregistrés">
      <div className="flex items-baseline justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Refus enregistrés
        </p>
        <p className="text-[11px] font-semibold text-amber-700 tabular-nums">
          {total.toLocaleString("fr-FR")} refus au total
        </p>
      </div>
      <div className="mt-4 rounded-card border border-line bg-white p-5">
        <ul className="divide-y divide-line">
          {rows.map((r, i) => (
            <li
              key={`${r.result}-${r.reason}-${i}`}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
            >
              <div className="flex items-center gap-2">
                <StatusBadge status={r.result} />
                <span className="font-mono text-[11.5px] text-ink/65">
                  {r.reason ?? "—"}
                </span>
              </div>
              <span className="tabular-nums text-ink/70">
                {r.count.toLocaleString("fr-FR")}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─── Utils ────────────────────────────────────────────────────────

function MetricBox({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: string;
  hint?: string;
  tone: "cobalt" | "lime" | "warn" | "default";
}) {
  const bar =
    tone === "cobalt"
      ? "before:bg-cobalt"
      : tone === "lime"
        ? "before:bg-lime"
        : tone === "warn"
          ? "before:bg-amber-400"
          : "before:bg-ink/20";
  return (
    <div
      className={cn(
        "relative rounded-card border border-line bg-white p-5",
        "before:absolute before:left-0 before:top-4 before:h-6 before:w-[3px] before:rounded-r-full",
        bar
      )}
    >
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        {label}
      </p>
      <p className="mt-3 font-display text-[32px] font-black leading-none tracking-tight text-ink tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-2 text-[12px] text-ink/55">{hint}</p>}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("h-2 w-2 rounded-full", color)} />
      {label}
    </span>
  );
}

function formatHour(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  return `${hh.toString().padStart(2, "0")}h`;
}

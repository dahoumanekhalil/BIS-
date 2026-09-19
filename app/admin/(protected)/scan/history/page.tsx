import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState, StatusBadge } from "@/components/admin/ui";
import { cn } from "@/lib/utils";
import {
  getScanHistory,
  getScanHistoryFacets,
  type ScanHistoryFilters
} from "@/lib/admin/scan-history-query";
import { HistoryFilters } from "./history-filters";
import type { CheckInResult } from "@prisma/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Historique des scans" };

// Phase 16 — global scan history.
//
// Server-rendered CheckIn history joined to AccessPoint / Participant /
// Operator, gated by `checkin.view` (same as /admin/check-in). The
// filter form is a client component that submits back to this route
// via `?from=&to=&accessPointId=&result=&operatorId=&q=` — Next.js
// re-runs the server component on every submit and re-renders the
// list. No JSON APIs, no client-side data fetching.
//
// SECURITY:
//   • Every projection is a whitelist select in `getScanHistory`
//     (see lib/admin/scan-history-query.ts). No rawToken, no
//     tokenHash, no passwordHash, no participant payment metadata.
//   • The `q` free-text search is trimmed + length-bounded (2..80
//     chars) before it reaches Prisma to avoid pushing a giant
//     `contains` clause into Postgres.
//   • Row limit is bounded at 200 (server-enforced). The page-size
//     query parameter is NOT accepted from the client — a hostile
//     `?take=100000` cannot enlarge the result set.

const CHECKIN_RESULTS: readonly CheckInResult[] = [
  "VALID",
  "ALREADY_CHECKED_IN",
  "WRONG_GATE",
  "WRONG_TIME",
  "CANCELLED",
  "UNKNOWN",
  "UNPAID"
] as const;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function pickString(
  v: string | string[] | undefined,
  maxLen = 128
): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > maxLen) return undefined;
  return s;
}

function pickDate(
  v: string | string[] | undefined,
  endOfDay = false
): Date | undefined {
  const s = pickString(v, 32);
  if (!s) return undefined;
  // Accept ISO date shape yyyy-mm-dd; anything else is refused so
  // hostile input cannot inject arbitrary Postgres expressions
  // (Prisma parameterises, but a strict allow-list keeps the surface
  // narrow).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
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

export default async function ScanHistoryPage({ searchParams }: PageProps) {
  const { user } = await requirePermission("checkin.view");
  const raw = await searchParams;

  const filters: ScanHistoryFilters = {
    from: pickDate(raw.from),
    to: pickDate(raw.to, true),
    accessPointId: pickString(raw.accessPointId, 64),
    result: pickResult(raw.result),
    operatorId: pickString(raw.operatorId, 64),
    q: pickString(raw.q, 80)
  };

  const [rows, facets] = await Promise.all([
    getScanHistory(filters),
    getScanHistoryFacets()
  ]);

  const dt = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);

  return (
    <>
      <AdminHeader
        user={user}
        title="Historique des scans"
        subtitle={`${rows.length} passage${rows.length === 1 ? "" : "s"} affiché${rows.length === 1 ? "" : "s"} · limite 50`}
      />

      <div className="space-y-6 p-6">
        <Link
          href="/admin/scan"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          ← Centre de scan
        </Link>

        <HistoryFilters facets={facets} initial={raw} />

        {rows.length === 0 ? (
          <EmptyState
            title="Aucun scan ne correspond à ces filtres."
            hint="Élargissez la période ou effacez les filtres pour retrouver un passage."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="rounded-card border border-line bg-white"
              >
                <details className="group">
                  <summary
                    className={cn(
                      "flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3",
                      "list-none [&::-webkit-details-marker]:hidden"
                    )}
                  >
                    <span className="w-28 shrink-0 font-mono text-[11.5px] text-ink/70 tabular-nums">
                      {dt(r.scannedAt)}
                    </span>
                    <span className="min-w-[10rem] flex-1 truncate text-[13px] font-semibold text-ink">
                      {r.participant
                        ? `${r.participant.firstName} ${r.participant.lastName}`
                        : "Participant non résolu"}
                    </span>
                    <span className="min-w-[8rem] shrink-0 text-[12px] text-ink/70">
                      {r.accessPoint
                        ? r.accessPoint.name
                        : r.gate || "Point non répertorié"}
                    </span>
                    <span className="shrink-0">
                      <StatusBadge status={r.result} />
                    </span>
                    <span
                      aria-hidden
                      className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink/40 transition-transform group-open:rotate-180"
                    >
                      ▾
                    </span>
                  </summary>
                  <div className="grid gap-3 border-t border-line px-4 py-3 text-[12.5px] sm:grid-cols-2">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink/50">
                        Point d&apos;accès
                      </p>
                      <p className="mt-1 text-ink">
                        {r.accessPoint ? (
                          <>
                            {r.accessPoint.name}{" "}
                            <span className="text-ink/50">
                              · {r.accessPoint.type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle"}
                            </span>
                          </>
                        ) : (
                          <span className="italic text-ink/60">
                            Point non répertorié (historique legacy)
                          </span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink/50">
                        Opérateur
                      </p>
                      <p className="mt-1 text-ink">
                        {r.operator ? r.operator.name : "—"}
                      </p>
                    </div>
                    {r.reason && (
                      <div className="sm:col-span-2">
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink/50">
                          Motif interne
                        </p>
                        <p className="mt-1 font-mono text-[11.5px] text-ink/75">
                          {r.reason}
                        </p>
                      </div>
                    )}
                    {r.participant && (
                      <div className="sm:col-span-2">
                        <Link
                          href={`/admin/registrants/${r.participant.id}`}
                          className="inline-flex items-center gap-1 text-[12px] font-semibold text-cobalt hover:underline"
                        >
                          Fiche du participant →
                        </Link>
                      </div>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

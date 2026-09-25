import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { getRegistrant } from "@/lib/admin/queries";
import { getClientLogs } from "@/lib/admin/client-logs";
import { AdminHeader } from "@/components/admin/header";
import { LogFilters } from "./filters";
import { LogTimeline } from "./timeline";
import { KpiCard, EmptyState } from "@/components/admin/ui";
import type {
  ClientLogCategory,
  ClientLogStatus,
  ClientLogFilters
} from "@/lib/admin/client-logs";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = new Set<ClientLogCategory>([
  "account",
  "profile",
  "checkin",
  "email",
  "security"
]);
const ALLOWED_STATUSES = new Set<ClientLogStatus>([
  "success",
  "failed",
  "info",
  "warn"
]);
const ALLOWED_RANGES = new Set<NonNullable<ClientLogFilters["range"]>>([
  "today",
  "yesterday",
  "7d",
  "30d",
  "all"
]);

export default async function ClientLogsPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    q?: string;
    category?: string;
    status?: string;
    range?: string;
    page?: string;
  }>;
}) {
  // Server-side authorization. Only Super Admin / Admin / Finance / Registration Manager have `audit.view`.
  const { user } = await requirePermission("audit.view");
  const { id } = await params;
  const sp = await searchParams;

  // Validate the client id: if it does not correspond to an existing
  // participant, we return 404. Every downstream query is scoped to
  // this id — no client-supplied WHERE fragment is trusted.
  const registrant = await getRegistrant(id);
  if (!registrant) notFound();

  const category =
    sp.category && ALLOWED_CATEGORIES.has(sp.category as ClientLogCategory)
      ? (sp.category as ClientLogCategory)
      : "ALL";
  const status =
    sp.status && ALLOWED_STATUSES.has(sp.status as ClientLogStatus)
      ? (sp.status as ClientLogStatus)
      : "ALL";
  const range =
    sp.range && ALLOWED_RANGES.has(sp.range as NonNullable<ClientLogFilters["range"]>)
      ? (sp.range as NonNullable<ClientLogFilters["range"]>)
      : "all";
  const page = sp.page ? Math.max(1, Number(sp.page) || 1) : 1;

  const { events, total, pageSize, summary } = await getClientLogs(id, {
    q: sp.q?.trim() || undefined,
    category,
    status,
    range,
    page,
    pageSize: 25
  });

  // Audit self-log: this administrative view is itself a sensitive action.
  await audit({
    userId: user.id,
    action: "client.logs.view",
    entity: "Participant",
    entityId: id,
    meta: { filters: { category, status, range, q: sp.q ?? null, page } }
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <AdminHeader
        user={user}
        title={`Activité · ${registrant.firstName} ${registrant.lastName}`}
        subtitle="Registrant · Logs"
      />

      <div className="space-y-6 p-6">
        {/* Breadcrumb + back link */}
        <nav
          aria-label="Fil d'Ariane"
          className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.2em] text-ink/45"
        >
          <Link href="/admin/registrants" className="hover:text-ink">
            Registrants
          </Link>
          <span>/</span>
          <Link
            href={`/admin/registrants/${id}`}
            className="hover:text-ink"
          >
            {registrant.firstName} {registrant.lastName}
          </Link>
          <span>/</span>
          <span className="text-ink">Logs</span>
        </nav>

        {/* Client identity header */}
        <div className="rounded-card border border-line bg-white p-5">
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-cobalt/10 font-display text-lg font-black text-cobalt">
              {(registrant.firstName[0] ?? "?") + (registrant.lastName[0] ?? "")}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-xl font-black tracking-tight text-ink">
                {registrant.firstName} {registrant.lastName}
              </h2>
              <p className="mt-0.5 truncate text-[13px] text-ink/60">
                {registrant.email} · Client ID{" "}
                <span className="font-mono text-ink/80">
                  {registrant.id.slice(0, 12).toUpperCase()}
                </span>
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.18em] text-ink/50">
                <span>{registrant.tier?.replace("_", " ") ?? "— sans tier"}</span>
                <span>·</span>
                <span>{registrant.status}</span>
                {registrant.gate && (
                  <>
                    <span>·</span>
                    <span>{registrant.gate}</span>
                  </>
                )}
              </div>
            </div>
            <Link
              href={`/admin/registrants/${id}`}
              className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink hover:border-ink/30"
            >
              ← Fiche client
            </Link>
          </div>
        </div>

        {/* Summary metrics */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Événements totaux"
            value={summary.total}
            hint="Sur la période filtrée"
            tone="cobalt"
          />
          <KpiCard
            label="Aujourd'hui"
            value={summary.today}
            hint="Depuis 00h00"
            tone="default"
          />
          <KpiCard
            label="Succès"
            value={summary.success}
            hint="Actions réussies"
            tone="lime"
          />
          <KpiCard
            label="Échecs"
            value={summary.failed}
            hint="Actions refusées ou en erreur"
            tone="warn"
          />
        </div>

        {/* Filters */}
        <LogFilters clientId={id} total={total} />

        {/* Timeline */}
        {events.length === 0 ? (
          <EmptyState
            title="Aucun événement pour ce client."
            hint="Aucune activité enregistrée pour cette combinaison de filtres. Essayez d'élargir la période ou de changer de catégorie."
          />
        ) : (
          <LogTimeline events={events} />
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <nav
            aria-label="Pagination"
            className="flex items-center justify-between gap-3 text-[12px]"
          >
            <p className="text-ink/55">
              Page {page} / {totalPages} · {total.toLocaleString("fr-FR")}{" "}
              événements
            </p>
            <div className="flex items-center gap-2">
              <PageLink
                params={sp}
                page={page - 1}
                disabled={page <= 1}
                clientId={id}
              >
                ← Préc.
              </PageLink>
              <PageLink
                params={sp}
                page={page + 1}
                disabled={page >= totalPages}
                clientId={id}
              >
                Suiv. →
              </PageLink>
            </div>
          </nav>
        )}
      </div>
    </>
  );
}

function PageLink({
  params,
  page,
  disabled,
  children,
  clientId
}: {
  params: Record<string, string | undefined>;
  page: number;
  disabled?: boolean;
  children: React.ReactNode;
  clientId: string;
}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) usp.set(k, v);
  usp.set("page", String(page));
  const href = `/admin/registrants/${clientId}/logs?${usp.toString()}`;
  return (
    <Link
      href={disabled ? "#" : href}
      aria-disabled={disabled}
      className={`rounded-btn border border-line px-3 py-1.5 font-semibold ${
        disabled ? "cursor-not-allowed text-ink/30" : "text-ink hover:border-ink/30"
      }`}
    >
      {children}
    </Link>
  );
}

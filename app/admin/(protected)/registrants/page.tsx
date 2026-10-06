import { RegistrationStatus, RegistrationTier } from "@prisma/client";
import { requirePermission } from "@/lib/admin/auth";
import {
  countRegistrantsByStatus,
  listRegistrants,
  MAX_REGISTRANT_EXPORT_ROWS
} from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import {
  PageBody,
  PageIntro,
  FilterTab,
  PaginationNav
} from "@/components/admin/page-kit";
import { RegistrationsFilterBar } from "./filter-bar";
import { RegistrantRow } from "./registrant-row";

export const dynamic = "force-dynamic";

const STATUS_TABS: Array<{ key: RegistrationStatus | "ALL"; label: string }> = [
  { key: "ALL", label: "Tous" },
  { key: "REGISTERED", label: "À confirmer" },
  { key: "CONFIRMED", label: "Confirmés" },
  { key: "CANCELLED", label: "Annulés" },
  { key: "PENDING", label: "En attente" }
];

export default async function RegistrantsPage({
  searchParams
}: {
  // Payment-removal Phase 2: the `payment` searchParam is no longer
  // read here. A legacy bookmark carrying `?payment=…` is silently
  // ignored — the filter is not applied and no error is shown.
  searchParams: Promise<{
    q?: string;
    tier?: string;
    status?: string;
    gate?: string;
    page?: string;
    deleted?: string;
  }>;
}) {
  const { user } = await requirePermission("registrants.view");
  const sp = await searchParams;

  const tier: RegistrationTier | "ALL" = Object.values(RegistrationTier).includes(
    sp.tier as RegistrationTier
  )
    ? (sp.tier as RegistrationTier)
    : "ALL";
  const status: RegistrationStatus | "ALL" = Object.values(RegistrationStatus).includes(
    sp.status as RegistrationStatus
  )
    ? (sp.status as RegistrationStatus)
    : "ALL";
  const pageNumber = Number(sp.page);

  const filters = {
    q: sp.q?.trim().slice(0, 200) || undefined,
    tier,
    status,
    gate: sp.gate?.trim().slice(0, 64) || "ALL",
    page:
      Number.isFinite(pageNumber) && pageNumber >= 1
        ? Math.min(Math.floor(pageNumber), 100_000)
        : 1,
    pageSize: 20
  };

  const [{ items, total, page, pageSize }, statusCounts] = await Promise.all([
    listRegistrants(filters),
    countRegistrantsByStatus(filters)
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allCount = Array.from(statusCounts.values()).reduce((a, b) => a + b, 0);

  // Params carried across links (search, tier, gate); status is set per tab.
  const baseParams = new URLSearchParams();
  if (filters.q) baseParams.set("q", filters.q);
  if (filters.tier !== "ALL") baseParams.set("tier", filters.tier);
  if (filters.gate !== "ALL") baseParams.set("gate", filters.gate);
  const withStatus = (s: string) => {
    const p = new URLSearchParams(baseParams);
    if (s !== "ALL") p.set("status", s);
    const qs = p.toString();
    return `/admin/registrants${qs ? `?${qs}` : ""}`;
  };
  const pageHref = (n: number) => {
    const p = new URLSearchParams(baseParams);
    if (filters.status !== "ALL") p.set("status", filters.status);
    p.set("page", String(n));
    return `/admin/registrants?${p.toString()}`;
  };

  // UI gate only — /admin/registrants/export re-checks SUPER_ADMIN server-side.
  const canExportCsv = user.role === "SUPER_ADMIN";
  const exportParams = new URLSearchParams(baseParams);
  if (filters.status !== "ALL") exportParams.set("status", filters.status);
  const exportQuery = exportParams.toString();
  const exportHref = `/admin/registrants/export${exportQuery ? `?${exportQuery}` : ""}`;

  return (
    <>
      <AdminHeader user={user} title="Inscrits" subtitle="Participants" />

      <PageBody>
        {sp.deleted && (
          <div
            role="status"
            className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-800"
          >
            Inscrit supprimé définitivement.
          </div>
        )}

        <PageIntro
          title="Inscrits au sommet"
          description={
            canExportCsv
              ? `Retrouvez, filtrez et gérez les participants. Le bouton d'export télécharge les ${total.toLocaleString("fr-FR")} inscrits affichés (données personnelles, réservé au Super Admin, action journalisée).${
                  total > MAX_REGISTRANT_EXPORT_ROWS
                    ? ` Limite de ${MAX_REGISTRANT_EXPORT_ROWS.toLocaleString("fr-FR")} lignes : affinez les filtres pour tout exporter.`
                    : ""
                }`
              : "Retrouvez, filtrez et gérez les personnes inscrites au sommet."
          }
          actions={
            canExportCsv ? (
              <a
                href={exportHref}
                download
                className="inline-flex shrink-0 items-center whitespace-nowrap rounded-btn bg-ink px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-ink/85"
              >
                Exporter en CSV
              </a>
            ) : undefined
          }
        />

        <nav aria-label="Filtrer par statut" className="flex flex-wrap gap-2.5">
          {STATUS_TABS.map((t) => (
            <FilterTab
              key={t.key}
              href={withStatus(t.key)}
              active={filters.status === t.key}
              label={t.label}
              count={t.key === "ALL" ? allCount : (statusCounts.get(t.key) ?? 0)}
            />
          ))}
        </nav>

        <RegistrationsFilterBar total={total} />

        <div className="overflow-visible rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(15,25,60,0.05)]">
          <div className="overflow-x-auto overflow-y-visible">
            <table className="w-full min-w-[820px] text-left text-[14px]">
              <thead className="border-b border-line bg-frost text-[12.5px] font-semibold text-ink/60">
                <tr>
                  <th className="px-5 py-3.5">Participant</th>
                  <th className="px-5 py-3.5">Catégorie</th>
                  <th className="px-5 py-3.5">Porte</th>
                  <th className="px-5 py-3.5">Inscrit le</th>
                  <th className="px-5 py-3.5">Statut</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-16">
                      <EmptyState
                        title="Aucun inscrit ne correspond."
                        hint="Modifiez les filtres ou effacez la recherche."
                      />
                    </td>
                  </tr>
                )}
                {items.map((r) => (
                  <RegistrantRow key={r.id} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <PaginationNav
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          hrefFor={pageHref}
        />
      </PageBody>
    </>
  );
}

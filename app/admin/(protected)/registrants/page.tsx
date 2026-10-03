import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import {
  listRegistrants,
  MAX_REGISTRANT_EXPORT_ROWS
} from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { RegistrationsFilterBar } from "./filter-bar";
import { RegistrantRow } from "./registrant-row";
import type {
  RegistrationStatus,
  RegistrationTier
} from "@prisma/client";

export const dynamic = "force-dynamic";

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

  const filters = {
    q: sp.q?.trim() || undefined,
    tier: (sp.tier as RegistrationTier | "ALL") || "ALL",
    status: (sp.status as RegistrationStatus | "ALL") || "ALL",
    gate: (sp.gate as string | "ALL") || "ALL",
    page: sp.page ? Math.max(1, Number(sp.page)) : 1,
    pageSize: 20
  };

  const { items, total, page, pageSize } = await listRegistrants(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // UI gate only — /admin/registrants/export re-checks SUPER_ADMIN server-side.
  const canExportCsv = user.role === "SUPER_ADMIN";
  const exportParams = new URLSearchParams();
  if (filters.q) exportParams.set("q", filters.q);
  if (filters.tier !== "ALL") exportParams.set("tier", filters.tier);
  if (filters.status !== "ALL") exportParams.set("status", filters.status);
  if (filters.gate !== "ALL") exportParams.set("gate", filters.gate);
  const exportQuery = exportParams.toString();
  const exportHref = `/admin/registrants/export${exportQuery ? `?${exportQuery}` : ""}`;

  return (
    <>
      <AdminHeader user={user} title="Registrants" subtitle="Attendees" />

      <div className="space-y-5 p-6">
        {sp.deleted && (
          <div
            role="status"
            className="rounded-btn border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-800"
          >
            Inscrit supprimé définitivement.
          </div>
        )}

        <RegistrationsFilterBar total={total} />

        {canExportCsv && (
          <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-white px-4 py-3">
            <p className="text-[12px] text-ink/60">
              Exporte les {total.toLocaleString("fr-FR")} inscrits
              correspondant aux filtres actuels (données personnelles —
              Super Admin uniquement, action journalisée).
              {total > MAX_REGISTRANT_EXPORT_ROWS && (
                <span className="mt-1 block font-semibold text-amber-800">
                  Limite de {MAX_REGISTRANT_EXPORT_ROWS.toLocaleString("fr-FR")}{" "}
                  lignes : affinez les filtres pour tout exporter.
                </span>
              )}
            </p>
            <a
              href={exportHref}
              download
              className="inline-flex shrink-0 items-center gap-2 rounded-btn bg-ink px-3.5 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-ink/85"
            >
              Exporter CSV
            </a>
          </div>
        )}

        <div className="overflow-visible rounded-card border border-line bg-white">
          <div className="overflow-x-auto overflow-y-visible">
            <table className="w-full min-w-[780px] text-left text-[13px]">
              <thead className="bg-frost text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                <tr>
                  <th className="px-4 py-3">Nom</th>
                  <th className="px-4 py-3">Tier</th>
                  <th className="px-4 py-3">Gate</th>
                  <th className="px-4 py-3">Inscription</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3 text-right">Actions</th>
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

        {/* Pagination */}
        {totalPages > 1 && (
          <nav
            aria-label="Pagination"
            className="flex items-center justify-between gap-3 text-[12px]"
          >
            <p className="text-ink/55">
              Page {page} / {totalPages} · {total.toLocaleString("fr-FR")}{" "}
              inscrits
            </p>
            <div className="flex items-center gap-2">
              <PageLink params={sp} disabled={page <= 1} page={page - 1}>
                ← Préc.
              </PageLink>
              <PageLink
                params={sp}
                disabled={page >= totalPages}
                page={page + 1}
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
  children
}: {
  params: Record<string, string | undefined>;
  page: number;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) usp.set(k, v);
  usp.set("page", String(page));
  const href = `/admin/registrants?${usp.toString()}`;
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

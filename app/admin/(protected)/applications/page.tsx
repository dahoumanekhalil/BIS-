import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import {
  APPLICATION_TYPES,
  APPLICATION_TYPE_LABEL,
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABEL,
  type ApplicationTypeKey,
  type ApplicationStatusKey
} from "@/lib/applications";
import { ApplicationsFilterBar } from "./filter-bar";
import { StatusPill } from "./status-pill";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export default async function ApplicationsPage({
  searchParams
}: {
  searchParams: Promise<{
    q?: string;
    type?: string;
    status?: string;
    page?: string;
  }>;
}) {
  const { user } = await requirePermission("applications.view");
  const sp = await searchParams;

  const type =
    sp.type && (APPLICATION_TYPES as readonly string[]).includes(sp.type)
      ? (sp.type as ApplicationTypeKey)
      : null;
  const status =
    sp.status &&
    (APPLICATION_STATUSES as readonly string[]).includes(sp.status)
      ? (sp.status as ApplicationStatusKey)
      : null;
  const q = sp.q?.trim() || null;
  const page = sp.page ? Math.max(1, Number(sp.page)) : 1;

  const where: Prisma.ApplicationWhereInput = {
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { organization: { contains: q, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [items, total] = await Promise.all([
    prisma.application.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        type: true,
        status: true,
        firstName: true,
        lastName: true,
        email: true,
        organization: true,
        createdAt: true
      }
    }),
    prisma.application.count({ where })
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <AdminHeader
        user={user}
        title="Applications"
        subtitle="Be a part · Sponsor · Partenaire · Intervenant · Créateur"
      />

      <div className="space-y-5 p-6">
        <ApplicationsFilterBar total={total} />

        <div className="overflow-visible rounded-card border border-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead className="bg-frost text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                <tr>
                  <th className="px-4 py-3">Nom</th>
                  <th className="px-4 py-3">Rôle</th>
                  <th className="px-4 py-3">Organisation</th>
                  <th className="px-4 py-3">Reçue</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-16">
                      <EmptyState
                        title="Aucune candidature ne correspond."
                        hint="Modifiez les filtres ou attendez de nouvelles soumissions."
                      />
                    </td>
                  </tr>
                )}
                {items.map((a) => (
                  <tr key={a.id} className="align-middle">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">
                        {a.firstName} {a.lastName}
                      </div>
                      <div className="text-[11.5px] text-ink/50">{a.email}</div>
                    </td>
                    <td className="px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink/70">
                      {APPLICATION_TYPE_LABEL[a.type as ApplicationTypeKey]}
                    </td>
                    <td className="px-4 py-3 text-ink/80">
                      {a.organization ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-ink/60 tabular-nums">
                      {a.createdAt.toLocaleDateString("fr-FR", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric"
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={a.status as ApplicationStatusKey} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/applications/${a.id}`}
                        className="inline-flex items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.16em] text-cobalt hover:text-cobalt-700"
                      >
                        Ouvrir <span aria-hidden>→</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {totalPages > 1 && (
          <nav
            aria-label="Pagination"
            className="flex items-center justify-between text-[12px] text-ink/60"
          >
            <span>
              {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, total)} sur {total}
            </span>
            <div className="flex gap-2">
              {Array.from({ length: totalPages }).map((_, i) => {
                const n = i + 1;
                const qs = new URLSearchParams();
                if (type) qs.set("type", type);
                if (status) qs.set("status", status);
                if (q) qs.set("q", q);
                qs.set("page", String(n));
                return (
                  <Link
                    key={n}
                    href={`/admin/applications?${qs.toString()}`}
                    className={
                      n === page
                        ? "rounded-md bg-ink px-2.5 py-1 text-white"
                        : "rounded-md border border-line px-2.5 py-1 hover:border-ink/30"
                    }
                  >
                    {n}
                  </Link>
                );
              })}
            </div>
          </nav>
        )}

        <p className="text-[11px] text-ink/40">
          Les statuts de candidature ({APPLICATION_STATUS_LABEL.RECEIVED},{" "}
          {APPLICATION_STATUS_LABEL.UNDER_REVIEW}, …) sont indépendants du
          statut d'inscription des participants.
        </p>
      </div>
    </>
  );
}

import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import {
  PageBody,
  PageIntro,
  FilterTab,
  Avatar,
  Chip,
  PaginationNav
} from "@/components/admin/page-kit";
import {
  APPLICATION_TYPES,
  APPLICATION_TYPE_LABEL,
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABEL,
  type ApplicationTypeKey,
  type ApplicationStatusKey
} from "@/lib/applications";
import { cn } from "@/lib/utils";
import { ApplicationsSearch } from "./filter-bar";
import { StatusPill } from "./status-pill";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const STATUS_STYLE: Record<
  ApplicationStatusKey,
  { dot: string; ring: string }
> = {
  RECEIVED: { dot: "bg-cobalt", ring: "ring-cobalt/40" },
  UNDER_REVIEW: { dot: "bg-amber-500", ring: "ring-amber-400/60" },
  CONTACTED: { dot: "bg-navy", ring: "ring-navy/40" },
  APPROVED: { dot: "bg-lime-600", ring: "ring-lime-600/50" },
  REJECTED: { dot: "bg-red-500", ring: "ring-red-400/60" }
};

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
  const q = sp.q?.trim().slice(0, 200) || null;
  const pageNumber = Number(sp.page);
  const page =
    Number.isFinite(pageNumber) && pageNumber >= 1
      ? Math.min(Math.floor(pageNumber), 100_000)
      : 1;

  // Search + role narrow BOTH the list and the status counters; the status
  // filter only narrows the list.
  const baseWhere: Prisma.ApplicationWhereInput = {
    ...(type ? { type } : {}),
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
  const where: Prisma.ApplicationWhereInput = {
    ...baseWhere,
    ...(status ? { status } : {})
  };

  const [items, total, statusRows] = await Promise.all([
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
    prisma.application.count({ where }),
    prisma.application.groupBy({
      by: ["status"],
      where: baseWhere,
      _count: { _all: true }
    })
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const counts = new Map(statusRows.map((r) => [r.status, r._count._all]));
  const allCount = Array.from(counts.values()).reduce((a, b) => a + b, 0);

  const href = (patch: {
    type?: string | null;
    status?: string | null;
    page?: number;
  }) => {
    const qs = new URLSearchParams();
    const t = patch.type === undefined ? type : patch.type;
    const s = patch.status === undefined ? status : patch.status;
    if (t) qs.set("type", t);
    if (s) qs.set("status", s);
    if (q) qs.set("q", q);
    if (patch.page && patch.page > 1) qs.set("page", String(patch.page));
    const str = qs.toString();
    return `/admin/applications${str ? `?${str}` : ""}`;
  };

  return (
    <>
      <AdminHeader user={user} title="Candidatures" subtitle="Partenariats" />

      <PageBody>
        <PageIntro
          title="Candidatures reçues"
          description="Demandes des sponsors, partenaires, intervenants et créateurs de contenu. Choisissez un statut pour voir uniquement les dossiers à traiter."
        />

        {/* Status summary — each card filters the list */}
        <section
          aria-label="Candidatures par statut"
          className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6"
        >
          <Link
            href={href({ status: null })}
            scroll={false}
            aria-current={!status ? "page" : undefined}
            className={cn(
              "rounded-2xl border bg-white p-4 shadow-[0_1px_2px_rgba(15,25,60,0.05)] transition-shadow hover:shadow-[0_12px_28px_-18px_rgba(15,25,60,0.3)]",
              !status ? "border-ink ring-2 ring-ink/10" : "border-line"
            )}
          >
            <p className="text-[13.5px] font-semibold text-ink/70">Toutes</p>
            <p className="mt-1 font-display text-[28px] font-black leading-none tabular-nums text-ink">
              {allCount.toLocaleString("fr-FR")}
            </p>
          </Link>
          {APPLICATION_STATUSES.map((s) => {
            const active = status === s;
            return (
              <Link
                key={s}
                href={href({ status: s })}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-2xl border bg-white p-4 shadow-[0_1px_2px_rgba(15,25,60,0.05)] transition-shadow hover:shadow-[0_12px_28px_-18px_rgba(15,25,60,0.3)]",
                  active
                    ? cn("border-transparent ring-2", STATUS_STYLE[s].ring)
                    : "border-line"
                )}
              >
                <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink/70">
                  <span
                    aria-hidden
                    className={cn("h-2 w-2 rounded-full", STATUS_STYLE[s].dot)}
                  />
                  {APPLICATION_STATUS_LABEL[s]}
                </p>
                <p className="mt-1 font-display text-[28px] font-black leading-none tabular-nums text-ink">
                  {(counts.get(s) ?? 0).toLocaleString("fr-FR")}
                </p>
              </Link>
            );
          })}
        </section>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <nav aria-label="Filtrer par rôle" className="flex flex-wrap gap-2.5">
            <FilterTab
              href={href({ type: null })}
              active={!type}
              label="Tous les rôles"
            />
            {APPLICATION_TYPES.map((t) => (
              <FilterTab
                key={t}
                href={href({ type: t })}
                active={type === t}
                label={APPLICATION_TYPE_LABEL[t]}
              />
            ))}
          </nav>
          <ApplicationsSearch total={total} />
        </div>

        {/* List */}
        {items.length === 0 ? (
          <EmptyState
            title="Aucune candidature ne correspond."
            hint="Changez de statut ou de rôle, ou effacez la recherche."
          />
        ) : (
          <ul className="space-y-3">
            {items.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/admin/applications/${a.id}`}
                  className="group grid items-center gap-4 rounded-2xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(15,25,60,0.05)] transition-shadow hover:shadow-[0_14px_34px_-22px_rgba(15,25,60,0.3)] md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_auto_auto]"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <Avatar name={`${a.firstName} ${a.lastName}`} />
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold text-ink">
                        {a.firstName} {a.lastName}
                      </p>
                      <p className="truncate text-[13px] text-ink/60">
                        {a.email}
                      </p>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-ink/85">
                      {a.organization ?? "Sans organisation"}
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-ink/55">
                      <Chip tone="neutral">
                        {APPLICATION_TYPE_LABEL[a.type as ApplicationTypeKey]}
                      </Chip>
                      <span className="tabular-nums">
                        {a.createdAt.toLocaleDateString("fr-FR", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric"
                        })}
                      </span>
                    </p>
                  </div>

                  <StatusPill status={a.status as ApplicationStatusKey} />

                  <span className="hidden items-center gap-1 text-[13.5px] font-semibold text-cobalt group-hover:underline md:inline-flex">
                    Ouvrir <span aria-hidden>→</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <PaginationNav
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          hrefFor={(n) => href({ page: n })}
        />

        <p className="text-[13px] text-ink/50">
          Les statuts de candidature ({APPLICATION_STATUS_LABEL.RECEIVED},{" "}
          {APPLICATION_STATUS_LABEL.UNDER_REVIEW}, …) sont indépendants du
          statut d&apos;inscription des participants.
        </p>
      </PageBody>
    </>
  );
}

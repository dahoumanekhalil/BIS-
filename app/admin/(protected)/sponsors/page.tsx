import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { can } from "@/lib/admin/rbac";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { prisma } from "@/lib/db";
import { PartnerTier } from "@prisma/client";
import { SortableSponsorGrid } from "./sortable-grid";

export const dynamic = "force-dynamic";

const TIER_STYLE: Record<PartnerTier, string> = {
  PRESENTING: "bg-cobalt text-white",
  PLATINUM: "bg-ink text-white",
  GOLD: "bg-amber-200 text-amber-900",
  SILVER: "bg-ink/[0.08] text-ink/80",
  ECOSYSTEM: "bg-lime/25 text-ink",
  MEDIA: "bg-cobalt/10 text-cobalt"
};

const TIER_ORDER: Record<PartnerTier, number> = {
  PRESENTING: 0,
  PLATINUM: 1,
  GOLD: 2,
  SILVER: 3,
  ECOSYSTEM: 4,
  MEDIA: 5
};

export default async function AdminSponsorsPage({
  searchParams
}: {
  searchParams: Promise<{
    created?: string;
    updated?: string;
    deleted?: string;
  }>;
}) {
  const { user } = await requirePermission("sponsors.view");
  const sp = await searchParams;
  const canManage = can(user.role, "sponsors.manage");

  const partners = await prisma.partner.findMany({
    orderBy: [{ tier: "asc" }, { order: "asc" }, { name: "asc" }]
  });

  // Group by tier for a proper editorial layout.
  const groups = new Map<PartnerTier, typeof partners>();
  for (const p of partners) {
    if (!groups.has(p.tier)) groups.set(p.tier, []);
    groups.get(p.tier)!.push(p);
  }
  const orderedGroups = Array.from(groups.entries()).sort(
    (a, b) => TIER_ORDER[a[0]] - TIER_ORDER[b[0]]
  );

  return (
    <>
      <AdminHeader user={user} title="Sponsors" subtitle="Business" />

      <div className="space-y-6 p-6">
        {sp.created && (
          <Toast tone="success">
            Sponsor <b>{sp.created}</b> créé.
          </Toast>
        )}
        {sp.updated && (
          <Toast tone="info">
            Sponsor <b>{sp.updated}</b> mis à jour.
          </Toast>
        )}
        {sp.deleted && (
          <Toast tone="danger">
            Sponsor <b>{sp.deleted}</b> supprimé.
          </Toast>
        )}

        {/* Header row */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-white p-4">
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Partenaires de l&apos;édition
            </p>
            <p className="mt-0.5 text-[13px] font-semibold text-ink">
              {partners.length} sponsor{partners.length > 1 ? "s" : ""} référencé{partners.length > 1 ? "s" : ""}
            </p>
            {canManage && partners.length > 0 && (
              <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink/50">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                </svg>
                Glissez les cartes pour réordonner à l&apos;intérieur d&apos;un
                même tier.
              </p>
            )}
          </div>
          {canManage && (
            <Link
              href="/admin/sponsors/new"
              className="inline-flex items-center gap-1.5 rounded-btn bg-ink px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-navy"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Nouveau sponsor
            </Link>
          )}
        </div>

        {partners.length === 0 ? (
          <EmptyState
            title="Aucun sponsor pour le moment."
            hint="Créez votre premier sponsor pour l'édition 2027."
            action={
              canManage ? (
                <Link
                  href="/admin/sponsors/new"
                  className="inline-flex items-center gap-1.5 rounded-btn bg-ink px-4 py-2 text-[12.5px] font-bold text-white hover:bg-navy"
                >
                  Créer un sponsor →
                </Link>
              ) : undefined
            }
          />
        ) : (
          orderedGroups.map(([tier, list]) => (
            <section key={tier}>
              <div className="mb-3 flex items-center gap-3">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.18em] ${TIER_STYLE[tier]}`}
                >
                  {tier}
                </span>
                <div className="h-px flex-1 bg-line" />
                <span className="text-[10.5px] uppercase tracking-[0.22em] text-ink/40">
                  {list.length} sponsor{list.length > 1 ? "s" : ""}
                </span>
              </div>
              <SortableSponsorGrid
                tier={tier}
                items={list.map((p) => ({
                  id: p.id,
                  name: p.name,
                  tier: p.tier,
                  order: p.order,
                  website: p.website,
                  logoUrl: p.logoUrl
                }))}
                canManage={canManage}
              />
            </section>
          ))
        )}
      </div>
    </>
  );
}

function Toast({
  children,
  tone
}: {
  children: React.ReactNode;
  tone: "success" | "info" | "danger";
}) {
  const style =
    tone === "success"
      ? "border-lime/40 bg-lime/10 text-ink"
      : tone === "info"
        ? "border-cobalt/40 bg-cobalt/10 text-cobalt"
        : "border-red-200 bg-red-50 text-red-800";
  return (
    <div
      role="status"
      className={`rounded-btn border px-4 py-2.5 text-[13px] ${style}`}
    >
      {children}
    </div>
  );
}

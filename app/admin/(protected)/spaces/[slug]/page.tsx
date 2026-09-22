import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { can } from "@/lib/admin/rbac";
import {
  getSpaceBySlug,
  listAssignableAdmins
} from "@/lib/admin/space-queries";
import { AdminHeader } from "@/components/admin/header";
import { cn } from "@/lib/utils";
import { IdentityPanel } from "./identity-panel";
import { AdmissionPanel } from "./admission-panel";
import { TeamPanel } from "./team-panel";
import { ContentPanel } from "./content-panel";
import { DangerPanel } from "./danger-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fiche espace" };

// Phase 17 — Space detail page.
//
// Read gated by `access.view`. Every mutation surface (client
// components below) posts to a server action that re-checks
// `settings.manage`. Client `canManage` is UX only.
export default async function SpaceDetailPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { user } = await requirePermission("access.view");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const space = await getSpaceBySlug(slug);
  if (!space) notFound();

  const canManage = can(user.role, "settings.manage");
  // Only load the eligible-user list when the operator can actually
  // add teammates — avoids leaking the admin roster to read-only viewers.
  const assignable = canManage
    ? await listAssignableAdmins(space.id)
    : [];

  const admissionLabel =
    space.admissionMode === "FREE"
      ? "Gratuit"
      : space.admissionMode === "PAID"
        ? "Payant"
        : "Non défini";
  const typeLabel =
    space.type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle";

  return (
    <>
      <AdminHeader
        user={user}
        title={space.name}
        subtitle={`${typeLabel} · ${admissionLabel}`}
      />

      <div className="space-y-6 p-6">
        <Link
          href="/admin/spaces"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          ← Espaces
        </Link>

        {/* Operational quick actions */}
        <section className="flex flex-wrap gap-2">
          {space.active ? (
            <Link
              href={`/admin/scan/${encodeURIComponent(space.slug)}`}
              className="inline-flex items-center gap-2 rounded-btn bg-cobalt px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-cobalt-700"
            >
              Ouvrir le scanner →
            </Link>
          ) : (
            <span
              className="inline-flex items-center gap-2 rounded-btn border border-dashed border-ink/20 bg-white px-4 py-2 text-[13px] font-bold text-ink/40"
              title="Espace désactivé"
            >
              Scanner indisponible
            </span>
          )}
          <Link
            href={`/admin/scan/history?accessPointId=${encodeURIComponent(space.id)}`}
            className="inline-flex items-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[13px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
          >
            Voir l&apos;historique →
          </Link>
          <Link
            href="/admin/access-points"
            className="inline-flex items-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[13px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
          >
            Administration technique →
          </Link>
        </section>

        {/* Status pills row */}
        <section className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Statut opérationnel
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusPill tone={space.active ? "green" : "muted"}>
              {space.active ? "Actif" : "Désactivé"}
            </StatusPill>
            <StatusPill tone="cobalt">{typeLabel}</StatusPill>
            <StatusPill
              tone={
                space.admissionMode === "FREE"
                  ? "green"
                  : space.admissionMode === "PAID"
                    ? "cobalt"
                    : "muted"
              }
            >
              {admissionLabel}
            </StatusPill>
            <StatusPill tone="muted">
              {space.team.length} membre{space.team.length === 1 ? "" : "s"}{" "}
              d&apos;équipe
            </StatusPill>
            <StatusPill tone="muted">
              {space.counts.checkIns} check-in
              {space.counts.checkIns === 1 ? "" : "s"}
            </StatusPill>
          </div>
        </section>

        <IdentityPanel
          space={{
            id: space.id,
            slug: space.slug,
            name: space.name,
            description: space.description,
            order: space.order,
            slugLocked: space.counts.checkIns > 0
          }}
          canManage={canManage}
        />

        <AdmissionPanel
          space={{
            id: space.id,
            admissionMode: space.admissionMode,
            type: space.type
          }}
          canManage={canManage}
        />

        <TeamPanel
          space={{ id: space.id, slug: space.slug, name: space.name }}
          team={space.team}
          assignable={assignable}
          canManage={canManage}
        />

        <ContentPanel
          space={{
            id: space.id,
            activities: space.activities,
            topics: space.topics,
            exhibitors: space.exhibitors
          }}
          canManage={canManage}
        />

        {canManage && (
          <DangerPanel
            space={{
              id: space.id,
              slug: space.slug,
              name: space.name,
              active: space.active,
              deletable:
                space.counts.checkIns === 0 &&
                space.counts.permissions === 0
            }}
          />
        )}
      </div>
    </>
  );
}

function StatusPill({
  tone,
  children
}: {
  tone: "green" | "cobalt" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-[3px] text-[10px] font-bold uppercase tracking-[0.16em]",
        tone === "green" && "bg-lime/25 text-ink",
        tone === "cobalt" && "bg-cobalt/15 text-cobalt",
        tone === "muted" && "bg-ink/10 text-ink/60"
      )}
    >
      {children}
    </span>
  );
}

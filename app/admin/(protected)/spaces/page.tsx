import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { can } from "@/lib/admin/rbac";
import { listSpaces } from "@/lib/admin/space-queries";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { cn } from "@/lib/utils";
import { CreateSpaceForm } from "./create-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Espaces" };

// Phase 17 — Spaces admin index.
//
// Auth: read gated by `access.view` (same permission that Phase 8 uses
// for AccessPoint list). Write actions inside the detail page are
// gated at `settings.manage` server-side. Client-side `canManage`
// merely hides the create button; the server action re-checks.
export default async function SpacesPage() {
  const { user } = await requirePermission("access.view");
  const spaces = await listSpaces();
  const canManage = can(user.role, "settings.manage");

  const mains = spaces.filter((s) => s.type === "MAIN_ENTRANCE");
  const rooms = spaces.filter((s) => s.type === "ROOM");

  return (
    <>
      <AdminHeader
        user={user}
        title="Espaces"
        subtitle="Gestion opérationnelle des espaces d'exposition BIS 2026"
      />

      <div className="space-y-6 p-6">
        <section className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            À propos
          </p>
          <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-ink/65">
            Chaque espace correspond à un point d&apos;accès physique du
            sommet. Configurez ici l&apos;identité, l&apos;équipe
            check-in, la politique d&apos;admission et les activités.
            Les règles d&apos;accès (paiement, autorisations par salle)
            restent celles définies par le validateur d&apos;accès.
          </p>
        </section>

        {canManage && <CreateSpaceForm />}

        {spaces.length === 0 ? (
          <EmptyState
            title="Aucun espace configuré."
            hint="Créez le premier espace ci-dessus."
          />
        ) : (
          <>
            {mains.length > 0 && (
              <Group title="Entrée principale">
                {mains.map((s) => (
                  <SpaceCard key={s.id} space={s} />
                ))}
              </Group>
            )}
            {rooms.length > 0 && (
              <Group title="Salles">
                {rooms.map((s) => (
                  <SpaceCard key={s.id} space={s} />
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Group({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        {title}
      </p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </ul>
    </section>
  );
}

function SpaceCard({
  space
}: {
  space: Awaited<ReturnType<typeof listSpaces>>[number];
}) {
  const admissionLabel =
    space.admissionMode === "FREE"
      ? "Gratuit"
      : space.admissionMode === "PAID"
        ? "Payant"
        : "Non défini";
  const admissionTone =
    space.admissionMode === "FREE"
      ? "bg-lime/25 text-ink"
      : space.admissionMode === "PAID"
        ? "bg-cobalt/15 text-cobalt"
        : "bg-ink/10 text-ink/60";
  return (
    <li
      className={cn(
        "flex flex-col justify-between gap-3 rounded-card border bg-white p-5 transition-shadow hover:shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]",
        space.active ? "border-line" : "border-ink/15 opacity-70"
      )}
    >
      <div>
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="font-display text-[17px] font-black tracking-tight text-ink">
            {space.name}
          </p>
          <span className="rounded-full bg-ink/5 px-2 py-[2px] font-mono text-[10.5px] font-semibold text-ink/60">
            {space.slug}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              space.type === "MAIN_ENTRANCE"
                ? "bg-cobalt/15 text-cobalt"
                : "bg-lime/25 text-ink"
            )}
          >
            {space.type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle"}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              space.active ? "bg-lime/25 text-ink" : "bg-ink/10 text-ink/60"
            )}
          >
            {space.active ? "Actif" : "Désactivé"}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              admissionTone
            )}
          >
            {admissionLabel}
          </span>
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-ink/60">
          <li>
            <span className="font-semibold text-ink/80">
              {space.teamCount}
            </span>{" "}
            membre{space.teamCount === 1 ? "" : "s"} d&apos;équipe
          </li>
          <li>
            <span className="font-semibold text-ink/80">
              {space.activityCount}
            </span>{" "}
            activité{space.activityCount === 1 ? "" : "s"}
          </li>
          <li>
            <span className="font-semibold text-ink/80">
              {space.topicCount}
            </span>{" "}
            thème{space.topicCount === 1 ? "" : "s"}
          </li>
          <li>
            <span className="font-semibold text-ink/80">
              {space.exhibitorCount}
            </span>{" "}
            exposant{space.exhibitorCount === 1 ? "" : "s"}
          </li>
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/admin/spaces/${encodeURIComponent(space.slug)}`}
          className="inline-flex items-center justify-center gap-1 rounded-btn bg-cobalt px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-cobalt-700"
        >
          Ouvrir la fiche →
        </Link>
        {space.active ? (
          <Link
            href={`/admin/scan/${encodeURIComponent(space.slug)}`}
            className="inline-flex items-center justify-center gap-1 rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
          >
            Scanner →
          </Link>
        ) : (
          <span
            className="inline-flex items-center justify-center gap-1 rounded-btn border border-dashed border-ink/20 bg-white px-4 py-2 text-[12.5px] font-bold text-ink/40"
            title="Espace désactivé"
          >
            Scanner —
          </span>
        )}
      </div>
    </li>
  );
}

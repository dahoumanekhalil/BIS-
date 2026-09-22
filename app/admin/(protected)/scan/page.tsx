import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { can } from "@/lib/admin/rbac";
import { getAccessPointsWithUsage } from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { cn } from "@/lib/utils";
import type { AccessPointType } from "@prisma/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de scan" };

// Phase 16 — QR Operations Center hub.
//
// Server-rendered index of every configured AccessPoint. The list is
// loaded from the DB via the SAME helper the Phase 8 admin page uses
// (`getAccessPointsWithUsage`) — no slugs are hardcoded, and any AP
// added by an admin appears here without a code change.
//
// AUTHORIZATION:
//   • Page-level gate: `checkin.view` (same permission that already
//     gates `/admin/check-in`). Grants SUPER_ADMIN, ADMIN,
//     REGISTRATION_MANAGER, SALES, and CHECKIN_OPERATOR a hub view.
//   • Per-card CTA: enabled only when the operator holds the
//     type-derived scanner permission (`access.validate.main` for
//     MAIN_ENTRANCE, `access.validate.room` for ROOM).
//   • Client-side visibility is UX only. The Phase 9 scanner route
//     re-checks the strict permission server-side before rendering
//     the camera shell, and the Phase 10/11 validators re-check
//     again inside every server action. Hiding a CTA does NOT weaken
//     the security model — it just gives the operator less to click.
export default async function ScanHubPage() {
  const { user } = await requirePermission("checkin.view");
  const points = await getAccessPointsWithUsage();

  const canValidateMain = can(user.role, "access.validate.main");
  const canValidateRoom = can(user.role, "access.validate.room");

  const mains = points.filter((p) => p.type === "MAIN_ENTRANCE");
  const rooms = points.filter((p) => p.type === "ROOM");

  return (
    <>
      <AdminHeader
        user={user}
        title="Centre de scan"
        subtitle="Scannez les badges des participants depuis chaque point d'accès."
      />

      <div className="space-y-8 p-6">
        <section className="grid gap-3 rounded-card border border-line bg-white p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Vue d&apos;ensemble
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/65">
              Ouvrez le scanner sur le point d&apos;accès que vous couvrez.
              Chaque scan est validé côté serveur avec la règle
              correspondant au type de point (entrée principale ou salle).
              Consultez l&apos;historique global pour retrouver un passage.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Link
              href="/admin/scan/history"
              className="inline-flex items-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
            >
              Historique des scans →
            </Link>
            {can(user.role, "analytics.view") && (
              <Link
                href="/admin/scan/analytics"
                className="inline-flex items-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
              >
                Analytics check-in →
              </Link>
            )}
            {can(user.role, "access.view") && (
              <Link
                href="/admin/access-points"
                className="inline-flex items-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
              >
                Configurer les points →
              </Link>
            )}
          </div>
        </section>

        {points.length === 0 ? (
          <EmptyState
            title="Aucun point d'accès configuré."
            hint="Créez le premier point depuis « Access points »."
          />
        ) : (
          <>
            {mains.length > 0 && (
              <Group title="Entrée principale">
                {mains.map((p) => (
                  <PointCard
                    key={p.id}
                    slug={p.slug}
                    name={p.name}
                    type={p.type}
                    active={p.active}
                    canOperate={canValidateMain}
                  />
                ))}
              </Group>
            )}

            {rooms.length > 0 && (
              <Group title="Salles">
                {rooms.map((p) => (
                  <PointCard
                    key={p.id}
                    slug={p.slug}
                    name={p.name}
                    type={p.type}
                    active={p.active}
                    canOperate={canValidateRoom}
                  />
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

function PointCard({
  slug,
  name,
  type,
  active,
  canOperate
}: {
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  canOperate: boolean;
}) {
  const typeLabel = type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle";
  const inactive = !active;
  const disabled = inactive || !canOperate;

  return (
    <li
      className={cn(
        "flex flex-col justify-between gap-3 rounded-card border bg-white p-5 transition-shadow",
        inactive
          ? "border-ink/15 opacity-70"
          : canOperate
            ? "border-line hover:shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]"
            : "border-line"
      )}
    >
      <div>
        <p className="font-display text-[17px] font-black tracking-tight text-ink">
          {name}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              type === "MAIN_ENTRANCE"
                ? "bg-cobalt/15 text-cobalt"
                : "bg-lime/25 text-ink"
            )}
          >
            {typeLabel}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              active ? "bg-lime/25 text-ink" : "bg-ink/10 text-ink/60"
            )}
          >
            {active ? "Actif" : "Désactivé"}
          </span>
        </p>
        <p className="mt-2 font-mono text-[10.5px] text-ink/55">/{slug}</p>
      </div>

      {disabled ? (
        <div
          className={cn(
            "rounded-btn border border-dashed px-3 py-2 text-center text-[11.5px] font-semibold",
            inactive
              ? "border-ink/20 text-ink/50"
              : "border-amber-300/60 text-amber-800"
          )}
          aria-hidden={false}
        >
          {inactive
            ? "Scanner indisponible — point désactivé"
            : "Vous n'êtes pas autorisé à opérer ce scanner"}
        </div>
      ) : (
        <Link
          href={`/admin/scan/${slug}`}
          className="inline-flex items-center justify-center gap-2 rounded-btn bg-cobalt px-4 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-cobalt-700"
          aria-label={`Ouvrir le scanner du point ${name}`}
        >
          Ouvrir le scanner →
        </Link>
      )}
    </li>
  );
}

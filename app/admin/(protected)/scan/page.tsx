import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { can } from "@/lib/admin/rbac";
import { getAccessPointsWithUsage } from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { PageBody, Chip } from "@/components/admin/page-kit";
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
  const activeCount = points.filter((p) => p.active).length;
  const totalScans = points.reduce((sum, p) => sum + p.checkInCount, 0);

  return (
    <>
      <AdminHeader
        user={user}
        title="Centre de scan"
        subtitle="Points d'accès"
      />

      <PageBody>
        {/* Overview */}
        <section className="relative overflow-hidden rounded-[24px] bg-navy p-7 text-white sm:p-8">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-lime/10 blur-[90px]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-32 left-1/3 h-64 w-64 rounded-full bg-cobalt/25 blur-[100px]"
          />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="font-display text-[26px] font-black leading-tight tracking-tight">
                Choisissez un point d&apos;accès à scanner
              </h2>
              <p className="mt-2 text-[14.5px] leading-relaxed text-white/65">
                Ouvrez le scanner sur le point que vous couvrez. Chaque scan
                est vérifié côté serveur selon le type de point (entrée
                principale ou salle).
              </p>
              <div className="mt-5 flex flex-wrap gap-2.5">
                <HeroLink href="/admin/scan/history">
                  Historique des scans
                </HeroLink>
                {can(user.role, "analytics.view") && (
                  <HeroLink href="/admin/scan/analytics">
                    Statistiques
                  </HeroLink>
                )}
                {can(user.role, "access.view") && (
                  <HeroLink href="/admin/access-points">
                    Configurer les points
                  </HeroLink>
                )}
              </div>
            </div>

            <dl className="grid shrink-0 grid-cols-3 gap-3">
              <HeroStat label="Points" value={points.length} />
              <HeroStat label="Actifs" value={activeCount} />
              <HeroStat label="Scans" value={totalScans} />
            </dl>
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
              <Group title="Entrée principale" count={mains.length}>
                {mains.map((p) => (
                  <PointCard
                    key={p.id}
                    slug={p.slug}
                    name={p.name}
                    type={p.type}
                    active={p.active}
                    scans={p.checkInCount}
                    authorized={p.permissionCount}
                    canOperate={canValidateMain}
                  />
                ))}
              </Group>
            )}

            {rooms.length > 0 && (
              <Group title="Salles" count={rooms.length}>
                {rooms.map((p) => (
                  <PointCard
                    key={p.id}
                    slug={p.slug}
                    name={p.name}
                    type={p.type}
                    active={p.active}
                    scans={p.checkInCount}
                    authorized={p.permissionCount}
                    canOperate={canValidateRoom}
                  />
                ))}
              </Group>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}

function HeroLink({
  href,
  children
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-btn border border-white/20 bg-white/10 px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-white/20"
    >
      {children}
    </Link>
  );
}

function HeroStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-[88px] rounded-card border border-white/10 bg-white/[0.06] px-4 py-3 text-center backdrop-blur-sm">
      <dd className="font-display text-[28px] font-black leading-none tabular-nums">
        {value.toLocaleString("fr-FR")}
      </dd>
      <dt className="mt-1.5 text-[12.5px] font-medium text-white/55">
        {label}
      </dt>
    </div>
  );
}

function Group({
  title,
  count,
  children
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="font-display text-[19px] font-bold tracking-tight text-ink">
          {title}
        </h2>
        <span className="text-[14px] font-semibold text-ink/50">{count}</span>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</ul>
    </section>
  );
}

function PointCard({
  slug,
  name,
  type,
  active,
  scans,
  authorized,
  canOperate
}: {
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  scans: number;
  authorized: number;
  canOperate: boolean;
}) {
  const isMain = type === "MAIN_ENTRANCE";
  const inactive = !active;
  const disabled = inactive || !canOperate;

  return (
    <li
      className={cn(
        "flex flex-col gap-5 rounded-2xl border bg-white p-6 shadow-[0_1px_2px_rgba(15,25,60,0.05)] transition-shadow",
        inactive
          ? "border-ink/15 bg-white/70"
          : "border-line hover:shadow-[0_16px_40px_-22px_rgba(15,25,60,0.3)]"
      )}
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className={cn(
            "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
            inactive
              ? "bg-ink/[0.07] text-ink/40"
              : isMain
                ? "bg-cobalt/10 text-cobalt"
                : "bg-lime/25 text-ink"
          )}
        >
          {isMain ? <GateIcon /> : <RoomIcon />}
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-[18px] font-black leading-tight tracking-tight text-ink">
            {name}
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip tone={isMain ? "info" : "ok"}>
              {isMain ? "Entrée principale" : "Salle"}
            </Chip>
            <Chip tone={active ? "ok" : "neutral"}>
              {active ? "Actif" : "Désactivé"}
            </Chip>
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-card bg-frost px-4 py-3">
        <div>
          <dd className="text-[20px] font-bold tabular-nums text-ink">
            {scans.toLocaleString("fr-FR")}
          </dd>
          <dt className="text-[13px] text-ink/60">Scans enregistrés</dt>
        </div>
        <div>
          <dd className="text-[20px] font-bold tabular-nums text-ink">
            {authorized.toLocaleString("fr-FR")}
          </dd>
          <dt className="text-[13px] text-ink/60">Accès accordés</dt>
        </div>
      </dl>

      {disabled ? (
        <p
          className={cn(
            "rounded-btn border border-dashed px-4 py-3 text-center text-[13.5px] font-semibold",
            inactive
              ? "border-ink/20 text-ink/55"
              : "border-amber-300 bg-amber-50 text-amber-900"
          )}
        >
          {inactive
            ? "Scanner indisponible : point désactivé"
            : "Vous n'êtes pas autorisé à opérer ce scanner"}
        </p>
      ) : (
        <Link
          href={`/admin/scan/${slug}`}
          className="inline-flex items-center justify-center gap-2 rounded-btn bg-cobalt px-4 py-3 text-[14.5px] font-bold text-white transition-colors hover:bg-cobalt-700"
          aria-label={`Ouvrir le scanner du point ${name}`}
        >
          Ouvrir le scanner
          <span aria-hidden>→</span>
        </Link>
      )}
    </li>
  );
}

function GateIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
      <path d="M2 21h20M12 12h.01" />
      <path d="M16 8h2a2 2 0 0 1 2 2v11" />
    </svg>
  );
}

function RoomIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

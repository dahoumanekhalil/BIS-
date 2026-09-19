import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { prisma } from "@/lib/db";
import {
  AdminRole,
  AdminStatus,
  RegistrationTier,
  RegistrationType
} from "@prisma/client";
import {
  ROLE_CATALOG,
  OPS,
  getAccessForRole,
  type RoleCard as RoleCardType,
  type Op
} from "@/lib/admin/role-catalog";
import { TONE, OpChip, OpsLegend } from "./ui";

export const dynamic = "force-dynamic";

// ---- Data ----------------------------------------------------------------

type CountBundle = {
  staff: Record<AdminRole, number>;
  tiers: Record<RegistrationTier, number>;
  sponsors: number;
};

async function loadCounts(): Promise<CountBundle> {
  const [adminGroups, tierGroups, sponsors] = await Promise.all([
    prisma.adminUser.groupBy({
      by: ["role"],
      where: { status: AdminStatus.ACTIVE },
      _count: { _all: true }
    }),
    prisma.participant.groupBy({
      by: ["tier"],
      where: { tier: { not: null } },
      _count: { _all: true }
    }),
    prisma.participant.count({
      where: { registrationType: RegistrationType.PARTNER }
    })
  ]);

  const staff = Object.values(AdminRole).reduce(
    (acc, r) => {
      acc[r] = 0;
      return acc;
    },
    {} as Record<AdminRole, number>
  );
  for (const g of adminGroups) staff[g.role] = g._count._all;

  const tiers = Object.values(RegistrationTier).reduce(
    (acc, t) => {
      acc[t] = 0;
      return acc;
    },
    {} as Record<RegistrationTier, number>
  );
  for (const g of tierGroups) {
    if (g.tier) tiers[g.tier] = g._count._all;
  }

  return { staff, tiers, sponsors };
}

function countFor(role: RoleCardType, counts: CountBundle): number {
  if (role.kind === "staff") return counts.staff[role.adminRole];
  if (role.tier === "SPONSOR") return counts.sponsors;
  return counts.tiers[role.tier];
}

function countLabel(role: RoleCardType): string {
  if (role.kind === "staff") return "comptes";
  if (role.tier === "SPONSOR") return "sponsors";
  return "participants";
}

// ---- Card ----------------------------------------------------------------

function AccessBar({ role }: { role: RoleCardType }) {
  const access = getAccessForRole(role);
  const totalGranted = access.reduce((n, a) => n + a.grantedOps, 0);
  const totalAvailable = access.reduce((n, a) => n + a.totalOps, 0);
  const modulesWithAny = access.filter((a) => a.grantedOps > 0).length;

  return (
    <div className="flex items-end justify-between rounded-xl border border-line/50 bg-frost/20 px-4 py-3">
      <Stat label="Modules" value={`${modulesWithAny}/${access.length}`} />
      <Stat
        label="Permissions"
        value={`${totalGranted}/${totalAvailable}`}
        align="center"
      />
      <Stat
        label="Accès"
        value={
          totalGranted === totalAvailable
            ? "Total"
            : totalGranted === 0
              ? "Aucun"
              : totalGranted > totalAvailable / 2
                ? "Étendu"
                : "Limité"
        }
        align="right"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  align = "left"
}: {
  label: string;
  value: string;
  align?: "left" | "center" | "right";
}) {
  const alignClass =
    align === "center"
      ? "text-center"
      : align === "right"
        ? "text-right"
        : "text-left";
  return (
    <div className={alignClass}>
      <p className="text-[8.5px] font-bold uppercase tracking-[0.22em] text-ink/35">
        {label}
      </p>
      <p className="mt-1 font-display text-[16px] font-black leading-none tracking-tight text-ink tabular-nums">
        {value}
      </p>
    </div>
  );
}

function RoleCardView({
  role,
  count,
  countUnit
}: {
  role: RoleCardType;
  count: number;
  countUnit: string;
}) {
  const tone = TONE[role.tone];
  const access = getAccessForRole(role);

  // Aggregate ops across all modules — union of ops granted anywhere.
  const opsGranted = new Set<Op>();
  for (const m of access) {
    for (const op of OPS) if (m.granted[op]) opsGranted.add(op);
  }
  const hasOp = (op: Op) => opsGranted.has(op);
  const visibleOps: Op[] =
    role.kind === "staff"
      ? ["create", "read", "update", "delete"]
      : ["read", "update"];

  return (
    <Link
      href={`/admin/roles/${role.key}`}
      aria-label={`Voir le détail du rôle ${role.name}`}
      className={`group relative flex overflow-hidden rounded-2xl border border-line/60 bg-white shadow-[0_2px_8px_rgba(15,23,42,0.06)] transition-all duration-300 hover:shadow-[0_12px_32px_-8px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40 focus-visible:ring-offset-2`}
    >
      {/* Left accent bar */}
      <div className={`w-1.5 shrink-0 ${tone.accent}`} aria-hidden />

      {/* Content area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top row: avatar + name + count */}
        <div className="flex items-center gap-3.5 px-5 pt-5 pb-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg font-display text-[13px] font-black tracking-tight ${tone.chip}`}
          >
            {role.initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-display text-[16px] font-black leading-none tracking-tight text-ink">
                {role.name}
              </h3>
              <span
                className={`shrink-0 rounded-md px-2 py-[2px] text-[8.5px] font-bold uppercase tracking-[0.16em] ${tone.badge}`}
              >
                {role.kind === "staff" ? "Staff" : "Public"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[9.5px] font-semibold tracking-wide text-ink/40">
              {role.tag}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-display text-[22px] font-black leading-none tracking-tight text-ink tabular-nums">
              {count}
            </p>
            <p className="text-[8px] font-bold uppercase tracking-[0.18em] text-ink/35">
              {countUnit}
            </p>
          </div>
        </div>

        {/* Description */}
        <div className="flex-1 px-5 pb-3">
          <p className="text-[13px] font-medium leading-relaxed text-ink/65 line-clamp-2">
            {role.headline}
          </p>
        </div>

        {/* Bottom section: ops + stats side by side */}
        <div className="flex items-stretch border-t border-line/40 bg-frost/20">
          {/* Ops */}
          <div className="flex flex-col justify-center gap-1.5 border-r border-line/40 px-4 py-3">
            <p className="text-[7.5px] font-bold uppercase tracking-[0.22em] text-ink/30">
              Actions
            </p>
            <div className="flex items-center gap-1">
              {visibleOps.map((op) => (
                <OpChip key={op} op={op} granted={hasOp(op)} size="sm" />
              ))}
            </div>
          </div>

          {/* Stats */}
          <div className="flex flex-1 items-center justify-around px-3 py-2.5">
            <div className="text-center">
              <p className="text-[7.5px] font-bold uppercase tracking-[0.2em] text-ink/30">
                Modules
              </p>
              <p className="mt-0.5 font-display text-[14px] font-black leading-none text-ink tabular-nums">
                {(() => {
                  const access = getAccessForRole(role);
                  const modulesWithAny = access.filter((m) =>
                    OPS.some((op) => m.granted[op])
                  ).length;
                  return `${modulesWithAny}/${access.length}`;
                })()}
              </p>
            </div>
            <div className="h-6 w-px bg-line/40" aria-hidden />
            <div className="text-center">
              <p className="text-[7.5px] font-bold uppercase tracking-[0.2em] text-ink/30">
                Permissions
              </p>
              <p className="mt-0.5 font-display text-[14px] font-black leading-none text-ink tabular-nums">
                {(() => {
                  const access = getAccessForRole(role);
                  let g = 0;
                  let t = 0;
                  for (const m of access) {
                    for (const op of OPS) {
                      t++;
                      if (m.granted[op]) g++;
                    }
                  }
                  return `${g}/${t}`;
                })()}
              </p>
            </div>
            <div className="h-6 w-px bg-line/40" aria-hidden />
            <div className="text-center">
              <p className="text-[7.5px] font-bold uppercase tracking-[0.2em] text-ink/30">
                Accès
              </p>
              <p className="mt-0.5 text-[11px] font-semibold leading-none text-ink/60">
                {(() => {
                  const access = getAccessForRole(role);
                  let g = 0;
                  let t = 0;
                  for (const m of access) {
                    for (const op of OPS) {
                      t++;
                      if (m.granted[op]) g++;
                    }
                  }
                  return g === t
                    ? "Total"
                    : g === 0
                      ? "Aucun"
                      : g > t / 2
                        ? "Étendu"
                        : "Limité";
                })()}
              </p>
            </div>
          </div>
        </div>

        {/* CTA footer */}
        <div className="flex items-center justify-between border-t border-line/40 px-5 py-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ink/40 transition-colors group-hover:text-ink/65">
            Voir les détails
          </span>
          <span
            aria-hidden
            className={`flex h-6 w-6 items-center justify-center rounded-full transition-all group-hover:text-white ${tone.badge} group-hover:${tone.chip.split(" ")[0]}`}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      </div>
    </Link>
  );
}

// ---- Page ---------------------------------------------------------------

export default async function AdminRolesPage() {
  const { user } = await requirePermission("roles.manage");
  const counts = await loadCounts();

  const staff = ROLE_CATALOG.filter((r) => r.kind === "staff");
  const attendee = ROLE_CATALOG.filter((r) => r.kind === "attendee");

  const staffTotal = staff.reduce((n, r) => n + countFor(r, counts), 0);
  const attendeeTotal = attendee.reduce((n, r) => n + countFor(r, counts), 0);

  return (
    <>
      <AdminHeader
        user={user}
        title="Rôles & Permissions"
        subtitle="System"
      />

      <div className="space-y-8 p-6">
        {/* Intro / legend */}
        <div className="overflow-hidden rounded-card border border-line bg-white">
          <div className="grid gap-6 p-6 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
                Catalogue des rôles
              </p>
              <h2 className="mt-1 font-display text-[22px] font-black tracking-tight text-ink">
                Qui peut faire quoi
              </h2>
              <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink/65">
                Deux familles de rôles. Le staff opère le back-office ; les
                rôles publics (VVIP / VIP / Visitor / Sponsor) voient
                uniquement leurs propres informations. Cliquez sur une carte
                pour voir toutes les permissions du rôle, module par module.
              </p>
            </div>
            <div className="rounded-btn border border-line bg-frost/60 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/45">
                Légende
              </p>
              <div className="mt-2.5">
                <OpsLegend />
              </div>
            </div>
          </div>
        </div>

        {/* Staff */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.24em] text-ink/55">
              Rôles staff
            </h2>
            <span className="text-[11px] text-ink/45 tabular-nums">
              {staff.length} rôles · {staffTotal} membre
              {staffTotal === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {staff.map((r) => (
              <RoleCardView
                key={r.key}
                role={r}
                count={countFor(r, counts)}
                countUnit={countLabel(r)}
              />
            ))}
          </div>
        </section>

        {/* Public */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.24em] text-ink/55">
              Rôles publics
            </h2>
            <span className="text-[11px] text-ink/45 tabular-nums">
              {attendee.length} rôles · {attendeeTotal} personne
              {attendeeTotal === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {attendee.map((r) => (
              <RoleCardView
                key={r.key}
                role={r}
                count={countFor(r, counts)}
                countUnit={countLabel(r)}
              />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

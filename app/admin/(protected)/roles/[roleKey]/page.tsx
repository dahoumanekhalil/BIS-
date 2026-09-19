import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { prisma } from "@/lib/db";
import {
  AdminStatus,
  RegistrationTier,
  RegistrationType
} from "@prisma/client";
import {
  ROLE_CATALOG,
  OPS,
  STAFF_MODULES,
  PUBLIC_MODULES,
  getAccessForRole,
  getRoleCard,
  type ModuleAccess,
  type ModuleCategory,
  type Op,
  type RoleCard
} from "@/lib/admin/role-catalog";
import { TONE, OpChip } from "../ui";
import { PermissionEditor } from "./permission-editor";
import { AdminRole } from "@prisma/client";

export const dynamic = "force-dynamic";

const STAFF_MODULES_MAP = Object.fromEntries(
  STAFF_MODULES.map((m) => [m.key, m])
);

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function countUsers(role: RoleCard): Promise<number> {
  if (role.kind === "staff") {
    return prisma.adminUser.count({
      where: { role: role.adminRole, status: AdminStatus.ACTIVE }
    });
  }
  if (role.tier === "SPONSOR") {
    return prisma.participant.count({
      where: { registrationType: RegistrationType.PARTNER }
    });
  }
  return prisma.participant.count({
    where: { tier: role.tier as RegistrationTier }
  });
}

type SampleUser = { id: string; name: string; email: string; hint: string };

async function sampleUsers(role: RoleCard): Promise<SampleUser[]> {
  if (role.kind === "staff") {
    const rows = await prisma.adminUser.findMany({
      where: { role: role.adminRole, status: AdminStatus.ACTIVE },
      select: { id: true, name: true, email: true, lastLoginAt: true },
      orderBy: { createdAt: "asc" },
      take: 5
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      hint: r.lastLoginAt
        ? `Dernière connexion : ${r.lastLoginAt.toLocaleDateString("fr-FR")}`
        : "Aucune connexion enregistrée"
    }));
  }

  const where =
    role.tier === "SPONSOR"
      ? { registrationType: RegistrationType.PARTNER }
      : { tier: role.tier as RegistrationTier };

  const rows = await prisma.participant.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      organization: true
    },
    orderBy: { createdAt: "asc" },
    take: 5
  });
  return rows.map((r) => ({
    id: r.id,
    name: `${r.firstName} ${r.lastName}`,
    email: r.email,
    hint: r.organization ?? (role.tier === "SPONSOR" ? "Sponsor" : "Participant")
  }));
}

// ---------------------------------------------------------------------------
// Ops introspection — which ops does a module *support* (regardless of role)
// ---------------------------------------------------------------------------

function supportedOpsFor(moduleKey: string): Op[] {
  const staff = STAFF_MODULES.find((m) => m.key === moduleKey);
  if (staff) return OPS.filter((op) => staff.ops[op] !== undefined);
  const pub = PUBLIC_MODULES.find((m) => m.key === moduleKey);
  if (pub) return OPS.filter((op) => pub.ops[op] !== undefined);
  return [];
}

// ---------------------------------------------------------------------------
// Presentational
// ---------------------------------------------------------------------------

function ModuleRow({ m }: { m: ModuleAccess }) {
  const supported = supportedOpsFor(m.key);
  const isFull = m.grantedOps === supported.length && supported.length > 0;
  const isEmpty = m.grantedOps === 0;

  return (
    <div
      className={`grid grid-cols-1 gap-3 rounded-card border p-4 md:grid-cols-[1fr_auto] md:items-center ${
        isEmpty ? "border-line/60 bg-frost/40" : "border-line bg-white"
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4
            className={`font-display text-[14px] font-black tracking-tight ${
              isEmpty ? "text-ink/45" : "text-ink"
            }`}
          >
            {m.label}
          </h4>
          <span
            className={`rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.18em] ${
              isEmpty
                ? "bg-ink/5 text-ink/40"
                : isFull
                  ? "bg-lime/25 text-ink"
                  : "bg-amber-300/25 text-amber-800"
            }`}
          >
            {isEmpty
              ? "Aucun accès"
              : isFull
                ? "Total"
                : `${m.grantedOps}/${supported.length}`}
          </span>
        </div>
        <p
          className={`mt-1 text-[12px] leading-snug ${
            isEmpty ? "text-ink/40" : "text-ink/60"
          }`}
        >
          {m.description}
        </p>
      </div>
      {supported.length === 0 ? (
        <span className="text-[11px] italic text-ink/40">
          Aucune action définie.
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {supported.map((op) => (
            <OpChip key={op} op={op} granted={!!m.granted[op]} />
          ))}
        </div>
      )}
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9.5px] font-bold uppercase tracking-[0.22em] text-ink/45">
        {label}
      </p>
      <p className="mt-1 font-display text-[22px] font-black leading-none tracking-tight text-ink tabular-nums">
        {value}
      </p>
    </div>
  );
}

function ChipInline({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-ink/5 px-1.5 py-[1px] text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink/70">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: ModuleCategory[] = [
  "Overview",
  "Attendees",
  "Event",
  "Business",
  "System",
  "Personal"
];

const CATEGORY_LABEL: Record<ModuleCategory, string> = {
  Overview: "Vue d'ensemble",
  Attendees: "Participants",
  Event: "Événement",
  Business: "Business",
  System: "Système",
  Personal: "Espace personnel"
};

export default async function RoleDetailPage({
  params
}: {
  params: Promise<{ roleKey: string }>;
}) {
  const { user } = await requirePermission("roles.manage");
  const { roleKey } = await params;

  const role = getRoleCard(roleKey);
  if (!role) notFound();

  const [count, sample] = await Promise.all([
    countUsers(role),
    sampleUsers(role)
  ]);
  const access = getAccessForRole(role);

  const baselinePerms: Record<string, boolean> = {};
  if (role.kind === "staff") {
    const catalogEntry = ROLE_CATALOG.find((r) => r.key === roleKey);
    if (catalogEntry && catalogEntry.kind === "staff") {
      const staffMod = STAFF_MODULES_MAP;
      for (const mod of access) {
        const def = staffMod[mod.key];
        if (!def) continue;
        for (const op of OPS) {
          const perm = def.ops[op];
          if (!perm) continue;
          baselinePerms[perm] = !!mod.granted[op];
        }
      }
    }
  }

  const grouped: Record<ModuleCategory, ModuleAccess[]> = {} as Record<
    ModuleCategory,
    ModuleAccess[]
  >;
  for (const cat of CATEGORY_ORDER) grouped[cat] = [];
  for (const a of access) grouped[a.category]?.push(a);

  const totalGranted = access.reduce((n, a) => n + a.grantedOps, 0);
  const totalOps = access.reduce((n, a) => n + a.totalOps, 0);
  const modulesWithAny = access.filter((a) => a.grantedOps > 0).length;

  const tone = TONE[role.tone];

  return (
    <>
      <AdminHeader
        user={user}
        title={role.name}
        subtitle={`System · ${role.tag}`}
      />

      <div className="space-y-8 p-6">
        <Link
          href="/admin/roles"
          className="inline-flex items-center gap-2 text-[12px] font-semibold text-ink/60 transition-colors hover:text-ink"
        >
          <span
            aria-hidden
            className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink/5"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M12 5l-7 7 7 7" />
            </svg>
          </span>
          Retour aux rôles
        </Link>

        {/* Hero */}
        <section
          className={`overflow-hidden rounded-card border border-line bg-white ring-1 ring-inset ${tone.ring}`}
        >
          <div className={`h-1.5 ${tone.accent}`} aria-hidden />
          <div
            className={`relative grid gap-6 bg-gradient-to-br p-6 lg:grid-cols-[1.4fr_1fr] ${tone.gradient}`}
          >
            <div className="flex items-start gap-4">
              <div
                className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl font-display text-[18px] font-black tracking-tight shadow-md ${tone.chip}`}
              >
                {role.initials}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-[26px] font-black leading-tight tracking-tight text-ink">
                    {role.name}
                  </h1>
                  <span
                    className={`rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.18em] ${tone.badge}`}
                  >
                    {role.kind === "staff" ? "Staff" : "Public"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.24em] text-ink/50">
                  {role.tag}
                </p>
                <p className="mt-3 text-[14px] font-semibold text-ink">
                  {role.headline}
                </p>
                <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink/65">
                  {role.summary}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 self-start rounded-card border border-line bg-white/80 p-4 backdrop-blur">
              <HeroStat label="Membres" value={String(count)} />
              <HeroStat
                label="Modules"
                value={`${modulesWithAny}/${access.length}`}
              />
              <HeroStat
                label="Actions"
                value={`${totalGranted}/${totalOps}`}
              />
            </div>
          </div>
        </section>

        {/* Permission editor — available for any staff role when user has roles.manage */}
        {role.kind === "staff" && (
          <section className="rounded-card border-2 border-ink/20 bg-amber-50/30 px-5 py-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2 border-b border-ink/10 pb-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[10px] font-bold text-white">✎</span>
              <h3 className="font-display text-[14px] font-black uppercase tracking-[0.15em] text-ink">
                Éditeur de permissions
              </h3>
              <span className="ml-auto rounded-full bg-lime/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-ink">
                Cliquez pour modifier
              </span>
            </div>
            <PermissionEditor
              roleKey={role.key}
              modules={access}
              baseline={baselinePerms}
            />
          </section>
        )}

        {/* Sample users */}
        <section className="rounded-card border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div>
              <h2 className="font-display text-[15px] font-black tracking-tight text-ink">
                Comptes actuels
              </h2>
              <p className="mt-0.5 text-[11.5px] text-ink/50">
                {count === 0
                  ? "Aucun compte assigné à ce rôle."
                  : `${count} compte${count > 1 ? "s" : ""} actif${count > 1 ? "s" : ""} · aperçu`}
              </p>
            </div>
            {role.kind === "staff" && count > 0 && (
              <Link
                href="/admin/users"
                className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30"
              >
                Gérer les utilisateurs →
              </Link>
            )}
          </div>
          {sample.length === 0 ? (
            <div className="px-5 py-6 text-[12.5px] text-ink/50">
              Aucun compte à afficher.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {sample.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center gap-3 px-5 py-3 text-[13px]"
                >
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-lg font-display text-[10.5px] font-black ${tone.chip}`}
                  >
                    {u.name
                      .split(/\s+/)
                      .map((s) => s[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-ink">{u.name}</p>
                    <p className="truncate text-[11.5px] text-ink/50">
                      {u.email}
                    </p>
                  </div>
                  <p className="hidden text-[11px] text-ink/45 sm:block">
                    {u.hint}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

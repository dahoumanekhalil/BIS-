import Link from "next/link";

import { AdminHeader } from "@/components/admin/header";
import { requireAdmin } from "@/lib/admin/auth";
import { ROLE_LABEL } from "@/lib/admin/rbac";

import { AccountForm } from "./account-form";

// Self-service account settings for the currently-logged-in admin.
//
// Authorization: `requireAdmin()`. This page is available to every
// authenticated admin regardless of role — a Viewer can update their own
// name / email / password, but cannot see anyone else's account here.
// Role- and status-management remain gated by `users.manage` and live in
// /admin/users.

export default async function AdminAccountSettingsPage() {
  const { user } = await requireAdmin();

  return (
    <>
      <AdminHeader user={user} title="Compte" subtitle="Settings" />
      <div className="space-y-6 p-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-[11.5px] text-ink/55">
          <Link
            href="/admin/settings"
            className="font-semibold text-cobalt hover:underline"
          >
            Paramètres
          </Link>
          <ChevronRight />
          <span className="font-semibold text-ink/70">Compte</span>
        </nav>

        {/* Hero: quick facts about the admin's own account */}
        <section className="overflow-hidden rounded-[20px] border border-line bg-white">
          <div className="border-b border-line bg-gradient-to-br from-cobalt/10 to-cobalt/0 px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <Avatar name={user.name} />
                <div>
                  <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/60">
                    Mon compte
                  </p>
                  <h2 className="mt-1 text-[22px] font-black tracking-tight text-ink">
                    {user.name}
                  </h2>
                  <p className="mt-0.5 text-[13px] text-ink/60">{user.email}</p>
                </div>
              </div>
            </div>
          </div>
          <dl className="grid grid-cols-2 divide-x divide-y divide-line md:grid-cols-4">
            <Fact label="Rôle" value={ROLE_LABEL[user.role] ?? user.role} />
            <Fact
              label="Statut"
              value={user.status}
              tone={user.status === "ACTIVE" ? "ok" : "warn"}
            />
            <Fact
              label="Dernière connexion"
              value={
                user.lastLoginAt
                  ? formatDateTime(user.lastLoginAt)
                  : "—"
              }
              muted={!user.lastLoginAt}
            />
            <Fact
              label="Compte créé le"
              value={formatDateTime(user.createdAt)}
            />
          </dl>
        </section>

        {/* Informational callout */}
        <div className="flex items-start gap-3 rounded-[14px] border border-cobalt/20 bg-cobalt/5 px-4 py-3 text-[12.5px] leading-relaxed text-ink/80">
          <span className="mt-0.5 flex-shrink-0 text-cobalt">
            <IconInfo />
          </span>
          <div>
            Vous pouvez modifier ici votre nom, votre adresse email et votre
            mot de passe. Le rôle et le statut de votre compte ne sont
            modifiables que par un autre administrateur disposant de la
            permission <code className="rounded bg-ink/10 px-1.5 py-0.5 font-mono text-[11px]">users.manage</code>.
          </div>
        </div>

        {/* Forms */}
        <AccountForm initial={{ name: user.name, email: user.email }} />
      </div>
    </>
  );
}

/* ─── Presentational bits ─────────────────────────────────────────────── */

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden
      className="inline-flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-ink text-[15px] font-black text-lime"
    >
      {initials || "?"}
    </span>
  );
}

function Fact({
  label,
  value,
  muted,
  tone
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "ok" | "warn" | "bad";
}) {
  const valueColor =
    tone === "ok"
      ? "text-ink"
      : tone === "warn"
        ? "text-amber-900"
        : tone === "bad"
          ? "text-red-800"
          : muted
            ? "text-ink/40"
            : "text-ink";
  return (
    <div className="px-6 py-4">
      <dt className="text-[10px] font-bold uppercase tracking-[0.2em] text-ink/50">
        {label}
      </dt>
      <dd className={`mt-2 truncate text-[14px] font-semibold ${valueColor}`}>
        {value}
      </dd>
    </div>
  );
}

function formatDateTime(d: Date): string {
  // en-CA gives ISO-ish yyyy-mm-dd, hh:mm — consistent regardless of locale
  const date = new Intl.DateTimeFormat("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
  const time = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
  return `${date} · ${time}`;
}

function ChevronRight() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

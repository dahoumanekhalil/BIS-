import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { getSmtpConfigView } from "@/lib/email/config";
import { SmtpForm } from "./smtp-form";

// SMTP configuration UI. Renders the server-safe view (no password
// plaintext) and delegates all mutations to the actions module.
export default async function AdminSettingsEmailPage() {
  const { user } = await requirePermission("settings.manage");
  const view = await getSmtpConfigView();

  const statusTone: "ok" | "warn" | "bad" = view.configured
    ? view.logOnly
      ? "warn"
      : "ok"
    : "bad";
  const statusLabel = view.configured
    ? view.logOnly
      ? "Log-only"
      : "Actif"
    : "Non configuré";
  const providerLabel = view.provider === "resend" ? "Resend" : "SMTP";

  return (
    <>
      <AdminHeader user={user} title="Email / SMTP" subtitle="Settings" />
      <div className="space-y-6 p-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-[11.5px] text-ink/55">
          <Link href="/admin/settings" className="font-semibold text-cobalt hover:underline">
            Paramètres
          </Link>
          <ChevronRight />
          <span className="font-semibold text-ink/70">Email</span>
        </nav>

        {/* Hero status card */}
        <section className="overflow-hidden rounded-[20px] border border-line bg-white">
          <div
            className={
              statusTone === "ok"
                ? "border-b border-line bg-gradient-to-br from-lime/25 to-lime/5 px-6 py-5"
                : statusTone === "warn"
                  ? "border-b border-line bg-gradient-to-br from-amber-100 to-amber-50 px-6 py-5"
                  : "border-b border-line bg-gradient-to-br from-red-100 to-red-50 px-6 py-5"
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <StatusDot tone={statusTone} />
                <div>
                  <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/60">
                    Configuration email
                  </p>
                  <h2 className="mt-1 text-[22px] font-black tracking-tight text-ink">
                    {statusLabel}
                    <span className="ml-3 rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-ink/70">
                      {providerLabel}
                    </span>
                  </h2>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/admin/settings/email/templates"
                  className="inline-flex items-center gap-1.5 rounded-btn border border-ink/20 bg-white px-3 py-2 text-[12.5px] font-bold text-ink hover:border-ink/40"
                >
                  <IconTemplate />
                  Modèles
                </Link>
                <a
                  href="#form"
                  className="inline-flex items-center gap-1.5 rounded-btn bg-ink px-3 py-2 text-[12.5px] font-bold text-lime"
                >
                  <IconSettings />
                  {view.configured ? "Modifier" : "Configurer"}
                </a>
              </div>
            </div>
          </div>

          {/* Facts grid */}
          <dl className="grid grid-cols-2 divide-x divide-y divide-line md:grid-cols-4">
            <Fact label="Expéditeur" value={view.fromEmail || "—"} secondary={view.fromName} />
            <Fact
              label="Destinataire contact"
              value={view.contactRecipient || "—"}
              muted={!view.contactRecipient}
            />
            <Fact
              label="Mode d'envoi"
              value={
                view.mode === "live" ? "Live" : view.mode === "log-only" ? "Log-only" : "OFF"
              }
              tone={
                view.mode === "live" ? "ok" : view.mode === "log-only" ? "warn" : "bad"
              }
            />
            <Fact
              label={view.provider === "resend" ? "Clé API Resend" : "Mot de passe SMTP"}
              value={
                view.provider === "resend"
                  ? view.resendApiKeySet
                    ? "Configurée"
                    : "Non définie"
                  : view.passwordSet
                    ? "Configuré"
                    : "Non défini"
              }
              secondary={
                view.provider === "resend"
                  ? view.resendApiKeyFingerprint ?? undefined
                  : view.passwordFingerprint ?? undefined
              }
              tone={
                (view.provider === "resend" ? view.resendApiKeySet : view.passwordSet)
                  ? "ok"
                  : "bad"
              }
              mono
            />
          </dl>

          {/* Advanced facts row */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line bg-frost/40 px-6 py-3 text-[11.5px] text-ink/60">
            {view.provider === "smtp" && view.host && (
              <FactInline label="Host" value={`${view.host}:${view.port}`} mono />
            )}
            {view.provider === "smtp" && (
              <FactInline label="Chiffrement" value={view.encryption.toUpperCase()} />
            )}
            <FactInline label="Source" value={view.source} mono />
            <FactInline
              label="Reply-To"
              value={view.replyTo ?? "—"}
              muted={!view.replyTo}
              mono
            />
            <FactInline
              label="Tentatives max"
              value={String(view.maxAttempts)}
            />
            {view.allowlistDomains.length > 0 && (
              <FactInline
                label="Allowlist (dev)"
                value={view.allowlistDomains.join(", ")}
                mono
              />
            )}
          </div>
        </section>

        {/* Notes / conseils */}
        {view.logOnly && (
          <Callout tone="warn" icon={<IconWarn />}>
            <strong>Mode log-only actif.</strong> Les emails sont rendus et
            stockés dans la file mais aucun envoi réel n'est effectué. Passez
            en mode « Live » ci-dessous pour envoyer via le fournisseur
            configuré (avec allowlist en développement).
          </Callout>
        )}
        {!view.configured && (
          <Callout tone="bad" icon={<IconWarn />}>
            <strong>Configuration incomplète.</strong>{" "}
            {view.provider === "resend"
              ? "Renseignez la clé API Resend et l'adresse d'expéditeur ci-dessous."
              : "Renseignez l'hôte SMTP et l'adresse d'expéditeur ci-dessous."}
          </Callout>
        )}
        <Callout tone="info" icon={<IconInfo />}>
          Les variables d'environnement (préfixe <code className="rounded bg-ink/10 px-1.5 py-0.5 text-[11px] font-mono">SMTP_</code>{" "}
          / <code className="rounded bg-ink/10 px-1.5 py-0.5 text-[11px] font-mono">RESEND_</code>{" "}
          / <code className="rounded bg-ink/10 px-1.5 py-0.5 text-[11px] font-mono">EMAIL_PROVIDER</code>)
          ont priorité sur la configuration enregistrée. Le mot de passe et la
          clé API sont chiffrés au repos (AES-256-GCM). La console n'affiche
          jamais les valeurs stockées.
        </Callout>

        {/* Form */}
        <section id="form">
          <SmtpForm initial={view} />
        </section>
      </div>
    </>
  );
}

/* ─── Presentational bits ─────────────────────────────────────────────── */

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" }) {
  const cls =
    tone === "ok"
      ? "bg-lime shadow-[0_0_0_6px_rgba(184,230,46,0.25)]"
      : tone === "warn"
        ? "bg-amber-500 shadow-[0_0_0_6px_rgba(245,158,11,0.25)]"
        : "bg-red-500 shadow-[0_0_0_6px_rgba(239,68,68,0.25)]";
  return (
    <span
      aria-hidden
      className={`inline-block h-3 w-3 flex-shrink-0 rounded-full ${cls}`}
    />
  );
}

function Fact({
  label,
  value,
  secondary,
  muted,
  tone,
  mono
}: {
  label: string;
  value: string;
  secondary?: string;
  muted?: boolean;
  tone?: "ok" | "warn" | "bad";
  mono?: boolean;
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
      <dd
        className={`mt-2 truncate text-[14px] font-semibold ${valueColor} ${
          mono ? "font-mono text-[13px]" : ""
        }`}
      >
        {value}
      </dd>
      {secondary && (
        <p className="mt-0.5 truncate text-[11px] font-mono text-ink/45">
          {secondary}
        </p>
      )}
    </div>
  );
}

function FactInline({
  label,
  value,
  muted,
  mono
}: {
  label: string;
  value: string;
  muted?: boolean;
  mono?: boolean;
}) {
  return (
    <span>
      <span className="font-bold uppercase tracking-[0.14em] text-ink/45">
        {label}
      </span>
      <span
        className={`ml-2 ${muted ? "text-ink/40" : "text-ink/80"} ${
          mono ? "font-mono" : "font-semibold"
        }`}
      >
        {value}
      </span>
    </span>
  );
}

function Callout({
  tone,
  icon,
  children
}: {
  tone: "info" | "warn" | "bad";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls =
    tone === "info"
      ? "border-cobalt/20 bg-cobalt/5 text-ink/80"
      : tone === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : "border-red-300 bg-red-50 text-red-900";
  const iconCls =
    tone === "info"
      ? "text-cobalt"
      : tone === "warn"
        ? "text-amber-700"
        : "text-red-700";
  return (
    <div
      className={`flex items-start gap-3 rounded-[14px] border px-4 py-3 text-[12.5px] leading-relaxed ${cls}`}
    >
      <span className={`mt-0.5 flex-shrink-0 ${iconCls}`}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

/* ─── Icons ────────────────────────────────────────────────────────────── */

function ChevronRight() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.4 1.8l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.8-.4 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.2a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.4l-.1.1a2 2 0 01-2.9-2.9l.1-.1a1.7 1.7 0 00.4-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.2a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.4-1.8l-.1-.1a2 2 0 012.9-2.9l.1.1a1.7 1.7 0 001.8.4H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.2a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.4l.1-.1a2 2 0 012.9 2.9l-.1.1a1.7 1.7 0 00-.4 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.2a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}
function IconTemplate() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  );
}
function IconWarn() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconInfo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

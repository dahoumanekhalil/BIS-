import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { listTemplates } from "@/lib/email/templates/service";
import { getEmailBranding } from "@/lib/email/templates/branding";
import { BrandingForm } from "./branding-form";
import { TemplatesList } from "./templates-list";

// Templates dashboard. Requires `settings.email.templates` to see the
// full page (branding form is inside the same permission).
export default async function EmailTemplatesPage() {
  const { user } = await requirePermission("settings.email.templates");
  const [rows, branding] = await Promise.all([
    listTemplates(),
    getEmailBranding()
  ]);

  const stats = {
    total: rows.length,
    active: rows.filter((r) => r.isActive).length,
    overrides: rows.filter((r) => r.source === "db").length,
    system: rows.filter((r) => r.isSystem).length
  };

  return (
    <>
      <AdminHeader
        user={user}
        title="Modèles d'email"
        subtitle="Settings / Email / Templates"
      />
      <div className="space-y-6 p-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-[11.5px] text-ink/55">
          <Link href="/admin/settings" className="font-semibold text-cobalt hover:underline">
            Paramètres
          </Link>
          <ChevronRight />
          <Link href="/admin/settings/email" className="font-semibold text-cobalt hover:underline">
            Email
          </Link>
          <ChevronRight />
          <span className="font-semibold text-ink/70">Modèles</span>
        </nav>

        {/* Hero */}
        <section className="overflow-hidden rounded-[20px] border border-line bg-white">
          <div className="border-b border-line bg-gradient-to-br from-cobalt/10 via-lime/5 to-white px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
                  Bibliothèque de modèles
                </p>
                <h2 className="mt-1 text-[22px] font-black tracking-tight text-ink">
                  Créez, éditez et prévisualisez vos emails
                </h2>
                <p className="mt-2 text-[13px] leading-relaxed text-ink/65">
                  Les modèles activés remplacent les modèles système au moment
                  de l'envoi. Désactiver un modèle rétablit automatiquement le
                  fallback code — jamais d'email vide.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/admin/settings/email"
                  className="inline-flex items-center gap-1.5 rounded-btn border border-ink/20 bg-white px-3 py-2 text-[12.5px] font-bold text-ink hover:border-ink/40"
                >
                  <IconMail />
                  SMTP / Resend
                </Link>
                <Link
                  href="/admin/settings/email/templates/new"
                  className="inline-flex items-center gap-1.5 rounded-btn bg-ink px-3 py-2 text-[12.5px] font-bold text-lime shadow-sm"
                >
                  <IconPlus />
                  Nouveau modèle
                </Link>
              </div>
            </div>
          </div>

          {/* Stat strip */}
          <dl className="grid grid-cols-2 divide-x divide-y divide-line md:grid-cols-4">
            <Stat label="Modèles totaux" value={stats.total} />
            <Stat label="Actifs" value={stats.active} tone="ok" />
            <Stat label="Personnalisés (DB)" value={stats.overrides} tone="brand" />
            <Stat label="Système" value={stats.system} />
          </dl>
        </section>

        {/* Templates list */}
        <TemplatesList rows={rows} />

        {/* Branding */}
        <section
          id="branding"
          className="overflow-hidden rounded-[20px] border border-line bg-white"
        >
          <div className="border-b border-line bg-gradient-to-br from-ink/5 to-white px-6 py-4">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-cobalt/10 text-cobalt">
                <IconBrand />
              </span>
              <div>
                <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
                  Branding email
                </p>
                <p className="text-[13px] font-semibold text-ink">
                  Header et footer partagés par tous les modèles DB
                </p>
              </div>
            </div>
          </div>
          <div className="p-6">
            <BrandingForm initial={branding} />
          </div>
        </section>
      </div>
    </>
  );
}

/* ─── Presentational bits ─────────────────────────────────────────────── */

function Stat({
  label,
  value,
  tone
}: {
  label: string;
  value: number;
  tone?: "ok" | "brand";
}) {
  const valueColor =
    tone === "ok" ? "text-ink" : tone === "brand" ? "text-cobalt" : "text-ink";
  return (
    <div className="px-6 py-4">
      <dt className="text-[10px] font-bold uppercase tracking-[0.2em] text-ink/50">
        {label}
      </dt>
      <dd className={`mt-1.5 text-[26px] font-black tracking-tight ${valueColor}`}>
        {value}
      </dd>
    </div>
  );
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
function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconMail() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}
function IconBrand() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l3 6 6 .9-4.5 4.3 1 6.3L12 16.9 6.5 19.5l1-6.3L3 8.9 9 8z" />
    </svg>
  );
}

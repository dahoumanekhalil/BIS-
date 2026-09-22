import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { getSmtpConfigView } from "@/lib/email/config";

// Settings hub. Currently exposes a single sub-section (Email / SMTP);
// additional scopes (event settings, payments, i18n, retention) will land
// as sibling routes under /admin/settings/*.
export default async function AdminSettingsPage() {
  const { user } = await requirePermission("settings.manage");
  const view = await getSmtpConfigView();

  return (
    <>
      <AdminHeader user={user} title="Settings" subtitle="System" />
      <div className="p-6 space-y-6">
        <Link
          href="/admin/settings/email"
          className="block rounded-[20px] border border-line bg-white p-6 transition-shadow hover:shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]"
        >
          <div className="flex items-center gap-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
              Email · SMTP
            </p>
            <span
              className={
                view.configured
                  ? view.logOnly
                    ? "inline-flex items-center rounded-full bg-amber-100 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-amber-900"
                    : "inline-flex items-center rounded-full bg-lime/20 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink"
                  : "inline-flex items-center rounded-full bg-red-100 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-red-800"
              }
            >
              {view.configured
                ? view.logOnly
                  ? "Log-only (dev)"
                  : "Configuré"
                : "Non configuré"}
            </span>
          </div>
          <h2 className="mt-3 font-display text-2xl font-black tracking-tight text-ink">
            Configuration SMTP
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink/65">
            Fournisseur SMTP, identifiants, expéditeur, destinataire du
            formulaire de contact. Test de connexion et envoi de message de
            test disponibles depuis cette page.
          </p>
          <p className="mt-4 text-[12px] text-ink/50">
            Source de configuration :{" "}
            <span className="font-semibold text-ink/70">{view.source}</span>
          </p>
        </Link>
      </div>
    </>
  );
}

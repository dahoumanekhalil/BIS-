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

  return (
    <>
      <AdminHeader
        user={user}
        title="Email / SMTP"
        subtitle="Settings"
      />
      <div className="space-y-6 p-6">
        <div className="rounded-[20px] border border-line bg-white p-6">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
              Statut de la configuration
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
            <span className="text-[11.5px] text-ink/55">
              Provider :{" "}
              <span className="font-semibold text-ink/70">
                {view.provider === "resend" ? "Resend" : "SMTP"}
              </span>
            </span>
            <span className="text-[11.5px] text-ink/55">
              Source : <span className="font-semibold text-ink/70">{view.source}</span>
            </span>
          </div>
          <p className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-ink/65">
            Les variables d'environnement (préfixe SMTP_) ont priorité sur la
            configuration enregistrée. Le mot de passe est chiffré au repos
            (AES-256-GCM). La console n'affiche jamais le mot de passe stocké.
          </p>
          <div className="mt-4">
            <Link
              href="/admin/settings"
              className="text-[12px] font-semibold text-cobalt hover:underline"
            >
              ← Retour aux paramètres
            </Link>
          </div>
        </div>

        <SmtpForm initial={view} />
      </div>
    </>
  );
}

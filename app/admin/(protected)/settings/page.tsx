import Link from "next/link";
import { requireAdmin } from "@/lib/admin/auth";
import { canWithOverrides } from "@/lib/admin/rbac";
import { AdminHeader } from "@/components/admin/header";
import { getSmtpConfigView } from "@/lib/email/config";

// Settings hub. Sections:
//   • Compte  — self-service; visible to every authenticated admin
//   • Email · SMTP — requires `settings.manage`
// Additional scopes (event settings, payments, i18n, retention) will land
// as sibling routes under /admin/settings/*.
//
// AUTHORIZATION: the page itself only requires an authenticated admin.
// Each card decides its own visibility from the actor's permissions, so
// a Viewer sees "Compte" (their own account) but not "Email · SMTP".
// Every server action behind each card re-checks its own permission —
// hiding the card is UX, not the security boundary.
export default async function AdminSettingsPage() {
  const { user } = await requireAdmin();
  const canManageSettings = await canWithOverrides(user.role, "settings.manage");
  const view = canManageSettings ? await getSmtpConfigView() : null;

  return (
    <>
      <AdminHeader user={user} title="Settings" subtitle="System" />
      <div className="p-6 space-y-6">
        <Link
          href="/admin/settings/account"
          className="block rounded-[20px] border border-line bg-white p-6 transition-shadow hover:shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]"
        >
          <div className="flex items-center gap-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
              Compte
            </p>
            <span className="inline-flex items-center rounded-full bg-cobalt/10 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-cobalt">
              Personnel
            </span>
          </div>
          <h2 className="mt-3 font-display text-2xl font-black tracking-tight text-ink">
            Mon compte
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink/65">
            Modifier mon nom, mon adresse email et mon mot de passe.
            Consulter mon rôle, mon statut et la date de ma dernière
            connexion.
          </p>
          <p className="mt-4 text-[12px] text-ink/50">
            Connecté en tant que{" "}
            <span className="font-semibold text-ink/70">{user.email}</span>
          </p>
        </Link>

        {canManageSettings && view && (
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
        )}
      </div>
    </>
  );
}

import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { ComingSoon } from "@/components/admin/ui";

export default async function AdminSettingsPage() {
  const { user } = await requirePermission("settings.manage");
  return (
    <>
      <AdminHeader user={user} title="Settings" subtitle="System" />
      <div className="p-6">
        <ComingSoon
          title="Paramètres système"
          description="Configuration globale de la plateforme Ops : event settings, sécurité, intégrations externes, langues, notifications."
          scope={[
            "Event settings (dates, lieu, capacités)",
            "Politique de sessions & durées par défaut",
            "Fournisseur email + templates",
            "Fournisseur paiement (PSP)",
            "Langues activées (fr / ar / en) + RTL",
            "2FA obligatoire pour rôles sensibles",
            "Politique de rétention des logs d'audit"
          ]}
        />
      </div>
    </>
  );
}

import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { ComingSoon } from "@/components/admin/ui";

export default async function AdminGatesPage() {
  const { user } = await requirePermission("gates.view");
  return (
    <>
      <AdminHeader user={user} title="Gates" subtitle="Event" />
      <div className="p-6">
        <ComingSoon
          title="Gestion des portes"
          description="Le module Gates centralisera la configuration des points d'accès physiques, leur statut opérationnel et l'assignation des opérateurs. Le check-in center est déjà branché sur les codes de portes (Gate A/B/C/D) définis dans le seed."
          scope={[
            "Créer / renommer / désactiver une porte",
            "Assigner opérateurs et créneaux",
            "Statut : Ouvert · Fermé · Pause · Maintenance",
            "Trafic temps réel par porte",
            "Règles d'accès (tiers autorisés, fenêtre horaire)",
            "Capacité et alertes de saturation"
          ]}
        />
      </div>
    </>
  );
}

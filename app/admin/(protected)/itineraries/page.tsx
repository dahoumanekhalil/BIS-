import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { ComingSoon } from "@/components/admin/ui";

export default async function AdminItinerariesPage() {
  const { user } = await requirePermission("itineraries.view");
  return (
    <>
      <AdminHeader user={user} title="Itineraries" subtitle="Event" />
      <div className="p-6">
        <ComingSoon
          title="Constructeur d'itinéraires"
          description="Configurera l'itinéraire de chaque tier : sessions, portes et amenities disponibles selon l'éligibilité. L'inscrit verra son parcours généré automatiquement."
          scope={[
            "Règles d'accès par tier",
            "Composition sessions + portes + amenities",
            "Fenêtres horaires par créneau",
            "Génération automatique des itinéraires individuels",
            "Prévisualisation par tier",
            "Publication programmée"
          ]}
        />
      </div>
    </>
  );
}

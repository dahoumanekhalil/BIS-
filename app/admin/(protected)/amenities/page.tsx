import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { ComingSoon } from "@/components/admin/ui";

export default async function AdminAmenitiesPage() {
  const { user } = await requirePermission("amenities.view");
  return (
    <>
      <AdminHeader user={user} title="Amenities" subtitle="Event" />
      <div className="p-6">
        <ComingSoon
          title="Gestion des amenities"
          description="Configuration des espaces restreints du sommet : Food Area, B2B & VIP Coffee Zone, Legacy Lounges. Chaque amenity porte ses règles de tier et de paiement, appliquées côté serveur au check-in."
          scope={[
            "Food Area · règles d'accès par tier",
            "B2B & VIP Coffee Zone",
            "Legacy Lounges",
            "Statut opérationnel + capacités",
            "Utilisation temps réel",
            "Journal des accès"
          ]}
        />
      </div>
    </>
  );
}

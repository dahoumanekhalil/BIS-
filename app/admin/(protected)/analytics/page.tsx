import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { ComingSoon } from "@/components/admin/ui";

export default async function AdminAnalyticsPage() {
  const { user } = await requirePermission("analytics.view");
  return (
    <>
      <AdminHeader user={user} title="Analytics" subtitle="Reporting" />
      <div className="p-6">
        <ComingSoon
          title="Analytics & rapports"
          description="Tableau analytique complet : évolution des inscriptions, revenu par tier, trafic gate, utilisation des amenities, présence par session. Les KPIs opérationnels sont déjà disponibles sur le Dashboard."
          scope={[
            "Inscriptions cumulées dans le temps",
            "Répartition par tier / pays / statut",
            "Revenu par tier et par jour",
            "Trafic par porte (courbe temporelle)",
            "Utilisation des amenities",
            "Présence par session",
            "Export CSV / rapports planifiés"
          ]}
        />
      </div>
    </>
  );
}

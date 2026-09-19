import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { KpiCard, ComingSoon } from "@/components/admin/ui";
import { prisma } from "@/lib/db";
import { PaymentStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function AdminRevenuePage() {
  const { user } = await requirePermission("revenue.view");

  const [paid, pending, refunded, revenueAgg] = await Promise.all([
    prisma.participant.count({ where: { paymentStatus: PaymentStatus.PAID } }),
    prisma.participant.count({
      where: { paymentStatus: PaymentStatus.PENDING }
    }),
    prisma.participant.count({
      where: { paymentStatus: PaymentStatus.REFUNDED }
    }),
    prisma.participant.aggregate({
      _sum: { paymentAmount: true },
      where: { paymentStatus: PaymentStatus.PAID }
    })
  ]);

  const dzd = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "DZD",
    maximumFractionDigits: 0
  });

  return (
    <>
      <AdminHeader user={user} title="Revenue" subtitle="Business" />
      <div className="space-y-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Revenu confirmé"
            value={dzd.format(revenueAgg._sum.paymentAmount ?? 0)}
            tone="cobalt"
          />
          <KpiCard label="Paiements confirmés" value={paid} tone="lime" />
          <KpiCard label="En attente" value={pending} tone="warn" />
          <KpiCard label="Remboursés" value={refunded} tone="default" />
        </div>

        <ComingSoon
          title="Reconciliation des paiements"
          description="Le module Revenue affichera le détail des transactions, la réconciliation avec le PSP et l'export comptable. Les données financières restent restreintes au rôle Finance et Super Admin."
          scope={[
            "Table transactions (ref, montant, tier, statut)",
            "Réconciliation avec PSP",
            "Exports comptables (CSV / XLSX)",
            "Refunds workflow avec traçabilité",
            "Rapport par période et par tier",
            "Alerte échecs de paiement"
          ]}
        />
      </div>
    </>
  );
}

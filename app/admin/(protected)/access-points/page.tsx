import { requirePermission } from "@/lib/admin/auth";
import { can } from "@/lib/admin/rbac";
import { getAccessPointsWithUsage } from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { PointRow } from "./point-row";
import { CreateAccessPointForm } from "./create-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Access points" };

// Phase 8 admin surface. `access.view` gates the READ path — SUPER_ADMIN,
// ADMIN, and REGISTRATION_MANAGER can all see this list. `settings.manage`
// gates every mutation (create/rename/reorder/activate/delete) — held by
// SUPER_ADMIN + ADMIN only. REGISTRATION_MANAGER sees the list read-only.
//
// The list is loaded from the DB (never hardcoded) — Phase 5 attendee UI,
// Phase 6 access history, Phase 7 registrant matrix, and any future
// scanner route ALL resolve access points via the same
// getAccessPointsWithUsage / listAccessPoints helpers.
export default async function AccessPointsAdminPage() {
  const { user } = await requirePermission("access.view");
  const canManage = can(user.role, "settings.manage");
  const points = await getAccessPointsWithUsage();

  return (
    <>
      <AdminHeader
        user={user}
        title="Access points"
        subtitle="Configuration des points d'accès du sommet"
      />

      <div className="space-y-6 p-6">
        <section className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            À propos de cette page
          </p>
          <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-ink/65">
            Chaque point d&apos;accès est indépendant : l&apos;entrée
            principale suit les règles de l&apos;inscription (paiement,
            statut), chaque salle nécessite une autorisation individuelle
            (matrice d&apos;accès sur la fiche d&apos;un inscrit).
          </p>
          <ul className="mt-4 space-y-1 text-[12px] leading-relaxed text-ink/60">
            <li>
              • <strong>Slug</strong> : identifiant technique utilisé dans
              les URLs de scanner. Verrouillé dès qu&apos;un check-in
              référence ce point.
            </li>
            <li>
              • <strong>Type</strong> (Entrée / Salle) : figé à la création.
              Le changer inverserait la logique de validation pour tout
              historique existant.
            </li>
            <li>
              • <strong>Désactiver</strong> masque le point côté attendee
              et bloque les grants/révocations sans effacer aucun
              historique. À privilégier à la suppression.
            </li>
            <li>
              • <strong>Supprimer</strong> n&apos;est autorisé que sur un
              point sans check-in ni permission — historique protégé.
            </li>
          </ul>
        </section>

        {canManage && <CreateAccessPointForm />}

        {points.length === 0 ? (
          <EmptyState
            title="Aucun point d'accès configuré."
            hint="Créez le premier point ci-dessus."
          />
        ) : (
          <ul className="grid gap-4">
            {points.map((p) => (
              <PointRow key={p.id} point={p} canManage={canManage} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

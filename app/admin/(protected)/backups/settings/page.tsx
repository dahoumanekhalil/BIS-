import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { getScheduleAction } from "../actions";
import { ScheduleForm } from "./_ui/schedule-form";
import { ManualRetentionButton } from "../_ui/action-buttons";

export const dynamic = "force-dynamic";

export default async function BackupSettingsPage() {
  const { user } = await requirePermission("backup.settings");
  const result = await getScheduleAction();

  if (!result.ok) {
    return (
      <>
        <AdminHeader user={user} title="Paramètres" subtitle="Sauvegardes" />
        <div className="p-6">
          <div
            role="alert"
            className="rounded-card border border-red-200 bg-red-50 p-4 text-[13px] text-red-900"
          >
            <p className="font-semibold">
              Impossible de charger les paramètres.
            </p>
            <p className="mt-1">
              {result.publicMessage}
              <br />
              <span className="font-mono text-[11px]">
                Op {result.operationId}
              </span>
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeader user={user} title="Paramètres" subtitle="Sauvegardes" />
      <div className="space-y-6 p-6">
        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Planificateur
          </p>
          <p className="mt-2 text-[13px] text-ink/65">
            Configurer la fréquence des sauvegardes automatiques et la
            politique de rétention. Les modifications sont auditées.
          </p>
          <div className="mt-5">
            <ScheduleForm
              initial={{
                enabled: result.enabled,
                frequencyHours: result.frequencyHours,
                retentionCount: result.retentionCount,
                retentionAgeDays: result.retentionAgeDays
              }}
            />
          </div>
        </div>

        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Rétention manuelle
          </p>
          <p className="mt-2 text-[13px] text-ink/65">
            Lance un cycle de prune immédiat. Ne supprime jamais la dernière
            sauvegarde COMPLETED/VERIFIED ni un instantané référencé par une
            restauration en cours.
          </p>
          <div className="mt-4">
            <ManualRetentionButton />
          </div>
        </div>

        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Cron externe
          </p>
          <p className="mt-2 text-[13px] text-ink/65">
            Le planificateur est déclenché par un cron externe qui POST sur{" "}
            <code className="font-mono text-[12px]">/api/internal/backup/tick</code>{" "}
            avec l&apos;en-tête{" "}
            <code className="font-mono text-[12px]">x-internal-secret</code>{" "}
            (défini via <code className="font-mono text-[12px]">INTERNAL_BACKUP_TICK_SECRET</code>).
            La comparaison est en temps constant côté serveur.
          </p>
        </div>
      </div>
    </>
  );
}

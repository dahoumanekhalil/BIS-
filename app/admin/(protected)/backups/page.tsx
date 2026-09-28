import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { KpiCard, EmptyState } from "@/components/admin/ui";
import { prisma } from "@/lib/db";
import { canWithOverrides } from "@/lib/admin/rbac";
import { backupConfigStatus } from "@/lib/backup/config";
import { CreateBackupButton, ManualTickButton } from "./_ui/action-buttons";

// Server-rendered dashboard. Every fetch is done inline here — no client-side
// state ownership of authorization decisions. The client-component islands
// under `./_ui/` only run server actions (already authz'd by requirePermission).

export const dynamic = "force-dynamic";

export default async function BackupsDashboardPage() {
  const { user } = await requirePermission("backup.view");
  const canCreate = await canWithOverrides(user.role, "backup.create");
  const canSettings = await canWithOverrides(user.role, "backup.settings");
  const canRestore = await canWithOverrides(user.role, "backup.restore");

  const config = backupConfigStatus();

  const [
    schedule,
    lastCompleted,
    lastVerified,
    activeBackupRow,
    activeRestoreRow,
    totalCount,
    verifiedCount,
    failedCount
  ] = await Promise.all([
    prisma.backupSchedule.upsert({
      where: { id: "singleton" },
      create: { id: "singleton" },
      update: {},
      select: {
        enabled: true,
        frequencyHours: true,
        retentionCount: true,
        retentionAgeDays: true,
        lastRunAt: true,
        lastRunOutcome: true,
        lastRunBackupId: true,
        lastRunError: true
      }
    }),
    prisma.backup.findFirst({
      where: { status: { in: ["COMPLETED", "VERIFIED"] } },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        kind: true,
        sizeBytes: true
      }
    }),
    prisma.backup.findFirst({
      where: { status: "VERIFIED" },
      orderBy: { verifiedAt: "desc" },
      select: { id: true, verifiedAt: true }
    }),
    prisma.backup.findFirst({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true, status: true, kind: true, startedAt: true }
    }),
    prisma.restoreOperation.findFirst({
      where: { status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] } },
      select: { id: true, status: true, startedAt: true }
    }),
    prisma.backup.count(),
    prisma.backup.count({ where: { status: "VERIFIED" } }),
    prisma.backup.count({ where: { status: "FAILED" } })
  ]);

  const health = deriveHealth({
    config,
    lastCompletedAt: lastCompleted?.startedAt ?? null,
    scheduleEnabled: schedule.enabled,
    frequencyHours: schedule.frequencyHours,
    lastRunOutcome: schedule.lastRunOutcome
  });

  const nextRun = deriveNextRun(schedule);

  return (
    <>
      <AdminHeader user={user} title="Sauvegardes" subtitle="Backup & Restore" />

      <div className="space-y-8 p-6">
        {/* Configuration health strip — never shows keys / paths */}
        <section
          role="region"
          aria-label="Configuration"
          className="rounded-card border border-line bg-white p-4"
        >
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Configuration
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            <ConfigChip
              label="Clé de chiffrement"
              state={config.encryptionKey}
            />
            <ConfigChip label="Répertoire de stockage" state={config.storageDir} />
            <ConfigChip label="Secret du planificateur" state={config.tickSecret} />
          </ul>
        </section>

        {/* KPIs */}
        <section>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Aperçu
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Santé"
              value={health.label}
              hint={health.hint}
              tone={
                health.severity === "ok"
                  ? "lime"
                  : health.severity === "warn"
                    ? "warn"
                    : "cobalt"
              }
            />
            <KpiCard
              label="Sauvegardes totales"
              value={totalCount.toLocaleString("fr-FR")}
              hint={`${verifiedCount} vérifiées · ${failedCount} en échec`}
              tone="cobalt"
              href="/admin/backups/history"
            />
            <KpiCard
              label="Dernière réussie"
              value={lastCompleted ? relativeTime(lastCompleted.startedAt) : "—"}
              hint={
                lastCompleted
                  ? `${lastCompleted.kind} · ${formatSize(lastCompleted.sizeBytes)}`
                  : "Aucune sauvegarde encore"
              }
              tone="lime"
              href={lastCompleted ? `/admin/backups/${lastCompleted.id}` : undefined}
            />
            <KpiCard
              label="Prochaine planifiée"
              value={nextRun.label}
              hint={
                schedule.enabled
                  ? `Toutes les ${schedule.frequencyHours}h`
                  : "Planificateur désactivé"
              }
              tone={schedule.enabled ? "cobalt" : "warn"}
              href={canSettings ? "/admin/backups/settings" : undefined}
            />
          </div>
        </section>

        {/* Active ops banner */}
        {(activeBackupRow || activeRestoreRow) && (
          <section
            role="status"
            aria-live="polite"
            className="rounded-card border border-cobalt/40 bg-cobalt/[0.04] p-4"
          >
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
              Opération en cours
            </p>
            {activeBackupRow && (
              <p className="mt-2 text-[13px] text-ink">
                Sauvegarde <span className="font-mono text-ink/70">{activeBackupRow.id.slice(0, 8)}…</span> — {activeBackupRow.status} · démarrée {relativeTime(activeBackupRow.startedAt)}
              </p>
            )}
            {activeRestoreRow && (
              <p className="mt-2 text-[13px] text-ink">
                Restauration <span className="font-mono text-ink/70">{activeRestoreRow.id.slice(0, 8)}…</span> — {activeRestoreRow.status} · démarrée {relativeTime(activeRestoreRow.startedAt)}
              </p>
            )}
          </section>
        )}

        {/* Actions row */}
        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Sauvegarde manuelle
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/65">
              Créer immédiatement une nouvelle sauvegarde chiffrée. Utile avant une opération sensible ou pour tester la chaîne complète.
            </p>
            <div className="mt-4">
              {canCreate ? (
                <CreateBackupButton />
              ) : (
                <p className="text-[12px] text-ink/50">
                  Permission requise : <code>backup.create</code>.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Exécuter le planificateur
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/65">
              Lancer manuellement une itération du planificateur (dump + vérification + prune). Respecte les protections de concurrence.
            </p>
            <div className="mt-4">
              {canCreate ? (
                <ManualTickButton />
              ) : (
                <p className="text-[12px] text-ink/50">
                  Permission requise : <code>backup.create</code>.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Restaurer une sauvegarde
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/65">
              Remplace le contenu de la base par un instantané. Nécessite une confirmation stricte et une ré-authentification.
            </p>
            <div className="mt-4">
              {canRestore ? (
                <Link
                  href="/admin/backups/restore"
                  className="inline-flex items-center rounded-btn bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-ink/85"
                >
                  Ouvrir l&apos;assistant de restauration →
                </Link>
              ) : (
                <p className="text-[12px] text-ink/50">
                  Permission requise : <code>backup.restore</code>.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* Scheduler & retention snapshot */}
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Planificateur
            </p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-ink/55">État</dt>
              <dd className="font-semibold">
                {schedule.enabled ? "Activé" : "Désactivé"}
              </dd>
              <dt className="text-ink/55">Fréquence</dt>
              <dd>Toutes les {schedule.frequencyHours}h</dd>
              <dt className="text-ink/55">Dernière exécution</dt>
              <dd>
                {schedule.lastRunAt
                  ? relativeTime(schedule.lastRunAt)
                  : "Jamais"}
              </dd>
              <dt className="text-ink/55">Résultat</dt>
              <dd>{schedule.lastRunOutcome ?? "—"}</dd>
              <dt className="text-ink/55">Dernière erreur</dt>
              <dd className="font-mono text-[12px] text-ink/70">
                {schedule.lastRunError ?? "—"}
              </dd>
            </dl>
          </div>

          <div className="rounded-card border border-line bg-white p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Rétention
            </p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-ink/55">Nombre conservé</dt>
              <dd>{schedule.retentionCount}</dd>
              <dt className="text-ink/55">Âge maximum</dt>
              <dd>
                {schedule.retentionAgeDays === 0
                  ? "Illimité"
                  : `${schedule.retentionAgeDays} jours`}
              </dd>
              <dt className="text-ink/55">Dernière sauvegarde vérifiée</dt>
              <dd>
                {lastVerified?.verifiedAt
                  ? relativeTime(lastVerified.verifiedAt)
                  : "—"}
              </dd>
            </dl>
            {canSettings && (
              <div className="mt-5">
                <Link
                  href="/admin/backups/settings"
                  className="text-[12.5px] font-semibold text-cobalt hover:underline"
                >
                  Configurer →
                </Link>
              </div>
            )}
          </div>
        </section>

        {!lastCompleted && (
          <EmptyState
            title="Aucune sauvegarde encore."
            hint="Créez une première sauvegarde manuelle pour tester la chaîne de vérification, puis activez le planificateur."
          />
        )}
      </div>
    </>
  );
}

// ─── Helpers (kept inline; not reused elsewhere) ───────────────────────────

function deriveHealth(input: {
  config: ReturnType<typeof backupConfigStatus>;
  lastCompletedAt: Date | null;
  scheduleEnabled: boolean;
  frequencyHours: number;
  lastRunOutcome: string | null;
}): { label: string; hint: string; severity: "ok" | "warn" | "info" } {
  const anyConfigMissing =
    input.config.encryptionKey !== "OK" ||
    input.config.storageDir !== "OK" ||
    input.config.tickSecret !== "OK";
  if (anyConfigMissing) {
    return {
      label: "Config",
      hint: "Une variable requise manque ou est mal formée.",
      severity: "warn"
    };
  }
  if (!input.lastCompletedAt) {
    return {
      label: "Init",
      hint: "Aucune sauvegarde encore produite.",
      severity: "info"
    };
  }
  const ageMs = Date.now() - input.lastCompletedAt.getTime();
  const staleMs = 2 * input.frequencyHours * 60 * 60 * 1000; // 2x frequency
  if (input.scheduleEnabled && ageMs > staleMs) {
    return {
      label: "Retardée",
      hint: "La dernière sauvegarde est plus ancienne que la fréquence prévue.",
      severity: "warn"
    };
  }
  if (
    input.lastRunOutcome &&
    input.lastRunOutcome.startsWith("FAILED_")
  ) {
    return {
      label: "Échec",
      hint: `Dernier tick : ${input.lastRunOutcome}.`,
      severity: "warn"
    };
  }
  return { label: "OK", hint: "Sauvegarde récente et vérifiable.", severity: "ok" };
}

function deriveNextRun(schedule: {
  enabled: boolean;
  frequencyHours: number;
  lastRunAt: Date | null;
}): { label: string } {
  if (!schedule.enabled) return { label: "—" };
  if (!schedule.lastRunAt) return { label: "Bientôt" };
  const nextMs =
    schedule.lastRunAt.getTime() + schedule.frequencyHours * 60 * 60 * 1000;
  const nextDate = new Date(nextMs);
  if (nextMs <= Date.now()) return { label: "Due" };
  return { label: relativeTime(nextDate) };
}

function relativeTime(when: Date): string {
  const diffMs = Date.now() - when.getTime();
  const abs = Math.abs(diffMs);
  const past = diffMs > 0;
  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (abs < min) return past ? "à l'instant" : "dans quelques secondes";
  if (abs < hr) return rtf.format(past ? -Math.round(abs / min) : Math.round(abs / min), "minute");
  if (abs < day) return rtf.format(past ? -Math.round(abs / hr) : Math.round(abs / hr), "hour");
  return rtf.format(past ? -Math.round(abs / day) : Math.round(abs / day), "day");
}

function formatSize(bytes: bigint | null): string {
  if (bytes === null) return "—";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function ConfigChip({
  label,
  state
}: {
  label: string;
  state: string;
}) {
  const ok = state === "OK";
  return (
    <li
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11.5px] font-semibold ${
        ok ? "bg-lime/25 text-ink" : "bg-amber-100 text-amber-900"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          ok ? "bg-ink" : "bg-amber-500"
        }`}
      />
      {label} · {state}
    </li>
  );
}

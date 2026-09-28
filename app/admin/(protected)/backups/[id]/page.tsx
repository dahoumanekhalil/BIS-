import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { canWithOverrides } from "@/lib/admin/rbac";
import { AdminHeader } from "@/components/admin/header";
import { getBackupAction } from "../actions";
import {
  VerifyBackupButton,
  DeleteBackupButton
} from "../_ui/action-buttons";

export const dynamic = "force-dynamic";

const CUID_RE = /^c[a-z0-9]{24}$/;

export default async function BackupDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePermission("backup.view");
  const { id } = await params;

  // Local shape validation before hitting the server action. The service
  // re-validates too — this is defense in depth + a nicer 404 UX.
  if (!CUID_RE.test(id)) notFound();

  const [canVerify, canDelete, result] = await Promise.all([
    canWithOverrides(user.role, "backup.verify"),
    canWithOverrides(user.role, "backup.delete"),
    getBackupAction(id)
  ]);

  if (!result.ok) {
    if (result.code === "NOT_FOUND") notFound();
    return (
      <>
        <AdminHeader user={user} title="Détail" subtitle="Sauvegardes" />
        <div className="p-6">
          <div
            role="alert"
            className="rounded-card border border-red-200 bg-red-50 p-4 text-[13px] text-red-900"
          >
            <p className="font-semibold">Impossible de charger la sauvegarde.</p>
            <p className="mt-1">
              {result.publicMessage}
              <br />
              <span className="font-mono text-[11px]">Op {result.operationId}</span>
            </p>
          </div>
        </div>
      </>
    );
  }

  const rowCountsList = result.rowCounts
    ? Object.entries(result.rowCounts).sort((a, b) => a[0].localeCompare(b[0]))
    : null;
  const totalRows = rowCountsList
    ? rowCountsList.reduce((acc, [, n]) => acc + n, 0)
    : null;

  return (
    <>
      <AdminHeader
        user={user}
        title={`Sauvegarde ${id.slice(0, 8)}…`}
        subtitle="Sauvegardes"
      />

      <div className="space-y-6 p-6">
        <p className="text-[11.5px]">
          <Link
            href="/admin/backups/history"
            className="font-semibold text-cobalt hover:underline"
          >
            ← Retour à l&apos;historique
          </Link>
        </p>

        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetaCard label="Statut" value={result.status} />
          <MetaCard label="Type" value={result.kind} />
          <MetaCard label="Version App" value={result.appVersion} />
          <MetaCard
            label="Chiffrement"
            value={`${result.encryptionVersion} · format v${result.formatVersion}`}
          />
          <MetaCard
            label="Démarrée"
            value={new Intl.DateTimeFormat("fr-FR", {
              dateStyle: "medium",
              timeStyle: "short"
            }).format(new Date(result.startedAt))}
          />
          <MetaCard
            label="Terminée"
            value={
              result.completedAt
                ? new Intl.DateTimeFormat("fr-FR", {
                    dateStyle: "medium",
                    timeStyle: "short"
                  }).format(new Date(result.completedAt))
                : "—"
            }
          />
          <MetaCard label="Taille" value={formatSize(result.sizeBytes)} />
          <MetaCard
            label="Vérification"
            value={
              result.verifiedAt
                ? `${result.verifyResult ?? "—"} · ${new Intl.DateTimeFormat("fr-FR", {
                    dateStyle: "short",
                    timeStyle: "short"
                  }).format(new Date(result.verifiedAt))}`
                : "—"
            }
          />
        </section>

        <section className="flex flex-wrap gap-2">
          {canVerify && <VerifyBackupButton backupId={id} />}
          {canDelete && result.status !== "PENDING" && result.status !== "RUNNING" && (
            <DeleteBackupButton backupId={id} />
          )}
        </section>

        {rowCountsList && (
          <section className="rounded-card border border-line bg-white p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
                Contenu par modèle
              </p>
              <p className="text-[11.5px] text-ink/60 tabular-nums">
                Total : {totalRows?.toLocaleString("fr-FR")} lignes ·{" "}
                {rowCountsList.length} modèles
              </p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
              {rowCountsList.map(([model, count]) => (
                <div
                  key={model}
                  className="flex items-baseline justify-between text-[12.5px]"
                >
                  <span className="truncate text-ink/70">{model}</span>
                  <span className="ml-3 tabular-nums text-ink">
                    {count.toLocaleString("fr-FR")}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-white p-4">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        {label}
      </p>
      <p className="mt-2 font-mono text-[13.5px] font-semibold text-ink break-words">
        {value}
      </p>
    </div>
  );
}

function formatSize(size: string | null): string {
  if (!size) return "—";
  const n = Number(size);
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

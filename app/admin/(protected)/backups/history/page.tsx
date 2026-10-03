import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { canWithOverrides } from "@/lib/admin/rbac";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import { listBackupsAction } from "../actions";
import {
  failureLabel,
  loadReplicationsForBackups,
  verifyLabel
} from "../replication/query";
import type { PublicReplicationView } from "@/lib/backup/replication/serializer";
import { z } from "zod";

export const dynamic = "force-dynamic";

// Zod-validated query params. All are optional; unknown values fall back
// to defaults. Never pass a raw query string to the service.
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  status: z
    .enum([
      "PENDING",
      "RUNNING",
      "COMPLETED",
      "VERIFIED",
      "FAILED",
      "DELETED",
      "MISSING"
    ])
    .optional()
});
const PAGE_SIZE = 25;

export default async function BackupsHistoryPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requirePermission("backup.view");
  const sp = await searchParams;
  const q = querySchema.safeParse({
    page: sp.page,
    status: typeof sp.status === "string" ? sp.status : undefined
  });
  const page = q.success ? q.data.page : 1;
  const status = q.success ? q.data.status : undefined;
  const offset = (page - 1) * PAGE_SIZE;

  const result = await listBackupsAction({
    limit: PAGE_SIZE,
    offset,
    status
  });

  if (!result.ok) {
    return (
      <>
        <AdminHeader user={user} title="Historique" subtitle="Sauvegardes" />
        <div className="p-6">
          <div
            role="alert"
            className="rounded-card border border-red-200 bg-red-50 p-4 text-[13px] text-red-900"
          >
            <p className="font-semibold">Impossible de charger l&apos;historique.</p>
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

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  // Google Drive replication state per row (§P.4). Loaded through the
  // browser-safe serializer — no sessionUri / bytesSent leaks. Absent
  // rows fall through to a neutral "—" cell.
  const canViewReplication = await canWithOverrides(
    user.role,
    "backup.replication.view"
  );
  const replicationRows = canViewReplication
    ? await loadReplicationsForBackups(result.items.map((r) => r.id))
    : new Map<string, PublicReplicationView>();

  return (
    <>
      <AdminHeader user={user} title="Historique des sauvegardes" subtitle="Sauvegardes" />

      <div className="space-y-6 p-6">
        {/* Filter chips */}
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip href="/admin/backups/history" active={!status} label="Toutes" />
          {[
            "COMPLETED",
            "VERIFIED",
            "FAILED",
            "PENDING",
            "RUNNING",
            "DELETED",
            "MISSING"
          ].map((s) => (
            <FilterChip
              key={s}
              href={`/admin/backups/history?status=${s}`}
              active={status === s}
              label={s}
            />
          ))}
        </div>

        {result.items.length === 0 ? (
          <EmptyState title="Aucune sauvegarde à afficher." />
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-white">
            <table className="w-full table-fixed text-left text-[12.5px]">
              <thead className="border-b border-line bg-ink/[0.02]">
                <tr>
                  <th className="w-[22%] px-4 py-3 font-semibold text-ink/60">ID</th>
                  <th className="w-[10%] px-4 py-3 font-semibold text-ink/60">Statut local</th>
                  <th className="w-[9%] px-4 py-3 font-semibold text-ink/60">Type</th>
                  <th className="w-[15%] px-4 py-3 font-semibold text-ink/60">Démarrée</th>
                  <th className="w-[9%] px-4 py-3 font-semibold text-ink/60">Taille</th>
                  <th className="w-[10%] px-4 py-3 font-semibold text-ink/60">Vérification</th>
                  {canViewReplication && (
                    <th className="w-[16%] px-4 py-3 font-semibold text-ink/60">Google Drive</th>
                  )}
                  <th className="w-[9%] px-4 py-3 font-semibold text-ink/60">App</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0 hover:bg-ink/[0.02]">
                    <td className="px-4 py-3 font-mono text-[11.5px] text-ink/85">
                      <Link
                        href={`/admin/backups/${row.id}`}
                        className="hover:underline"
                      >
                        {row.id.slice(0, 12)}…
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-ink/75">{row.kind}</td>
                    <td className="px-4 py-3 text-ink/75 tabular-nums">
                      {new Intl.DateTimeFormat("fr-FR", {
                        dateStyle: "short",
                        timeStyle: "short"
                      }).format(new Date(row.startedAt))}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink/75">
                      {formatSize(row.sizeBytes)}
                    </td>
                    <td className="px-4 py-3">
                      {row.verifyResult ? (
                        <span className="font-mono text-[11px]">{row.verifyResult}</span>
                      ) : (
                        <span className="text-ink/40">—</span>
                      )}
                    </td>
                    {canViewReplication && (
                      <td className="px-4 py-3">
                        <RemotePill row={replicationRows.get(row.id)} />
                      </td>
                    )}
                    <td className="px-4 py-3 text-ink/60">{row.appVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {result.total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-[12px] text-ink/60">
            <p>
              {result.total.toLocaleString("fr-FR")} sauvegardes · page {page}/{totalPages}
            </p>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={`/admin/backups/history?page=${page - 1}${status ? `&status=${status}` : ""}`}
                  className="rounded-btn border border-line bg-white px-3 py-1.5 font-semibold text-ink hover:border-ink/30"
                >
                  ← Précédent
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={`/admin/backups/history?page=${page + 1}${status ? `&status=${status}` : ""}`}
                  className="rounded-btn border border-line bg-white px-3 py-1.5 font-semibold text-ink hover:border-ink/30"
                >
                  Suivant →
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors ${
        active ? "bg-ink text-white" : "bg-ink/[0.05] text-ink/70 hover:bg-ink/[0.1]"
      }`}
    >
      {label}
    </Link>
  );
}

function RemotePill({ row }: { row: PublicReplicationView | undefined }) {
  // §P.4 honesty: the Google Drive column reflects REMOTE state ONLY.
  // A red remote pill NEVER implies the local Backup is failed. When no
  // replication row exists yet, render "—" (either Drive is disabled
  // for this env, or the worker has not picked up the enqueue yet).
  if (!row) return <span className="text-ink/40">—</span>;
  const s = row.status.toUpperCase();
  const failure = failureLabel(row);
  const style =
    row.errorCode !== "NONE"
      ? "bg-red-100 text-red-900"
      : s === "COMPLETED"
        ? "bg-lime/25 text-ink"
        : s === "FAILED"
          ? "bg-red-100 text-red-900"
          : s === "RETRYABLE_FAILURE"
            ? "bg-amber-100 text-amber-900"
            : s === "UPLOADING" || s === "VERIFYING" || s === "PENDING"
              ? "bg-cobalt/15 text-cobalt-700"
              : "bg-ink/10 text-ink/70";
  const label = row.errorCode !== "NONE" ? `${s} · ${row.errorCode}` : s;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] ${style}`}
      title={failure ?? verifyLabel(row)}
    >
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  const style =
    s === "VERIFIED" || s === "COMPLETED"
      ? "bg-lime/25 text-ink"
      : s === "FAILED"
        ? "bg-red-100 text-red-900"
        : s === "RUNNING" || s === "PENDING"
          ? "bg-cobalt/15 text-cobalt-700"
          : "bg-ink/10 text-ink/70";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] ${style}`}
    >
      {s}
    </span>
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

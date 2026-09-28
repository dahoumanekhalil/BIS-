import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { prisma } from "@/lib/db";
import { RestoreWizard } from "./_ui/wizard";

export const dynamic = "force-dynamic";

// The restore wizard's server side does the heavy lifting: it fetches a
// short list of restorable backups (COMPLETED or VERIFIED) and passes
// only safe metadata to the client. The client-side wizard collects the
// confirmation phrase + password, and posts them via the pre-existing
// `restoreBackupAction`. The server re-checks EVERY security requirement.

export default async function RestorePage() {
  const { user } = await requirePermission("backup.restore");

  const restorable = await prisma.backup.findMany({
    where: { status: { in: ["VERIFIED", "COMPLETED"] } },
    orderBy: { startedAt: "desc" },
    take: 25,
    select: {
      id: true,
      status: true,
      kind: true,
      startedAt: true,
      sizeBytes: true,
      appVersion: true
      // NEVER select: fileName, contentSha256, manifestSha256, schemaSha256,
      // rowCounts, errorMessage. Detail page shows more; wizard just needs
      // enough for the operator to pick a snapshot.
    }
  });

  const activeRestore = await prisma.restoreOperation.findFirst({
    where: { status: { in: ["INITIATED", "PREFLIGHT", "RUNNING"] } },
    select: {
      id: true,
      status: true,
      backupId: true,
      startedAt: true
    }
  });

  return (
    <>
      <AdminHeader
        user={user}
        title="Restaurer une sauvegarde"
        subtitle="Sauvegardes"
      />
      <div className="space-y-6 p-6">
        <div
          role="alert"
          className="rounded-card border border-amber-300 bg-amber-50 p-4 text-[13px] text-amber-900"
        >
          <p className="font-semibold">Opération destructive.</p>
          <p className="mt-1 leading-relaxed">
            La restauration <strong>remplace</strong> tout le contenu de la base
            par un instantané. Une sauvegarde de sécurité est créée
            automatiquement avant l&apos;application. Toutes les sessions
            administratives et utilisateur sont invalidées immédiatement.
          </p>
        </div>

        <RestoreWizard
          backups={restorable.map((b) => ({
            id: b.id,
            status: b.status,
            kind: b.kind,
            startedAt: b.startedAt.toISOString(),
            sizeBytes: b.sizeBytes?.toString() ?? null,
            appVersion: b.appVersion
          }))}
          activeRestore={
            activeRestore
              ? {
                  id: activeRestore.id,
                  status: activeRestore.status,
                  backupId: activeRestore.backupId,
                  startedAt: activeRestore.startedAt.toISOString()
                }
              : null
          }
          currentUser={{
            id: user.id,
            role: user.role,
            name: user.name
          }}
        />
      </div>
    </>
  );
}

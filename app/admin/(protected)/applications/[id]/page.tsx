import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import {
  APPLICATION_TYPE_LABEL,
  type ApplicationTypeKey,
  type ApplicationStatusKey
} from "@/lib/applications";
import { StatusPill } from "../status-pill";
import { StatusForm } from "./status-form";

export const dynamic = "force-dynamic";

export default async function ApplicationDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePermission("applications.view");
  const { id } = await params;

  const app = await prisma.application.findUnique({
    where: { id },
    include: {
      event: { select: { name: true, startsAt: true, city: true } },
      participant: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          status: true,
          registrationType: true,
          tier: true,
          participationChoice: true
        }
      }
    }
  });
  if (!app) notFound();

  const type = app.type as ApplicationTypeKey;
  const status = app.status as ApplicationStatusKey;
  const details = (app.details ?? {}) as Record<string, string | undefined>;

  // Load recent related audit-log entries.
  const auditLogs = await prisma.auditLog.findMany({
    where: { entity: "Application", entityId: app.id },
    orderBy: { createdAt: "desc" },
    take: 12,
    include: { user: { select: { name: true, email: true } } }
  });

  const canManage = await import("@/lib/admin/rbac").then((m) =>
    m.canWithOverrides(user.role, "applications.manage")
  );

  return (
    <>
      <AdminHeader
        user={user}
        title={`${app.firstName} ${app.lastName}`}
        subtitle={`Candidature · ${APPLICATION_TYPE_LABEL[type]}`}
      />

      <div className="space-y-6 p-6">
        <Link
          href="/admin/applications"
          className="inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-ink/60 hover:text-ink"
        >
          <span aria-hidden>←</span> Toutes les candidatures
        </Link>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {app.participant && (
              <Card title="Inscription liée">
                <Row
                  label="Participant"
                  value={
                    <Link
                      href={`/admin/registrants/${app.participant.id}`}
                      className="text-cobalt hover:underline"
                    >
                      {app.participant.firstName} {app.participant.lastName}
                    </Link>
                  }
                />
                <Row label="Statut d'inscription" value={app.participant.status} />
                <Row label="Type" value={app.participant.registrationType} />
                {app.participant.tier && (
                  <Row label="Tier" value={app.participant.tier} />
                )}
                {app.participant.participationChoice && (
                  <Row
                    label="Choix de participation"
                    value={app.participant.participationChoice}
                  />
                )}
              </Card>
            )}
            <Card title="Contact">
              <Row label="Nom" value={`${app.firstName} ${app.lastName}`} />
              <Row label="Email" value={<a href={`mailto:${app.email}`} className="text-cobalt hover:underline">{app.email}</a>} />
              <Row label="Téléphone" value={app.phone} />
              <Row label="Pays" value={app.country} />
              {app.position && <Row label="Fonction" value={app.position} />}
            </Card>

            {(app.organization || app.website || app.industry) && (
              <Card title="Organisation">
                {app.organization && <Row label="Nom" value={app.organization} />}
                {app.industry && <Row label="Secteur" value={app.industry} />}
                {app.website && (
                  <Row
                    label="Site"
                    value={
                      <ExternalLink href={app.website}>{app.website}</ExternalLink>
                    }
                  />
                )}
                {app.linkedin && (
                  <Row
                    label="LinkedIn"
                    value={<ExternalLink href={app.linkedin}>{app.linkedin}</ExternalLink>}
                  />
                )}
                {app.logoUrl && (
                  <Row
                    label="Logo"
                    value={<ExternalLink href={app.logoUrl}>{app.logoUrl}</ExternalLink>}
                  />
                )}
                {app.photoUrl && (
                  <Row
                    label="Portrait"
                    value={<ExternalLink href={app.photoUrl}>{app.photoUrl}</ExternalLink>}
                  />
                )}
              </Card>
            )}

            <Card title="Détails de la candidature">
              {renderDetails(type, details)}
              {app.message && (
                <div className="mt-4 rounded-btn border border-line bg-frost p-4 text-[13px] leading-relaxed text-ink/80">
                  <p className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                    Message
                  </p>
                  {app.message}
                </div>
              )}
            </Card>

            {canManage && app.reviewNotes && (
              <Card title="Notes internes">
                <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink/80">
                  {app.reviewNotes}
                </p>
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <div className="rounded-card border border-line bg-white p-5">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                Statut
              </p>
              <div className="mt-3">
                <StatusPill status={status} />
              </div>
              <div className="mt-2 text-[11.5px] text-ink/50">
                Reçue le{" "}
                {app.createdAt.toLocaleDateString("fr-FR", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric"
                })}
              </div>
              {app.reviewedAt && (
                <div className="mt-1 text-[11.5px] text-ink/50">
                  Mise à jour le{" "}
                  {app.reviewedAt.toLocaleDateString("fr-FR", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric"
                  })}
                </div>
              )}
            </div>

            {canManage && (
              <StatusForm
                applicationId={app.id}
                currentStatus={status}
                currentNotes={app.reviewNotes ?? ""}
              />
            )}

            {canManage && auditLogs.length > 0 && (
              <div className="rounded-card border border-line bg-white p-5">
                <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
                  Historique
                </p>
                <ul className="mt-3 space-y-3">
                  {auditLogs.map((log) => (
                    <li key={log.id} className="text-[12.5px] text-ink/70">
                      <div className="font-semibold text-ink">{log.action}</div>
                      <div className="text-[11px] text-ink/50">
                        {log.user?.name ?? "système"} ·{" "}
                        {log.createdAt.toLocaleDateString("fr-FR", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit"
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------ SUBCOMPONENTS ------------------------------ */

function Card({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-line bg-white p-6">
      <h2 className="mb-4 text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({
  label,
  value
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/70 pb-2 last:border-b-0 last:pb-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </dt>
      <dd className="max-w-[70%] break-words text-right text-[13px] font-medium text-ink">
        {value}
      </dd>
    </div>
  );
}

function ExternalLink({
  href,
  children
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-cobalt hover:underline"
    >
      {children}
    </a>
  );
}

function renderDetails(
  type: ApplicationTypeKey,
  d: Record<string, string | undefined>
): React.ReactNode {
  const rows: { label: string; value?: string }[] = (() => {
    switch (type) {
      case "SPONSOR":
        return [
          { label: "Type d'intérêt", value: d.interest },
          { label: "Domaines", value: d.focusAreas }
        ];
      case "PARTNER":
        return [
          { label: "Type de partenariat", value: d.partnershipType },
          { label: "Proposition", value: d.proposal }
        ];
      case "SPEAKER":
        return [
          { label: "Titre professionnel", value: d.professionalTitle },
          { label: "Expertise", value: d.expertise },
          { label: "Sujet proposé", value: d.proposedTopic },
          { label: "Bio", value: d.bio },
          { label: "Proposition", value: d.proposal }
        ];
      case "CONTENT_CREATOR":
        return [
          { label: "Plateforme", value: d.platform },
          { label: "Audience", value: d.audienceSize },
          { label: "Type de contenu", value: d.contentType },
          { label: "Proposition", value: d.proposal }
        ];
    }
  })();

  return (
    <dl className="space-y-3">
      {rows
        .filter((r) => r.value && r.value.length > 0)
        .map((r) => (
          <div key={r.label}>
            <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
              {r.label}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink/85">
              {r.value}
            </dd>
          </div>
        ))}
    </dl>
  );
}

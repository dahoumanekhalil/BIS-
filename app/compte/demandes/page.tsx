import Link from "next/link";
import { requireAccount } from "@/lib/account/auth";
import { getCompteContext } from "@/lib/account/participant";
import { CompteCard, CompteRow } from "@/components/compte/card";
import { StatusPill } from "@/components/compte/status-pill";
import {
  APPLICATION_STATUS_LABEL,
  APPLICATION_STATUS_TONE,
  APPLICATION_TYPE_LABEL
} from "@/lib/account/labels";

export const metadata = { title: "Mes demandes" };

export default async function CompteDemandesPage() {
  const account = await requireAccount();
  const { participant } = await getCompteContext(account);
  const applications = participant?.applications ?? [];

  if (applications.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <CompteCard
          eyebrow="Aucune demande"
          title="Vous n'avez pas encore soumis de demande"
        >
          <p className="text-[14px] leading-relaxed text-ink/70">
            BIS 2026 accueille sponsors, partenaires, intervenants et
            créateurs de contenu. Soumettez une demande pour rejoindre
            l&apos;édition officielle.
          </p>
          <div className="mt-6">
            <Link href="/be-a-part" className="btn-lime">
              Découvrir les rôles
              <span aria-hidden>→</span>
            </Link>
          </div>
        </CompteCard>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {applications.map((app) => (
        <CompteCard
          key={`${app.type}-${app.createdAt.toISOString()}`}
          eyebrow={APPLICATION_TYPE_LABEL[app.type]}
          title={`Demande ${APPLICATION_TYPE_LABEL[app.type]}`}
        >
          <dl>
            <CompteRow
              label="Statut"
              value={
                <StatusPill
                  size="sm"
                  tone={APPLICATION_STATUS_TONE[app.status]}
                  label={APPLICATION_STATUS_LABEL[app.status]}
                />
              }
            />
            <CompteRow label="Soumise le" value={formatDate(app.createdAt)} />
            {app.reviewedAt && (
              <CompteRow
                label="Examinée le"
                value={formatDate(app.reviewedAt)}
              />
            )}
          </dl>
          <p className="mt-5 text-[12px] leading-relaxed text-ink/55">
            Vous serez contacté par l&apos;équipe BIS dès qu&apos;une décision
            sera prise. Les notes internes ne sont pas visibles publiquement.
          </p>
        </CompteCard>
      ))}
    </div>
  );
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(d);
}

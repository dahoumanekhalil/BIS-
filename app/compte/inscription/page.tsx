import Link from "next/link";
import { requireAccount } from "@/lib/account/auth";
import { getCompteContext } from "@/lib/account/participant";
import { CompteCard, CompteRow } from "@/components/compte/card";
import { StatusPill } from "@/components/compte/status-pill";
import {
  PARTICIPATION_LABEL,
  REGISTRATION_STATUS_LABEL,
  REGISTRATION_STATUS_TONE
} from "@/lib/account/labels";

export const metadata = { title: "Mon inscription" };

// Payment status → attendee-facing label. We deliberately do NOT expose
// payment amounts or references — those are admin-facing figures.
const PAYMENT_LABEL: Record<string, string> = {
  PAID: "Réglé",
  PENDING: "En attente de règlement",
  UNPAID: "Non réglé",
  REFUNDED: "Remboursé",
  FAILED: "Échec du paiement"
};

export default async function CompteInscriptionPage() {
  const account = await requireAccount();
  const { participant } = await getCompteContext(account);

  if (!participant) {
    return (
      <div className="mx-auto max-w-2xl">
        <CompteCard title="Aucune inscription active">
          <p className="text-[14px] leading-relaxed text-ink/70">
            Votre compte existe, mais aucune inscription au sommet n&apos;est
            liée pour le moment.
          </p>
          <div className="mt-6">
            <Link href="/register" className="btn-lime">
              M&apos;inscrire à BIS 2027
            </Link>
          </div>
        </CompteCard>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <CompteCard eyebrow="Statut" title="Mon inscription BIS 2027">
        <dl>
          <CompteRow
            label="Statut"
            value={
              <StatusPill
                size="sm"
                tone={REGISTRATION_STATUS_TONE[participant.status]}
                label={REGISTRATION_STATUS_LABEL[participant.status]}
              />
            }
          />
          <CompteRow
            label="Participation"
            value={
              participant.participationChoice
                ? PARTICIPATION_LABEL[participant.participationChoice]
                : null
            }
          />
          <CompteRow
            label="Paiement"
            value={PAYMENT_LABEL[participant.paymentStatus] ?? "—"}
          />
          <CompteRow
            label="Inscrit le"
            value={formatDate(participant.createdAt)}
          />
          {participant.ticketCode && (
            <CompteRow
              label="Code billet"
              value={
                <span className="font-mono text-[13px] tracking-tight">
                  {participant.ticketCode}
                </span>
              }
            />
          )}
        </dl>
      </CompteCard>

      <CompteCard eyebrow="Contact" title="Informations de participation">
        <dl>
          <CompteRow
            label="Nom"
            value={`${participant.firstName} ${participant.lastName}`}
          />
          <CompteRow label="Email" value={participant.email} />
          <CompteRow label="Téléphone" value={participant.phone} />
          <CompteRow label="Pays" value={participant.country} />
        </dl>
        <p className="mt-5 text-[12px] leading-relaxed text-ink/55">
          Pour modifier ces informations, rendez-vous sur{" "}
          <Link
            href="/compte/profil"
            className="font-semibold text-cobalt hover:text-cobalt-700"
          >
            Mon profil
          </Link>
          .
        </p>
      </CompteCard>
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

import Link from "next/link";
import { requireAccount } from "@/lib/account/auth";
import {
  accessStateFor,
  getCompteContext,
  type AccessState
} from "@/lib/account/participant";
import { CompteCard, CompteRow } from "@/components/compte/card";
import { StatusPill } from "@/components/compte/status-pill";
import {
  APPLICATION_STATUS_LABEL,
  APPLICATION_STATUS_TONE,
  APPLICATION_TYPE_LABEL,
  BADGE_STATUS_LABEL,
  BADGE_STATUS_TONE,
  PARTICIPATION_LABEL,
  REGISTRATION_STATUS_LABEL,
  REGISTRATION_STATUS_TONE,
  type StatusTone
} from "@/lib/account/labels";
import { eventInfo } from "@/lib/utils";

// Tri-state pill mapping — kept in sync with /compte/acces. See
// lib/account/participant.ts::accessStateFor for the state semantics.
const ACCESS_STATE_LABEL: Record<AccessState, string> = {
  granted: "Autorisé",
  denied: "Refusé",
  unassigned: "Non attribué"
};

const ACCESS_STATE_TONE: Record<AccessState, StatusTone> = {
  granted: "ok",
  denied: "danger",
  unassigned: "muted"
};

export default async function ComptePage() {
  const account = await requireAccount();
  const { participant, accessPoints } = await getCompteContext(account);

  // AccountUser exists but never went through /register — the layout still
  // renders header + tabs, this page invites them to finish onboarding.
  if (!participant) {
    return (
      <div className="mx-auto max-w-2xl">
        <CompteCard
          eyebrow="Inscription requise"
          title="Finalisez votre inscription BIS 2027"
        >
          <p className="text-[14px] leading-relaxed text-ink/70">
            Votre compte est actif, mais votre inscription au sommet n&apos;est
            pas encore complète. Terminez le formulaire pour obtenir votre
            badge et vos accès.
          </p>
          <div className="mt-6">
            <Link href="/register" className="btn-lime-lg">
              Compléter mon inscription
              <span aria-hidden>→</span>
            </Link>
          </div>
        </CompteCard>
      </div>
    );
  }

  const badge = participant.credentials[0] ?? null;
  const permissions = participant.accessPermissions;
  const applications = participant.applications;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* ─── Left column (2 cols wide on lg) ────────────────────────── */}
      <div className="grid gap-6 lg:col-span-2">
        <CompteCard
          eyebrow="Badge BIS 2027"
          title="Votre credential digital"
          action={{ href: "/compte/badge", label: "Voir mon badge" }}
        >
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <BadgeAvatar
                firstName={participant.firstName}
                lastName={participant.lastName}
              />
              <div>
                <p className="font-display text-xl font-black tracking-tight text-ink">
                  {participant.firstName} {participant.lastName}
                </p>
                {participant.participationChoice && (
                  <p className="mt-1 text-[12.5px] uppercase tracking-[0.16em] text-ink/60">
                    {PARTICIPATION_LABEL[participant.participationChoice]}
                  </p>
                )}
              </div>
            </div>
            <div>
              {badge ? (
                <StatusPill
                  tone={BADGE_STATUS_TONE[badge.status]}
                  label={BADGE_STATUS_LABEL[badge.status]}
                />
              ) : (
                <StatusPill tone="muted" label="Badge non émis" />
              )}
            </div>
          </div>
          <p className="mt-6 border-t border-line/70 pt-5 text-[12.5px] leading-relaxed text-ink/60">
            Votre badge et votre QR code seront disponibles sur la page
            <Link
              href="/compte/badge"
              className="ml-1 font-semibold text-cobalt hover:text-cobalt-700"
            >
              Mon badge
            </Link>{" "}
            — présentez-le à l&apos;accueil et à chaque salle.
          </p>
        </CompteCard>

        <CompteCard
          eyebrow="Vos accès"
          title="Salles du sommet"
          action={{ href: "/compte/acces", label: "Détail des accès" }}
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {accessPoints.map((ap) => {
              const state = accessStateFor(permissions, ap.id);
              return (
                <li
                  key={ap.slug}
                  className="flex items-center justify-between rounded-lg border border-line/70 bg-frost/60 px-3.5 py-2.5 text-[13px]"
                >
                  <span className="font-medium text-ink">{ap.name}</span>
                  <StatusPill
                    size="sm"
                    tone={ACCESS_STATE_TONE[state]}
                    label={ACCESS_STATE_LABEL[state]}
                  />
                </li>
              );
            })}
          </ul>
          <p className="mt-5 text-[12px] leading-relaxed text-ink/55">
            Les accès aux salles sont attribués individuellement par
            l&apos;organisation. L&apos;entrée principale suit les règles de
            votre inscription.
          </p>
        </CompteCard>
      </div>

      {/* ─── Right column (1 col wide on lg) ─────────────────────────── */}
      <div className="grid gap-6">
        <CompteCard
          eyebrow="Inscription"
          title="Votre statut"
          action={{ href: "/compte/inscription", label: "Détails" }}
        >
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
              label="Inscrit le"
              value={formatDate(participant.createdAt)}
            />
          </dl>
        </CompteCard>

        {applications.length > 0 && (
          <CompteCard
            eyebrow="Mes demandes"
            title={
              applications.length === 1
                ? "Demande en cours"
                : `${applications.length} demandes`
            }
            action={{ href: "/compte/demandes", label: "Voir" }}
          >
            <ul className="grid gap-3">
              {applications.slice(0, 2).map((app) => (
                <li
                  key={`${app.type}-${app.createdAt.toISOString()}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line/70 bg-frost/60 px-3.5 py-3"
                >
                  <span className="text-[13px] font-medium text-ink">
                    {APPLICATION_TYPE_LABEL[app.type]}
                  </span>
                  <StatusPill
                    size="sm"
                    tone={APPLICATION_STATUS_TONE[app.status]}
                    label={APPLICATION_STATUS_LABEL[app.status]}
                  />
                </li>
              ))}
            </ul>
          </CompteCard>
        )}

        <CompteCard eyebrow="L'événement" title="BIS 2027">
          <dl>
            <CompteRow label="Date" value={eventInfo.date} />
            <CompteRow label="Lieu" value={eventInfo.location} />
          </dl>
          <div className="mt-5 flex flex-col gap-2">
            <Link
              href="/programme"
              className="btn-ghost w-full justify-center"
            >
              Programme
            </Link>
          </div>
        </CompteCard>
      </div>
    </div>
  );
}

// Initials-in-Cobalt avatar treatment — same visual language used in the
// navbar. A real photo upload is deferred (Phase 5 will build the badge
// layout using this same convention).
function BadgeAvatar({
  firstName,
  lastName
}: {
  firstName: string;
  lastName: string;
}) {
  const initials =
    `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-cobalt text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_10px_30px_-16px_rgba(36,83,224,0.55)]"
    >
      <span className="font-display text-[18px] font-black tracking-tight">
        {initials}
      </span>
    </span>
  );
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(d);
}

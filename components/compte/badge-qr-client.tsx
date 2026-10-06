"use client";

import { cn } from "@/lib/utils";
import { useScreenWakeLock } from "./use-screen-wake-lock";
import { BadgePreview } from "./badge/badge-preview";
import { useBadgeExport } from "./badge/use-badge-export";
import {
  resolveBadgeRole,
  BADGE_ROLE_LABEL,
  type BadgeRole
} from "@/lib/badge/role";
import type {
  BadgeStatus,
  ParticipationChoice,
  RegistrationTier
} from "@prisma/client";

// Subscriber badge view — VIEW ONLY.
//
// The participant has ONE persistent QR. It is rendered on the server
// (`/compte/badge`) and passed here as an image; this component contains NO
// server action and NO control that could create, rotate, replace or revoke
// a credential. Displaying, refreshing, downloading or printing never
// changes the QR. Replacing a QR is an administrative operation.

export type BadgeIdentity = {
  firstName: string;
  lastName: string;
  participationChoice: ParticipationChoice | null;
  organization: string | null;
  jobTitle: string | null;
  badgeStatus: BadgeStatus | null;
  tier: RegistrationTier | null;
  // Human-readable fallback code printed on the badge face.
  checkinCode: string | null;
};

// Why no QR can be shown (server-computed). Null when `qrDataUrl` is set.
export type BadgeUnavailableReason =
  | "REVOKED"
  | "LEGACY"
  | "EXPIRED"
  | "NONE"
  | "ERROR";

const UNAVAILABLE_COPY: Record<BadgeUnavailableReason, string> = {
  REVOKED:
    "Votre badge a été désactivé par l'équipe BIS. Contactez l'équipe pour obtenir un nouveau QR.",
  LEGACY:
    "Votre badge est en cours de mise à jour par l'équipe BIS. Votre nouveau QR sera disponible ici dès sa réémission.",
  EXPIRED:
    "Votre badge a expiré. Contactez l'équipe BIS pour obtenir un nouveau QR.",
  NONE: "Votre badge n'est pas encore disponible. Réessayez dans quelques instants ou contactez l'équipe BIS.",
  ERROR:
    "Votre badge est momentanément indisponible. Réessayez plus tard ou contactez l'équipe BIS."
};

export function BadgeQrClient({
  identity,
  qrDataUrl,
  unavailableReason
}: {
  identity: BadgeIdentity;
  qrDataUrl: string | null;
  unavailableReason: BadgeUnavailableReason | null;
}) {
  const displayQr = qrDataUrl;
  const wake = useScreenWakeLock(Boolean(displayQr));

  const role: BadgeRole = resolveBadgeRole({
    tier: identity.tier,
    participationChoice: identity.participationChoice
  });

  const exp = useBadgeExport({
    firstName: identity.firstName,
    lastName: identity.lastName
  });

  return (
    <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <div>
        <BadgePreview
          firstName={identity.firstName}
          lastName={identity.lastName}
          jobTitle={identity.jobTitle}
          organization={identity.organization}
          role={role}
          qr={displayQr}
          checkinCode={identity.checkinCode}
          frontRef={exp.frontRef}
          backRef={exp.backRef}
        />
      </div>

      <div className="print-hide grid gap-5">
        <div className="rounded-[16px] border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Credential digital
          </p>
          <h3 className="mt-2 font-display text-lg font-black leading-tight tracking-tight text-ink">
            {displayQr ? "Votre QR permanent" : "QR indisponible"}
          </h3>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink/65">
            {displayQr
              ? "Présentez ce QR à l'accueil et à chaque salle. C'est toujours le même QR : il ne change pas quand vous rouvrez ou actualisez cette page."
              : UNAVAILABLE_COPY[unavailableReason ?? "ERROR"]}
          </p>

          {displayQr && wake.supported && (
            <p className="mt-4 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-ink/45">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  wake.active ? "bg-lime-600" : "bg-ink/25"
                )}
              />
              {wake.active
                ? "Écran gardé actif"
                : "Écran non verrouillé pour le moment"}
            </p>
          )}

          <p className="mt-4 text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink/45">
            Rôle : {BADGE_ROLE_LABEL[role]}
          </p>
        </div>

        <div className="rounded-[16px] border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Export
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink/60">
            Téléchargez ou imprimez votre badge. L&apos;export utilise votre
            QR permanent — il ne le modifie jamais.
          </p>

          <div className="mt-4 grid gap-2">
            <button
              type="button"
              onClick={exp.downloadPngFront}
              disabled={!displayQr || exp.busy !== null}
              className="inline-flex items-center justify-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exp.busy === "png-front"
                ? "Export…"
                : "Télécharger PNG · Face avant"}
            </button>
            <button
              type="button"
              onClick={exp.downloadPngBack}
              disabled={!displayQr || exp.busy !== null}
              className="inline-flex items-center justify-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exp.busy === "png-back"
                ? "Export…"
                : "Télécharger PNG · Face arrière"}
            </button>
            <button
              type="button"
              onClick={exp.downloadPdf}
              disabled={!displayQr || exp.busy !== null}
              className="inline-flex items-center justify-center gap-2 rounded-btn bg-cobalt px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exp.busy === "pdf" ? "Génération PDF…" : "Télécharger PDF"}
            </button>
            <button
              type="button"
              onClick={exp.doPrint}
              disabled={!displayQr || exp.busy !== null}
              className="btn-ghost w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
            >
              Imprimer
            </button>
          </div>

          {!displayQr && (
            <p className="mt-3 text-[11.5px] italic leading-relaxed text-ink/50">
              Les exports sont disponibles lorsque votre QR est affiché.
            </p>
          )}
          {exp.error && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
            >
              {exp.error}
            </p>
          )}
        </div>

        <div className="rounded-[16px] border border-dashed border-line bg-frost/60 p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Sécurité
          </p>
          <ul className="mt-3 space-y-2 text-[12px] leading-relaxed text-ink/60">
            <li className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cobalt"
              />
              <span>
                Le QR contient uniquement un credential aléatoire — aucune
                donnée personnelle n&apos;y est encodée.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cobalt"
              />
              <span>
                Votre QR ne peut être remplacé que par l&apos;équipe BIS. En
                cas de perte ou de vol, contactez-la : l&apos;ancien QR et le
                code de secours imprimé seront alors désactivés.
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

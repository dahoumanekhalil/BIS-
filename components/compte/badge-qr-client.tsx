"use client";

import { useActionState } from "react";
import { cn } from "@/lib/utils";
import {
  generateOrRotateMyBadge,
  type BadgeGenerationResult
} from "@/app/compte/badge/actions";
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

// Phase 18 — refactored badge client.
//
// The credential flow itself (Phase 5 + Phase 12) is UNCHANGED:
//   • Same `useActionState` around `generateOrRotateMyBadge`.
//   • Same `pending`/`state.ok`/`qrDataUrl` handling.
//   • Same 10-second rate limit on the server side.
//   • Same "one click = one rotation" semantic. `Régénérer` still
//     revokes the previous credential and issues a new one atomically
//     via the Phase 2 service.
//
// What CHANGED is only the visual + export surface:
//   • BadgeFront / BadgeBack (single source of truth for web + PNG
//     + PDF + print) replace the previous single BadgeCard.
//   • New PNG / PDF export controls next to the existing Imprimer.
//     None of them touch the credential lifecycle.

const INITIAL: BadgeGenerationResult = {
  ok: false,
  reason: "NO_PARTICIPANT",
  message: ""
};

export type BadgeIdentity = {
  firstName: string;
  lastName: string;
  participationChoice: ParticipationChoice | null;
  organization: string | null;
  jobTitle: string | null;
  badgeStatus: BadgeStatus | null;
  tier: RegistrationTier | null;
  // Phase 19 — attendee's secure human-readable check-in code.
  // Rendered on the badge front for manual fallback entry when
  // the QR cannot be scanned. Null only during the (transient)
  // window before Phase 19's backfill or ensureCheckinCode has
  // populated the field.
  checkinCode: string | null;
};

export function BadgeQrClient({
  identity,
  hasActiveCredential
}: {
  identity: BadgeIdentity;
  hasActiveCredential: boolean;
}) {
  const [state, formAction, pending] = useActionState<BadgeGenerationResult>(
    async () => generateOrRotateMyBadge(),
    INITIAL
  );

  const displayQr = state.ok ? state.qrDataUrl : null;
  const buttonLabel = pending
    ? "Génération…"
    : displayQr
      ? "Régénérer mon QR"
      : hasActiveCredential
        ? "Afficher mon QR"
        : "Générer mon badge";

  // Phase 12 wake-lock — unchanged.
  const wake = useScreenWakeLock(Boolean(displayQr));

  // Phase 18 role classifier (pure, derived from tier + participation).
  const role: BadgeRole = resolveBadgeRole({
    tier: identity.tier,
    participationChoice: identity.participationChoice
  });

  // Phase 18 export hook — refs point at hidden off-screen capture
  // containers inside <BadgePreview />.
  const exp = useBadgeExport({
    firstName: identity.firstName,
    lastName: identity.lastName
  });

  return (
    <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      {/* Left column — the badge preview (front + back). */}
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

      {/* Right column — controls. Hidden on print. */}
      <div className="print-hide grid gap-5">
        {/* Credential card — unchanged Phase 5 form + copy. */}
        <div className="rounded-[16px] border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Credential digital
          </p>
          <h3 className="mt-2 font-display text-lg font-black leading-tight tracking-tight text-ink">
            {displayQr
              ? "Votre QR est prêt"
              : hasActiveCredential
                ? "Un badge existe déjà"
                : "Aucun badge encore émis"}
          </h3>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink/65">
            {displayQr
              ? "Présentez ce QR à l'accueil et à chaque salle. Il reste affiché tant que vous n'actualisez pas la page."
              : hasActiveCredential
                ? "Cliquez sur « Afficher mon QR » pour générer un nouveau code. Votre QR précédent sera automatiquement révoqué — un seul code actif à la fois."
                : "Générez votre credential BIS 2027 pour obtenir un QR code sécurisé, valable à l'entrée principale et à chaque salle attribuée."}
          </p>

          <form action={formAction} className="mt-5 grid gap-3">
            <button
              type="submit"
              disabled={pending}
              className={cn(
                "inline-flex w-full items-center justify-center gap-2 rounded-btn bg-cobalt px-5 py-3 text-[13px] font-semibold text-white transition-all",
                "hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
              )}
            >
              {buttonLabel}
              {!pending && <span aria-hidden>→</span>}
            </button>
          </form>

          {!state.ok && state.message && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900"
            >
              {state.message}
            </p>
          )}

          {state.ok && (
            <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink/45">
              Émis à{" "}
              {new Date(state.issuedAt).toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit"
              })}
            </p>
          )}

          {displayQr && wake.supported && (
            <p className="mt-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-ink/45">
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

        {/* Phase 18 export card. Enabled only when the QR is on
            screen — matches the print button's Phase 5 behaviour. */}
        <div className="rounded-[16px] border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Export
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink/60">
            Téléchargez le badge en haute résolution pour l&apos;impression
            professionnelle ou l&apos;envoi. L&apos;export utilise le QR
            actuellement affiché — il ne régénère jamais votre credential.
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
              Générez d&apos;abord votre QR pour activer les exports.
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

        {/* Security note — unchanged copy from Phase 12. */}
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
                Chaque régénération invalide immédiatement l&apos;ancien
                code. L&apos;export (PNG / PDF / impression) ne modifie
                jamais votre credential.
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

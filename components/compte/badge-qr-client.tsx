"use client";

import { useActionState } from "react";
import { cn } from "@/lib/utils";
import {
  generateOrRotateMyBadge,
  type BadgeGenerationResult
} from "@/app/compte/badge/actions";
import { BadgeCard } from "./badge-card";
import { useScreenWakeLock } from "./use-screen-wake-lock";
import type { BadgeStatus, ParticipationChoice } from "@prisma/client";

// Client half of the Phase 5 badge experience. Owns:
//   • the "Générer / Afficher mon QR" form (server action call).
//   • the rendered BadgeCard with QR embedded after a successful call.
//   • the "Imprimer mon badge" trigger — invokes window.print(), whose
//     media rules (globals.css) hide everything except `.print-badge`.
//
// SECURITY:
//   • The server action is the ONLY code path that can obtain a raw
//     credential token, and it does not return the raw token as a string —
//     only the encoded PNG data URL. The client stores the data URL in
//     component state; it is not persisted to sessionStorage, localStorage,
//     or a cookie. Closing the tab drops it.
//   • Every click of "Régénérer" triggers a fresh rotation server-side
//     which revokes the previous credential. This is documented in the UI
//     copy so users are not surprised.

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

  // Phase 12 — request the Screen Wake Lock while the QR is on screen
  // so the phone does not dim/lock during the seconds the operator
  // needs to scan. Silent no-op on browsers that do not support the
  // API (older iOS, obscure UAs). Cannot force brightness — the
  // attendee still needs to raise brightness manually in bright halls.
  const wake = useScreenWakeLock(Boolean(displayQr));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      {/* Left column — the badge itself (also the print target). */}
      <div>
        <BadgeCard
          firstName={identity.firstName}
          lastName={identity.lastName}
          participationChoice={identity.participationChoice}
          organization={identity.organization}
          jobTitle={identity.jobTitle}
          badgeStatus={
            displayQr ? "ACTIVE" : identity.badgeStatus
          }
          qr={displayQr}
        />
      </div>

      {/* Right column — controls + copy. Hidden on print. */}
      <div className="print-hide grid gap-5">
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
                : "Générez votre credential BIS 2026 pour obtenir un QR code sécurisé, valable à l'entrée principale et à chaque salle attribuée."}
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

            {displayQr && (
              <button
                type="button"
                onClick={() => window.print()}
                className="btn-ghost w-full justify-center"
              >
                Imprimer mon badge
              </button>
            )}
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
                Chaque régénération invalide immédiatement l&apos;ancien
                code. Ne partagez pas votre QR en dehors du contrôle
                d&apos;accès.
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { AdmissionMode, RoomRegistrationStatus } from "@prisma/client";
import {
  registerForRoom,
  cancelMyRoomRegistration,
  type RegistrationActionResult
} from "@/app/actions/room-registration";
import { StatusPill } from "@/components/compte/status-pill";
import type { StatusTone } from "@/lib/account/labels";

// ─── Room registration controls (Sub-Phase D §4 + §5) ──────────────────
//
// Client component embedded per-room on /compte/acces. Renders:
//
//   • Room name + admission mode label (FREE / PAID)
//   • Current registration state (unregistered / confirmed / pending /
//     terminal)
//   • For FREE rooms: a single "S'inscrire" button when no registration
//     exists; a "Se désinscrire" button when FREE_CONFIRMED.
//   • For PAID rooms: server-side priceMinorSnapshot + currencySnapshot
//     rendered in DZD; a "Réserver ma place" button that triggers a
//     PENDING_PAYMENT registration. NO "Confirmer paiement" button —
//     confirmation is server-side and admin-only.
//   • Error messages surfaced from the server action are shown inline.
//
// SECURITY:
//   • This component ONLY passes the accessPointId to the server
//     action. The participant identity is resolved server-side from
//     the session cookie (see app/actions/room-registration.ts).
//   • The displayed price/currency comes from a server-side snapshot
//     (RoomRegistration.priceMinorSnapshot / currencySnapshot) when a
//     registration exists, or from the AccessPoint's server-fetched
//     price/currency at page render time. The browser never controls
//     the price sent back to the server.
//   • The action result never exposes internal ids, provider details,
//     or database errors — see the friendlyMessage table in the
//     server action.

const STATUS_LABEL: Record<RoomRegistrationStatus, string> = {
  PENDING_PAYMENT: "En attente de paiement",
  FREE_CONFIRMED: "Inscription confirmée",
  PAID: "Inscription confirmée · Paiement reçu",
  PAYMENT_FAILED: "Paiement échoué",
  CANCELLED: "Inscription annulée",
  REFUNDED: "Paiement remboursé",
  EXPIRED: "Délai de paiement dépassé"
};

const STATUS_TONE: Record<RoomRegistrationStatus, StatusTone> = {
  PENDING_PAYMENT: "wait",
  FREE_CONFIRMED: "ok",
  PAID: "ok",
  PAYMENT_FAILED: "danger",
  CANCELLED: "muted",
  REFUNDED: "muted",
  EXPIRED: "muted"
};

// Statuses that grant room access today.
const ACTIVE_GRANT_STATUSES = new Set<RoomRegistrationStatus>([
  RoomRegistrationStatus.FREE_CONFIRMED,
  RoomRegistrationStatus.PAID
]);

// Statuses from which a fresh registration is still allowed (mirrors
// state-machine.ts:canReRegister — REFUNDED is deliberately excluded).
const RETRY_ALLOWED_STATUSES = new Set<RoomRegistrationStatus>([
  RoomRegistrationStatus.CANCELLED,
  RoomRegistrationStatus.PAYMENT_FAILED,
  RoomRegistrationStatus.EXPIRED
]);

// Attendee-facing DZD formatter. Integer minor units (no floating
// point). Matches the admin surface convention.
function formatDzd(minor: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "DZD",
    maximumFractionDigits: 0
  }).format(minor);
}

export type RoomRegistrationControlsProps = {
  accessPointId: string;
  accessPointName: string;
  admissionMode: AdmissionMode;
  // Current AccessPoint price/currency, used for the "unregistered"
  // display. Once a registration exists, we prefer the snapshot from
  // that registration (frozen at register-time).
  currentPriceMinor: number | null;
  currentCurrency: string | null;
  // Existing registration for the current participant, if any.
  registration: {
    status: RoomRegistrationStatus;
    priceMinorSnapshot: number | null;
    currencySnapshot: string | null;
  } | null;
};

export function RoomRegistrationControls({
  accessPointId,
  accessPointName,
  admissionMode,
  currentPriceMinor,
  currentCurrency,
  registration
}: RoomRegistrationControlsProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isPaid = admissionMode === AdmissionMode.PAID;
  const status = registration?.status ?? null;
  const isGranted = status !== null && ACTIVE_GRANT_STATUSES.has(status);
  const canRetry = status !== null && RETRY_ALLOWED_STATUSES.has(status);
  const canRegister = status === null || canRetry;
  const canCancel =
    status === RoomRegistrationStatus.FREE_CONFIRMED ||
    status === RoomRegistrationStatus.PENDING_PAYMENT;

  // Prefer the frozen snapshot from the existing registration (never
  // recompute from the live AccessPoint on the client — that value
  // could have changed after the registration was locked). Fall back
  // to the current AccessPoint price/currency for the pre-registration
  // display.
  const displayPriceMinor =
    registration?.priceMinorSnapshot ?? currentPriceMinor;
  const displayCurrency = registration?.currencySnapshot ?? currentCurrency;

  function submit(action: () => Promise<RegistrationActionResult>) {
    setErrorMessage(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setErrorMessage(res.message);
      }
      // On success, Next's revalidatePath in the server action refetches
      // the page — no local state update needed.
    });
  }

  return (
    <div className="grid gap-3 rounded-lg border border-line/70 bg-frost/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[13.5px] font-semibold text-ink">
            {accessPointName}
          </p>
          <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink/45">
            {isPaid ? "Salle payante" : "Salle · Accès libre"}
          </p>
        </div>
        {status ? (
          <StatusPill
            size="sm"
            tone={STATUS_TONE[status]}
            label={STATUS_LABEL[status]}
          />
        ) : (
          <StatusPill
            size="sm"
            tone="muted"
            label={isPaid ? "Non réservée" : "Non inscrit"}
          />
        )}
      </div>

      {/* PAID room: always render the price from the SERVER snapshot */}
      {isPaid && displayPriceMinor !== null && displayCurrency && (
        <p className="text-[13px] text-ink/70">
          Tarif · <span className="font-semibold text-ink">{formatDzd(displayPriceMinor)}</span>
          {registration && (
            <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-ink/45">
              (verrouillé à l&apos;inscription)
            </span>
          )}
        </p>
      )}

      {/* PAID room, PENDING_PAYMENT — explicit warning that access is
          not yet granted. Sub-Phase D §5 requirement. */}
      {status === RoomRegistrationStatus.PENDING_PAYMENT && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900">
          Votre place est réservée. L&apos;accès à la salle sera activé une
          fois le paiement confirmé par l&apos;organisation.
        </p>
      )}

      {/* Explicit "granted / confirmed" hint for FREE_CONFIRMED / PAID */}
      {isGranted && (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12.5px] leading-relaxed text-emerald-900">
          Vous êtes inscrit à cette salle. Présentez votre badge à
          l&apos;entrée de la salle.
        </p>
      )}

      {/* REFUNDED / PAYMENT_FAILED / EXPIRED / CANCELLED context */}
      {status === RoomRegistrationStatus.REFUNDED && (
        <p className="rounded-md border border-line/70 bg-white px-3 py-2 text-[12.5px] leading-relaxed text-ink/70">
          Votre paiement a été remboursé. Une nouvelle inscription doit
          être autorisée par l&apos;organisation.
        </p>
      )}

      {errorMessage && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[12.5px] text-red-900"
        >
          {errorMessage}
        </p>
      )}

      {/* ACTION BUTTONS */}
      <div className="flex flex-wrap gap-2">
        {canRegister && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => submit(() => registerForRoom(accessPointId))}
            className="inline-flex items-center justify-center rounded-btn bg-cobalt px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending
              ? "En cours…"
              : isPaid
                ? displayPriceMinor !== null && displayCurrency
                  ? `Réserver — ${formatDzd(displayPriceMinor)}`
                  : "Réserver ma place"
                : "S'inscrire à la salle"}
          </button>
        )}

        {canCancel && (
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              submit(() => cancelMyRoomRegistration(accessPointId))
            }
            className="inline-flex items-center justify-center rounded-btn border border-ink/15 bg-white px-4 py-2 text-[13px] font-bold text-ink transition-colors hover:border-red-500 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "En cours…" : "Se désinscrire"}
          </button>
        )}
      </div>
    </div>
  );
}

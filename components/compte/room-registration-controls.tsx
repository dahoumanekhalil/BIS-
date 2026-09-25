"use client";

import { useState, useTransition } from "react";
import { RoomRegistrationStatus } from "@prisma/client";
import {
  registerForRoom,
  cancelMyRoomRegistration,
  type RegistrationActionResult
} from "@/app/actions/room-registration";
import { StatusPill } from "@/components/compte/status-pill";
import type { StatusTone } from "@/lib/account/labels";

// ─── Room registration controls (FREE-only) ────────────────────────────
//
// Client component embedded per-room on /compte/acces. Renders:
//
//   • Room name
//   • Current registration state (unregistered / confirmed / cancelled)
//   • "S'inscrire" button when no active registration exists
//   • "Se désinscrire" button when FREE_CONFIRMED
//   • Error messages surfaced from the server action are shown inline.
//
// SECURITY:
//   • This component ONLY passes the accessPointId to the server
//     action. The participant identity is resolved server-side from
//     the session cookie.

const STATUS_LABEL: Record<RoomRegistrationStatus, string> = {
  FREE_CONFIRMED: "Inscription confirmée",
  CANCELLED: "Inscription annulée"
};

const STATUS_TONE: Record<RoomRegistrationStatus, StatusTone> = {
  FREE_CONFIRMED: "ok",
  CANCELLED: "muted"
};

export type RoomRegistrationControlsProps = {
  accessPointId: string;
  accessPointName: string;
  registration: {
    status: RoomRegistrationStatus;
  } | null;
};

export function RoomRegistrationControls({
  accessPointId,
  accessPointName,
  registration
}: RoomRegistrationControlsProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const status = registration?.status ?? null;
  const isGranted = status === RoomRegistrationStatus.FREE_CONFIRMED;
  const canRetry = status === RoomRegistrationStatus.CANCELLED;
  const canRegister = status === null || canRetry;
  const canCancel = status === RoomRegistrationStatus.FREE_CONFIRMED;

  function submit(action: () => Promise<RegistrationActionResult>) {
    setErrorMessage(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setErrorMessage(res.message);
      }
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
            Salle · Accès libre
          </p>
        </div>
        {status ? (
          <StatusPill
            size="sm"
            tone={STATUS_TONE[status]}
            label={STATUS_LABEL[status]}
          />
        ) : (
          <StatusPill size="sm" tone="muted" label="Non inscrit" />
        )}
      </div>

      {isGranted && (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12.5px] leading-relaxed text-emerald-900">
          Vous êtes inscrit à cette salle. Présentez votre badge à
          l&apos;entrée de la salle.
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

      <div className="flex flex-wrap gap-2">
        {canRegister && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => submit(() => registerForRoom(accessPointId))}
            className="inline-flex items-center justify-center rounded-btn bg-cobalt px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "En cours…" : "S'inscrire à la salle"}
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

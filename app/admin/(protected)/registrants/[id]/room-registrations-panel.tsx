"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import {
  AccessGrantSource,
  RoomRegistrationStatus
} from "@prisma/client";
import { cancelRoomRegistrationAction } from "./room-registration-actions";

// ─── Admin Room Registrations panel (FREE-only) ────────────────────────
//
// Reads a pre-loaded list of RoomRegistration rows (loaded server-side
// by lib/admin/queries.ts:getRegistrantRoomRegistrations) and offers,
// per row:
//   • Cancel  (FREE_CONFIRMED)  → access.manage
//
// The server action lives in ./room-registration-actions.ts. It:
//   • Re-derives the actor from the session cookie.
//   • Delegates to the canonical domain service (`cancel`) which
//     enforces the state machine, syncs REGISTRATION-owned
//     ParticipantAccess only, and writes AuditLog.

export type RegistrationRow = {
  id: string;
  status: RoomRegistrationStatus;
  registeredAt: Date;
  cancelledAt: Date | null;
  accessPoint: {
    id: string;
    slug: string;
    name: string;
    active: boolean;
  };
  access: {
    accessPointId: string;
    granted: boolean;
    source: AccessGrantSource;
  } | null;
};

export function RoomRegistrationsPanel({
  participantId,
  registrations,
  canCancelRegistration
}: {
  participantId: string;
  registrations: readonly RegistrationRow[];
  canCancelRegistration: boolean;
}) {
  return (
    <section className="rounded-card border border-line bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Inscriptions en salle
          </p>
          <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-ink/60">
            Chaque salle est une inscription indépendante et gratuite.
            L&apos;annulation révoque l&apos;accès accordé par
            l&apos;inscription mais préserve un accès accordé manuellement
            par un administrateur, ainsi que l&apos;historique de check-in.
          </p>
        </div>
      </div>

      {registrations.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed border-line bg-frost/40 p-4 text-[13px] text-ink/60">
          Aucune inscription en salle pour ce participant.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {registrations.map((r) => (
            <RegistrationCard
              key={r.id}
              participantId={participantId}
              row={r}
              canCancelRegistration={canCancelRegistration}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RegistrationCard({
  participantId,
  row,
  canCancelRegistration
}: {
  participantId: string;
  row: RegistrationRow;
  canCancelRegistration: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const showCancelBtn =
    canCancelRegistration && row.status === RoomRegistrationStatus.FREE_CONFIRMED;

  const closeConfirm = () => {
    setConfirming(false);
    setReason("");
    setError(null);
  };

  const submit = () => {
    const cleaned = reason.trim();
    setError(null);
    startTransition(async () => {
      try {
        const res = await cancelRoomRegistrationAction(
          participantId,
          row.accessPoint.id,
          cleaned || undefined
        );
        if (!res.ok) {
          setError(res.message ?? "Action refusée.");
          return;
        }
        closeConfirm();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action refusée.");
      }
    });
  };

  const paSummary = accessSummary(row);
  const warn = statusWarn(row.status);

  return (
    <li
      className={cn(
        "rounded-lg border p-4",
        warn ? "border-amber-300/60 bg-amber-50/40" : "border-line bg-frost/40"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-display text-base font-black tracking-tight text-ink">
              {row.accessPoint.name}
            </span>
            <span className="rounded-full bg-ink/5 px-2 py-[1px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink/60">
              {row.accessPoint.slug}
            </span>
            <RoomStatusBadge status={row.status} />
          </p>
          {warn && <p className="mt-1 text-[11.5px] text-amber-900">{warn}</p>}
        </div>
        <div className="text-right">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink/50">
            Salle gratuite
          </p>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Kv label="Inscription" value={fmtDate(row.registeredAt)} />
        {row.cancelledAt && (
          <Kv label="Annulée le" value={fmtDate(row.cancelledAt)} />
        )}
      </dl>

      <div className="mt-4 grid gap-3 rounded-md border border-line/70 bg-white p-3 sm:grid-cols-2">
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Accès inscription
          </p>
          <p className="mt-1 text-[13px] font-semibold text-ink">
            {paSummary.registration}
          </p>
        </div>
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Accès admin
          </p>
          <p className="mt-1 text-[13px] font-semibold text-ink">
            {paSummary.admin}
          </p>
        </div>
        <p className="text-[11.5px] text-ink/55 sm:col-span-2">
          L&apos;annulation ne modifie <em>jamais</em> un accès accordé par un
          administrateur (source ADMIN). Utilisez la matrice d&apos;accès pour
          les overrides admin.
        </p>
      </div>

      {showCancelBtn && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || confirming}
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 rounded-btn border border-red-300 bg-red-50 px-3 py-1.5 text-[12px] font-bold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Annuler l&apos;inscription
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmationDialog
          roomName={row.accessPoint.name}
          reason={reason}
          onReasonChange={setReason}
          pending={pending}
          error={error}
          onCancel={closeConfirm}
          onSubmit={submit}
        />
      )}
    </li>
  );
}

function ConfirmationDialog({
  roomName,
  reason,
  onReasonChange,
  pending,
  error,
  onCancel,
  onSubmit
}: {
  roomName: string;
  reason: string;
  onReasonChange: (v: string) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Annuler cette inscription ?"
      className="mt-4 rounded-lg border border-line bg-white p-4 shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]"
    >
      <p className="font-display text-[15px] font-black tracking-tight text-ink">
        Annuler cette inscription ?
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/70">
        Annuler l&apos;inscription à « {roomName} ». L&apos;accès accordé par
        l&apos;inscription sera révoqué. Un accès admin éventuel reste actif.
        L&apos;historique de check-in n&apos;est pas modifié.
      </p>

      <label className="mt-3 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
        Motif (facultatif)
        <input
          type="text"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          maxLength={64}
          placeholder="Ex. : admin_cancel, no_show…"
          className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none transition-colors focus:border-cobalt"
        />
      </label>
      <p className="mt-1 text-[10.5px] leading-relaxed text-ink/45">
        Codes courts (ASCII, ≤ 64). Le motif figure dans l&apos;audit ; ne
        collez pas de données personnelles.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onSubmit}
          className="inline-flex items-center gap-1.5 rounded-btn bg-red-700 px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "En cours…" : "Confirmer l'annulation"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </dt>
      <dd className="mt-0.5 text-[13px] font-semibold text-ink">{value}</dd>
    </div>
  );
}

function RoomStatusBadge({ status }: { status: RoomRegistrationStatus }) {
  const cls = ROOM_STATUS_STYLE[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
        cls
      )}
    >
      {ROOM_STATUS_LABEL[status]}
    </span>
  );
}

const ROOM_STATUS_LABEL: Record<RoomRegistrationStatus, string> = {
  FREE_CONFIRMED: "Inscrit",
  CANCELLED: "Annulée"
};

const ROOM_STATUS_STYLE: Record<RoomRegistrationStatus, string> = {
  FREE_CONFIRMED: "bg-lime/25 text-ink",
  CANCELLED: "bg-ink/10 text-ink/70"
};

function accessSummary(row: RegistrationRow): {
  registration: string;
  admin: string;
} {
  const pa = row.access;
  if (!pa) {
    return { registration: "Aucun accès accordé", admin: "Aucun override" };
  }
  if (pa.source === AccessGrantSource.REGISTRATION) {
    return {
      registration: pa.granted
        ? "Accès accordé par l'inscription"
        : "Révoqué par l'inscription",
      admin: "Aucun override"
    };
  }
  return {
    registration: "Non applicable (contrôlé par l'admin)",
    admin: pa.granted ? "Autorisé par l'admin" : "Refusé par l'admin"
  };
}

function statusWarn(status: RoomRegistrationStatus): string | null {
  switch (status) {
    case RoomRegistrationStatus.CANCELLED:
      return "L'inscription est annulée. L'accès accordé par l'inscription est révoqué.";
    default:
      return null;
  }
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

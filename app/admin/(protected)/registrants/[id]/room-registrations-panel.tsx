"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import {
  AccessGrantSource,
  AdmissionMode,
  RoomRegistrationStatus
} from "@prisma/client";
import {
  cancelRoomRegistrationAction,
  confirmRoomPaymentAction,
  refundRoomPaymentAction
} from "./room-payment-actions";

// Sub-Phase E — Admin Room Payments & Registrations panel.
//
// Reads a pre-loaded list of RoomRegistration rows (loaded server-side
// by lib/admin/queries.ts:getRegistrantRoomRegistrations) and offers,
// per row:
//   • Confirm  (PAID rooms in PENDING_PAYMENT)     → payment.confirm.room
//   • Refund   (PAID rooms in PAID)                → payment.refund.room
//   • Cancel   (any live status)                   → access.manage
//
// The three server actions live in ./room-payment-actions.ts (Sub-Phase D)
// and are the ONLY trusted mutation path. They:
//   • Re-derive the actor from the session cookie — a client-supplied
//     actor is impossible via this component's API.
//   • Re-read the frozen price snapshot server-side — the browser
//     cannot control the amount or currency.
//   • Delegate to the canonical domain service (`confirmPayment`,
//     `refund`, `cancel`) which enforces the state machine, emits
//     exactly one RoomPaymentEvent per transition, syncs
//     REGISTRATION-owned ParticipantAccess only, and writes AuditLog.
//
// This client is a display + confirmation UX shell — never authoritative.

export type RegistrationRow = {
  id: string;
  status: RoomRegistrationStatus;
  priceMinorSnapshot: number | null;
  currencySnapshot: string | null;
  paymentRef: string | null;
  registeredAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  failedAt: Date | null;
  expiresAt: Date | null;
  accessPoint: {
    id: string;
    slug: string;
    name: string;
    admissionMode: AdmissionMode | null;
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
  canConfirmPayment,
  canRefundPayment,
  canCancelRegistration
}: {
  participantId: string;
  registrations: readonly RegistrationRow[];
  canConfirmPayment: boolean;
  canRefundPayment: boolean;
  canCancelRegistration: boolean;
}) {
  return (
    <section className="rounded-card border border-line bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Inscriptions en salle · paiements
          </p>
          <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-ink/60">
            Chaque salle est une inscription indépendante. Une salle payante
            reste{" "}
            <span className="font-semibold text-ink">en attente de paiement</span>{" "}
            jusqu&apos;à confirmation ; l&apos;accès n&apos;est pas accordé
            avant ce moment. Un remboursement révoque l&apos;accès accordé
            par l&apos;inscription mais préserve un accès accordé
            manuellement par un administrateur, ainsi que l&apos;historique
            de check-in.
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
              canConfirmPayment={canConfirmPayment}
              canRefundPayment={canRefundPayment}
              canCancelRegistration={canCancelRegistration}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type PendingAction = "confirm" | "refund" | "cancel";

function RegistrationCard({
  participantId,
  row,
  canConfirmPayment,
  canRefundPayment,
  canCancelRegistration
}: {
  participantId: string;
  row: RegistrationRow;
  canConfirmPayment: boolean;
  canRefundPayment: boolean;
  canCancelRegistration: boolean;
}) {
  const [confirm, setConfirm] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isPaidMode = row.accessPoint.admissionMode === AdmissionMode.PAID;
  const isFreeMode = row.accessPoint.admissionMode === AdmissionMode.FREE;

  const showConfirmBtn =
    canConfirmPayment &&
    isPaidMode &&
    row.status === RoomRegistrationStatus.PENDING_PAYMENT;
  const showRefundBtn =
    canRefundPayment && isPaidMode && row.status === RoomRegistrationStatus.PAID;
  const showCancelBtn =
    canCancelRegistration &&
    (row.status === RoomRegistrationStatus.PENDING_PAYMENT ||
      row.status === RoomRegistrationStatus.PAID ||
      row.status === RoomRegistrationStatus.FREE_CONFIRMED);

  const closeConfirm = () => {
    setConfirm(null);
    setReason("");
    setError(null);
  };

  const submit = () => {
    if (!confirm) return;
    const cleaned = reason.trim();
    setError(null);
    startTransition(async () => {
      // Actions return a { ok, message?, code? } result — they never
      // throw for authorization or state-machine refusals. We still
      // wrap in try/catch because the server-action runtime can throw
      // (e.g., redirect on session loss).
      try {
        let res: { ok: boolean; message?: string };
        if (confirm === "confirm") {
          res = await confirmRoomPaymentAction(
            participantId,
            row.accessPoint.id,
            cleaned || undefined
          );
        } else if (confirm === "refund") {
          res = await refundRoomPaymentAction(
            participantId,
            row.accessPoint.id,
            cleaned || undefined
          );
        } else {
          res = await cancelRoomRegistrationAction(
            participantId,
            row.accessPoint.id,
            cleaned || undefined
          );
        }
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

  const amount = fmtAmount(row.priceMinorSnapshot, row.currencySnapshot);
  const paSummary = accessSummary(row);
  const gates = statusGates(row.status);

  return (
    <li
      className={cn(
        "rounded-lg border p-4",
        gates.warn
          ? "border-amber-300/60 bg-amber-50/40"
          : "border-line bg-frost/40"
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
            <AdmissionBadge mode={row.accessPoint.admissionMode} />
          </p>
          {gates.warn && (
            <p className="mt-1 text-[11.5px] text-amber-900">{gates.warn}</p>
          )}
        </div>
        <div className="text-right">
          {isPaidMode ? (
            <>
              <p className="font-display text-xl font-black tabular-nums text-ink">
                {amount}
              </p>
              <p className="mt-0.5 text-[10.5px] uppercase tracking-[0.18em] text-ink/50">
                Montant figé à l&apos;inscription
              </p>
            </>
          ) : (
            <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink/50">
              Salle gratuite
            </p>
          )}
        </div>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Kv label="Inscription" value={fmtDate(row.registeredAt)} />
        {row.paidAt && <Kv label="Réglée le" value={fmtDate(row.paidAt)} />}
        {row.cancelledAt && (
          <Kv label="Annulée le" value={fmtDate(row.cancelledAt)} />
        )}
        {row.refundedAt && (
          <Kv label="Remboursée le" value={fmtDate(row.refundedAt)} />
        )}
        {row.failedAt && (
          <Kv label="Échec paiement" value={fmtDate(row.failedAt)} />
        )}
        {row.expiresAt && (
          <Kv label="Échéance" value={fmtDate(row.expiresAt)} />
        )}
        {row.paymentRef && (
          // Kept short: refs are trusted-provider correlation ids. Not
          // secret, but not something we want to publicly export.
          <Kv label="Référence" value={row.paymentRef} mono />
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
          Le remboursement ou l&apos;annulation ne modifie <em>jamais</em> un
          accès accordé par un administrateur (source ADMIN). Utilisez la
          matrice d&apos;accès pour les overrides admin.
        </p>
      </div>

      {(showConfirmBtn || showRefundBtn || showCancelBtn) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {showConfirmBtn && (
            <button
              type="button"
              disabled={pending || !!confirm}
              onClick={() => setConfirm("confirm")}
              className="inline-flex items-center gap-1.5 rounded-btn border border-cobalt bg-cobalt/10 px-3 py-1.5 text-[12px] font-bold text-cobalt transition-colors hover:bg-cobalt hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Confirmer le paiement
            </button>
          )}
          {showRefundBtn && (
            <button
              type="button"
              disabled={pending || !!confirm}
              onClick={() => setConfirm("refund")}
              className="inline-flex items-center gap-1.5 rounded-btn border border-amber-400 bg-amber-50 px-3 py-1.5 text-[12px] font-bold text-amber-900 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Rembourser
            </button>
          )}
          {showCancelBtn && (
            <button
              type="button"
              disabled={pending || !!confirm}
              onClick={() => setConfirm("cancel")}
              className="inline-flex items-center gap-1.5 rounded-btn border border-red-300 bg-red-50 px-3 py-1.5 text-[12px] font-bold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Annuler l&apos;inscription
            </button>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmationDialog
          action={confirm}
          isFree={isFreeMode}
          amount={amount}
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
  action,
  isFree,
  amount,
  roomName,
  reason,
  onReasonChange,
  pending,
  error,
  onCancel,
  onSubmit
}: {
  action: PendingAction;
  isFree: boolean;
  amount: string;
  roomName: string;
  reason: string;
  onReasonChange: (v: string) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const title = ACTION_TITLE[action];
  const description = ACTION_BODY[action](roomName, amount, isFree);
  const submitLabel = ACTION_SUBMIT[action];
  const submitTone = ACTION_TONE[action];

  return (
    <div
      role="dialog"
      aria-label={title}
      className="mt-4 rounded-lg border border-line bg-white p-4 shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]"
    >
      <p className="font-display text-[15px] font-black tracking-tight text-ink">
        {title}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/70">
        {description}
      </p>

      <label className="mt-3 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
        Motif (facultatif)
        <input
          type="text"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          maxLength={64}
          placeholder="Ex. : admin_confirm, admin_refund, no_show…"
          className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none transition-colors focus:border-cobalt"
        />
      </label>
      <p className="mt-1 text-[10.5px] leading-relaxed text-ink/45">
        Codes courts (ASCII, ≤ 64). Le motif figure dans l&apos;audit ; ne
        collez pas de données personnelles ni de référence de paiement.
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
          className={cn(
            "inline-flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-[12px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            submitTone
          )}
        >
          {pending ? "En cours…" : submitLabel}
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

const ACTION_TITLE: Record<PendingAction, string> = {
  confirm: "Confirmer le paiement de la salle ?",
  refund: "Rembourser cette inscription payée ?",
  cancel: "Annuler cette inscription ?"
};

const ACTION_SUBMIT: Record<PendingAction, string> = {
  confirm: "Confirmer le paiement",
  refund: "Confirmer le remboursement",
  cancel: "Confirmer l'annulation"
};

const ACTION_TONE: Record<PendingAction, string> = {
  confirm: "bg-cobalt hover:bg-cobalt-700",
  refund: "bg-amber-700 hover:bg-amber-800",
  cancel: "bg-red-700 hover:bg-red-800"
};

const ACTION_BODY: Record<
  PendingAction,
  (room: string, amount: string, isFree: boolean) => string
> = {
  confirm: (room, amount) =>
    `Marquer l'inscription à « ${room} » comme PAYÉE (${amount}). L'accès à la salle sera accordé immédiatement (source REGISTRATION). Le serveur relit le montant figé — la valeur affichée est celle qui sera enregistrée.`,
  refund: (room, amount) =>
    `Passer l'inscription à « ${room} » de PAYÉE → REMBOURSÉE. Cela révoque uniquement l'accès accordé par l'inscription. Un accès accordé manuellement par un admin (source ADMIN) reste actif. L'historique de check-in n'est pas modifié. Montant remboursé : ${amount}.`,
  cancel: (room, _amount, isFree) =>
    isFree
      ? `Annuler l'inscription gratuite à « ${room} ». L'accès accordé par l'inscription sera révoqué. Un accès admin éventuel reste actif. L'historique de check-in n'est pas modifié.`
      : `Annuler l'inscription à « ${room} ». Un accès éventuel accordé par l'inscription sera révoqué. Un accès admin éventuel reste actif. L'historique de check-in n'est pas modifié.`
};

function Kv({
  label,
  value,
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-[13px] font-semibold text-ink",
          mono && "font-mono text-[12px]"
        )}
      >
        {value}
      </dd>
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
  PENDING_PAYMENT: "En attente de paiement",
  FREE_CONFIRMED: "Gratuite confirmée",
  PAID: "Payée",
  PAYMENT_FAILED: "Paiement échoué",
  CANCELLED: "Annulée",
  REFUNDED: "Remboursée",
  EXPIRED: "Expirée"
};

const ROOM_STATUS_STYLE: Record<RoomRegistrationStatus, string> = {
  PENDING_PAYMENT: "bg-amber-100 text-amber-900",
  FREE_CONFIRMED: "bg-lime/25 text-ink",
  PAID: "bg-lime/25 text-ink",
  PAYMENT_FAILED: "bg-red-100 text-red-800",
  CANCELLED: "bg-ink/10 text-ink/70",
  REFUNDED: "bg-red-50 text-red-700",
  EXPIRED: "bg-ink/10 text-ink/60"
};

function AdmissionBadge({ mode }: { mode: AdmissionMode | null }) {
  if (!mode) return null;
  const cls =
    mode === AdmissionMode.PAID
      ? "bg-cobalt/10 text-cobalt"
      : "bg-ink/5 text-ink/60";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
        cls
      )}
    >
      {mode === AdmissionMode.PAID ? "Payante" : "Gratuite"}
    </span>
  );
}

// Text summary of the (potentially null) ParticipantAccess row plus the
// registration status. Never says "granted" for a PENDING_PAYMENT row,
// even if a stale grant somehow lingers — that would be misleading
// enough to warrant a call-out in the panel, so the display is honest.
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
  // source === ADMIN
  return {
    registration: "Non applicable (contrôlé par l'admin)",
    admin: pa.granted ? "Autorisé par l'admin" : "Refusé par l'admin"
  };
}

// Row-level warnings surfaced above the metadata block. Used to make
// visually-similar states unambiguous (PENDING_PAYMENT must NEVER look
// like PAID; REFUNDED / CANCELLED must NEVER look like PAID).
function statusGates(status: RoomRegistrationStatus): { warn: string | null } {
  switch (status) {
    case RoomRegistrationStatus.PENDING_PAYMENT:
      return {
        warn: "Le paiement n'est pas confirmé. Aucun accès à la salle n'est accordé pour l'instant."
      };
    case RoomRegistrationStatus.PAYMENT_FAILED:
      return { warn: "Le paiement a échoué. Aucun accès n'est accordé." };
    case RoomRegistrationStatus.EXPIRED:
      return {
        warn: "L'inscription a expiré. Aucun accès n'est accordé."
      };
    case RoomRegistrationStatus.REFUNDED:
      return {
        warn: "L'inscription a été remboursée. L'accès accordé par l'inscription est révoqué."
      };
    case RoomRegistrationStatus.CANCELLED:
      return {
        warn: "L'inscription est annulée. L'accès accordé par l'inscription est révoqué."
      };
    default:
      return { warn: null };
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

function fmtAmount(
  minor: number | null,
  currency: string | null
): string {
  if (minor === null || currency === null) return "—";
  // DZD is stored as integer minor units (whole dinars). Display uses
  // the French locale for grouping — matches the existing payment
  // panel formatter.
  const nf = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  });
  try {
    return nf.format(minor);
  } catch {
    return `${minor} ${currency}`;
  }
}

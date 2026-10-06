"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import {
  regenerateBadgeAsAdminAction,
  revokeBadgeAsAdminAction,
  viewBadgeQrAsAdminAction,
  type BadgeAdminQrResult
} from "./access-actions";
import type { BadgeStatus } from "@prisma/client";

// Admin badge panel.
//
// POLICY: a participant has ONE persistent QR; only administrators can
// replace it. This panel offers (each action re-checks its permission
// server-side — the props below are UX gating only):
//   • View the CURRENT QR (read-only, never rotates)   — `badge.view`
//   • Regenerate the QR (reason required)              — `badge.regenerate`
//   • Revoke the badge (durable)                       — `badge.manage`
// After a successful regeneration the NEW QR is shown here with download
// and print. The previous QR is never shown again.
export function BadgePanel({
  participantId,
  activeCredential,
  canManage,
  canRegenerate,
  canView
}: {
  participantId: string;
  activeCredential: {
    id: string;
    status: BadgeStatus;
    issuedAt: Date;
    expiresAt: Date | null;
  } | null;
  canManage: boolean;
  canRegenerate: boolean;
  canView: boolean;
}) {
  const [confirm, setConfirm] = useState<null | "regenerate" | "revoke">(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrNote, setQrNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const closeConfirm = () => {
    setConfirm(null);
    setReason("");
    setError(null);
  };

  const applyQrResult = (res: BadgeAdminQrResult, note: string) => {
    if (res.ok) {
      setQr(res.qrDataUrl);
      setQrNote(note);
      setError(null);
      return true;
    }
    setError(res.message);
    return false;
  };

  const viewCurrent = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await viewBadgeQrAsAdminAction(participantId);
        applyQrResult(res, "QR actuel (lecture seule — aucune modification).");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action refusée.");
      }
    });
  };

  const submit = () => {
    if (!confirm) return;
    setError(null);
    startTransition(async () => {
      try {
        if (confirm === "regenerate") {
          const res = await regenerateBadgeAsAdminAction(
            participantId,
            reason,
            activeCredential?.id ?? null
          );
          if (applyQrResult(res, "Nouveau QR généré. L'ancien QR est révoqué.")) {
            closeConfirm();
          }
        } else {
          const res = await revokeBadgeAsAdminAction(
            participantId,
            reason,
            activeCredential?.id ?? null
          );
          if (res.ok) {
            setQr(null);
            setQrNote(null);
            closeConfirm();
          } else {
            setError(res.message);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action refusée.");
      }
    });
  };

  const printQr = () => {
    if (!qr) return;
    const w = window.open("", "_blank", "width=480,height=560");
    if (!w) return;
    const img = w.document.createElement("img");
    img.src = qr;
    img.style.width = "360px";
    img.style.height = "360px";
    img.style.display = "block";
    img.style.margin = "40px auto";
    w.document.body.appendChild(img);
    img.onload = () => {
      w.focus();
      w.print();
    };
  };

  const reasonOk = reason.trim().length >= 5;

  return (
    <section className="rounded-card border border-line bg-white p-6">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Badge digital
      </p>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="font-display text-2xl font-black tracking-tight text-ink">
            {activeCredential
              ? statusLabel(activeCredential.status)
              : "Aucun credential actif"}
          </p>
          {activeCredential && (
            <p className="mt-1 text-[12.5px] text-ink/60">
              Émis le {fmt(activeCredential.issuedAt)}
              {activeCredential.expiresAt &&
                ` · expire le ${fmt(activeCredential.expiresAt)}`}
            </p>
          )}
        </div>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
            activeCredential
              ? "bg-lime/25 text-ink"
              : "bg-ink/10 text-ink/70"
          )}
        >
          {activeCredential ? "ACTIVE" : "AUCUN"}
        </span>
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-ink/55">
        Le participant possède un QR permanent qu&apos;il peut seulement
        afficher ; il ne peut pas le régénérer. Seule l&apos;administration
        peut le remplacer. Toutes les opérations sont enregistrées dans le
        journal d&apos;audit.
      </p>

      {(canManage || canRegenerate || canView) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {canView && (
          <button
            type="button"
            disabled={pending || !activeCredential}
            onClick={viewCurrent}
            className="inline-flex items-center gap-1.5 rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-60"
          >
            Afficher le QR actuel
          </button>
          )}
          {canRegenerate && (
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirm("regenerate")}
              className="inline-flex items-center gap-1.5 rounded-btn border border-cobalt bg-cobalt/10 px-3 py-1.5 text-[12px] font-bold text-cobalt transition-colors hover:bg-cobalt hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Régénérer le QR
            </button>
          )}
          {canManage && (
          <button
            type="button"
            disabled={pending || !activeCredential}
            onClick={() => setConfirm("revoke")}
            className="inline-flex items-center gap-1.5 rounded-btn border border-red-300 bg-red-50 px-3 py-1.5 text-[12px] font-bold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Révoquer le badge
          </button>
          )}
        </div>
      )}

      {error && !confirm && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
        >
          {error}
        </p>
      )}

      {qr && (
        <div className="mt-5 rounded-lg border border-line bg-frost/60 p-4">
          {qrNote && (
            <p className="text-[12px] font-semibold text-ink">{qrNote}</p>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qr}
            alt="QR code du participant"
            width={220}
            height={220}
            className="mt-3 rounded bg-white p-2"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={qr}
              download={`bis-qr-${participantId}.png`}
              className="inline-flex items-center gap-1.5 rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink hover:border-cobalt hover:text-cobalt"
            >
              Télécharger PNG
            </a>
            <button
              type="button"
              onClick={printQr}
              className="inline-flex items-center gap-1.5 rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink hover:border-cobalt hover:text-cobalt"
            >
              Imprimer
            </button>
            <button
              type="button"
              onClick={() => {
                setQr(null);
                setQrNote(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink"
            >
              Masquer
            </button>
          </div>
        </div>
      )}

      {confirm && (
        <div
          role="dialog"
          aria-label={
            confirm === "regenerate"
              ? "Confirmer la régénération du QR"
              : "Confirmer la révocation du badge"
          }
          className="mt-5 rounded-lg border border-line bg-frost/60 p-4"
        >
          <p className="text-[13px] font-semibold text-ink">
            {confirm === "regenerate"
              ? "Régénérer le QR de ce participant ?"
              : "Révoquer immédiatement ce badge ?"}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink/65">
            {confirm === "regenerate"
              ? "Regenerating this QR permanently invalidates the previous QR. Le code de secours imprimé sur le badge est aussi remplacé. Le participant garde le même compte et le même historique ; le nouveau QR s'affichera sur sa page badge. L'accès manuel par ticket (flux legacy) n'est pas modifié."
              : "Aucun scan ne sera plus accepté avec ce QR et le code de secours est bloqué. Le participant ne peut pas se réémettre un badge : seule l'administration peut en créer un nouveau. L'accès manuel par ticket (flux legacy) n'est pas modifié."}
          </p>
          <label className="mt-3 block text-[11px] font-bold uppercase tracking-[0.18em] text-ink/55">
            {confirm === "regenerate" ? "Motif (obligatoire)" : "Motif (facultatif)"}
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="Ex. : QR volé, appareil perdu…"
              className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none transition-colors focus:border-cobalt"
            />
          </label>
          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
            >
              {error}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={pending || (confirm === "regenerate" && !reasonOk)}
              onClick={submit}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-[12px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                confirm === "regenerate"
                  ? "bg-cobalt hover:bg-cobalt-700"
                  : "bg-red-700 hover:bg-red-800"
              )}
            >
              {pending
                ? "En cours…"
                : confirm === "regenerate"
                  ? "Confirmer la régénération"
                  : "Confirmer la révocation"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={closeConfirm}
              className="inline-flex items-center gap-1.5 rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function statusLabel(s: BadgeStatus): string {
  switch (s) {
    case "ACTIVE":
      return "Badge actif";
    case "PENDING":
      return "Badge en attente";
    case "REVOKED":
      return "Badge révoqué";
    case "EXPIRED":
      return "Badge expiré";
  }
}

function fmt(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

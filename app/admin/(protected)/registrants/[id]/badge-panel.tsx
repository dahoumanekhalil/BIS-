"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import {
  revokeBadgeAsAdminAction,
  rotateBadgeAsAdminAction
} from "./access-actions";
import type { BadgeStatus } from "@prisma/client";

// Admin badge panel. Renders the ACTIVE credential state and — if the
// current admin holds `badge.manage` (gated at the parent, `canManage`
// prop) — offers Rotate / Revoke actions. Both actions require a short
// motif; the actions apply Zod validation server-side (length cap +
// token-shape reject) so a paste of a raw credential into `reason`
// cannot land in AuditLog.
//
// Neither action returns the raw token to the admin; rotation is a
// server-only credential swap. Copy makes that explicit.
export function BadgePanel({
  participantId,
  activeCredential,
  canManage
}: {
  participantId: string;
  activeCredential: {
    status: BadgeStatus;
    issuedAt: Date;
    expiresAt: Date | null;
  } | null;
  canManage: boolean;
}) {
  const [confirm, setConfirm] = useState<null | "rotate" | "revoke">(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const closeConfirm = () => {
    setConfirm(null);
    setReason("");
    setError(null);
  };

  const submit = () => {
    if (!confirm) return;
    setError(null);
    startTransition(async () => {
      try {
        if (confirm === "rotate") {
          await rotateBadgeAsAdminAction(participantId, reason);
        } else {
          await revokeBadgeAsAdminAction(participantId, reason);
        }
        closeConfirm();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action refusée.");
      }
    });
  };

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
        Les rotations et révocations sont enregistrées dans le journal
        d&apos;audit. Le rawToken n&apos;est jamais renvoyé à
        l&apos;administrateur — le participant verra son nouveau QR à sa
        prochaine visite sur /compte/badge.
      </p>

      {canManage && (
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirm("rotate")}
            className="inline-flex items-center gap-1.5 rounded-btn border border-cobalt bg-cobalt/10 px-3 py-1.5 text-[12px] font-bold text-cobalt transition-colors hover:bg-cobalt hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Faire tourner le credential
          </button>
          <button
            type="button"
            disabled={pending || !activeCredential}
            onClick={() => setConfirm("revoke")}
            className="inline-flex items-center gap-1.5 rounded-btn border border-red-300 bg-red-50 px-3 py-1.5 text-[12px] font-bold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Révoquer le badge
          </button>
        </div>
      )}

      {confirm && (
        <div
          role="dialog"
          aria-label={
            confirm === "rotate"
              ? "Confirmer la rotation du credential"
              : "Confirmer la révocation du badge"
          }
          className="mt-5 rounded-lg border border-line bg-frost/60 p-4"
        >
          <p className="text-[13px] font-semibold text-ink">
            {confirm === "rotate"
              ? "Faire tourner ce credential ?"
              : "Révoquer immédiatement ce badge ?"}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink/65">
            {confirm === "rotate"
              ? "L'ancien QR est invalidé instantanément. Un nouveau credential est créé côté serveur ; le participant devra ouvrir /compte/badge pour l'afficher."
              : "Aucun scan ne sera plus accepté avec l'ancien QR. Le participant devra générer un nouveau credential."}
          </p>
          <label className="mt-3 block text-[11px] font-bold uppercase tracking-[0.18em] text-ink/55">
            Motif (facultatif)
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
              disabled={pending}
              onClick={submit}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-[12px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                confirm === "rotate" ? "bg-cobalt hover:bg-cobalt-700" : "bg-red-700 hover:bg-red-800"
              )}
            >
              {pending
                ? "En cours…"
                : confirm === "rotate"
                  ? "Confirmer la rotation"
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

"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import {
  deleteAccessPointAction,
  toggleAccessPointActiveAction,
  updateAccessPointNameAction,
  updateAccessPointOrderAction,
  updateAccessPointSlugAction
} from "./actions";
import type { AccessPointType } from "@prisma/client";

// One row in the AccessPoints admin table. Click-to-edit pattern: the
// row shows a static summary until the admin opens the inline editor
// with "Modifier". Every field has its own action + guard rules — a
// slug rename is refused server-side when checkInCount > 0 (UI hides
// the input in that case).
export type PointRowData = {
  id: string;
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  order: number;
  checkInCount: number;
  permissionCount: number;
};

export function PointRow({
  point,
  canManage
}: {
  point: PointRowData;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(point.name);
  const [slug, setSlug] = useState(point.slug);
  const [order, setOrder] = useState(String(point.order));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const slugLocked = point.checkInCount > 0;
  const deleteBlocked =
    point.checkInCount > 0 || point.permissionCount > 0;

  const saveAll = () =>
    startTransition(async () => {
      setError(null);
      const errors: string[] = [];

      if (name !== point.name) {
        const r = await updateAccessPointNameAction(point.id, name);
        if (!r.ok) errors.push(r.message);
      }
      if (slug !== point.slug) {
        const r = await updateAccessPointSlugAction(point.id, slug);
        if (!r.ok) errors.push(r.message);
      }
      if (order !== String(point.order)) {
        const r = await updateAccessPointOrderAction(point.id, Number(order));
        if (!r.ok) errors.push(r.message);
      }

      if (errors.length > 0) {
        setError(errors.join(" · "));
        return;
      }
      setEditing(false);
    });

  const toggleActive = () =>
    startTransition(async () => {
      setError(null);
      const r = await toggleAccessPointActiveAction(point.id, !point.active);
      if (!r.ok) setError(r.message);
    });

  const doDelete = () =>
    startTransition(async () => {
      setError(null);
      const r = await deleteAccessPointAction(point.id);
      if (!r.ok) {
        setError(r.message);
        setConfirmingDelete(false);
      }
    });

  return (
    <li
      className={cn(
        "rounded-card border bg-white p-4 transition-colors",
        point.active ? "border-line" : "border-ink/15 opacity-70"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="font-display text-[17px] font-black tracking-tight text-ink">
              {point.name}
            </p>
            <span className="rounded-full bg-ink/5 px-2 py-[2px] font-mono text-[10.5px] font-semibold text-ink/60">
              {point.slug}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
                point.type === "MAIN_ENTRANCE"
                  ? "bg-cobalt/15 text-cobalt"
                  : "bg-lime/25 text-ink"
              )}
            >
              {point.type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle"}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
                point.active
                  ? "bg-lime/25 text-ink"
                  : "bg-ink/10 text-ink/60"
              )}
            >
              {point.active ? "Actif" : "Désactivé"}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] text-ink/55">
            Ordre {point.order} · {point.checkInCount} check-in
            {point.checkInCount === 1 ? "" : "s"} · {point.permissionCount}{" "}
            permission{point.permissionCount === 1 ? "" : "s"}
          </p>
          {/* Phase 16 — cross-links to the scanner + the filtered history.
              These are navigational only; the server-side scanner route
              and history route each re-check their own permission before
              rendering. Hiding these links here is UX only. The "Ouvrir
              le scanner" link is disabled when the AP is inactive so the
              operator sees the same refusal state the scanner shell
              would return anyway. */}
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            {point.active ? (
              <Link
                href={`/admin/scan/${point.slug}`}
                className="font-semibold text-cobalt hover:underline"
              >
                Ouvrir le scanner →
              </Link>
            ) : (
              <span className="font-semibold text-ink/40">
                Ouvrir le scanner — point désactivé
              </span>
            )}
            <Link
              href={`/admin/scan/history?accessPointId=${encodeURIComponent(point.id)}`}
              className="font-semibold text-ink/70 hover:text-cobalt hover:underline"
            >
              Voir l&apos;historique →
            </Link>
          </p>
        </div>
        {canManage && !editing && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => setEditing(true)}
              className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-60"
            >
              Modifier
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={toggleActive}
              className={cn(
                "inline-flex items-center rounded-btn px-3 py-1.5 text-[12px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                point.active
                  ? "border border-ink/15 bg-white text-ink hover:border-amber-500 hover:text-amber-800"
                  : "border border-cobalt bg-cobalt/10 text-cobalt hover:bg-cobalt hover:text-white"
              )}
            >
              {point.active ? "Désactiver" : "Réactiver"}
            </button>
            <button
              type="button"
              disabled={pending || deleteBlocked}
              title={
                deleteBlocked
                  ? "Suppression refusée : références historiques. Désactivez à la place."
                  : "Supprimer définitivement"
              }
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center rounded-btn border border-red-300 bg-red-50 px-3 py-1.5 text-[12px] font-bold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Supprimer
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
              Nom
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
              />
            </label>
            <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
              Slug
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                maxLength={48}
                disabled={slugLocked}
                className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-cobalt disabled:cursor-not-allowed disabled:bg-frost disabled:opacity-70"
              />
              {slugLocked && (
                <span className="mt-1 block text-[10px] font-normal normal-case tracking-normal text-ink/55">
                  Verrouillé — des check-ins référencent ce point.
                </span>
              )}
            </label>
            <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
              Ordre
              <input
                type="number"
                value={order}
                onChange={(e) => setOrder(e.target.value)}
                min={0}
                max={999}
                className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
              />
            </label>
          </div>
          <p className="text-[11px] leading-relaxed text-ink/55">
            Le type ({point.type === "MAIN_ENTRANCE" ? "Entrée" : "Salle"})
            n&apos;est pas modifiable : le changer inverserait la logique
            de validation pour tout historique existant.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={saveAll}
              className="inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Enregistrement…" : "Enregistrer"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setError(null);
                setName(point.name);
                setSlug(point.slug);
                setOrder(String(point.order));
              }}
              className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <div
          role="dialog"
          aria-label={`Confirmer la suppression de ${point.name}`}
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3"
        >
          <p className="text-[13px] font-semibold text-red-900">
            Supprimer définitivement « {point.name} » ?
          </p>
          <p className="mt-1 text-[12px] text-red-900/80">
            Cette action est destructive. Aucune donnée historique
            n&apos;existe pour ce point — la suppression est réversible
            uniquement en recréant le point manuellement.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={doDelete}
              className="inline-flex items-center rounded-btn bg-red-700 px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Confirmer la suppression
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmingDelete(false)}
              className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
        >
          {error}
        </p>
      )}
    </li>
  );
}

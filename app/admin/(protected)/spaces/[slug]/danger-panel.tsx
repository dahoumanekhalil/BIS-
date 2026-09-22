"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteSpaceAction, toggleSpaceActiveAction } from "../actions";
import { cn } from "@/lib/utils";

// Phase 17 — deactivate + delete controls. Only mounted when the
// admin holds `settings.manage` (canManage) — the parent page gates
// this. Server actions re-check the permission.

type Props = {
  space: {
    id: string;
    slug: string;
    name: string;
    active: boolean;
    deletable: boolean;
  };
};

export function DangerPanel({ space }: Props) {
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = () =>
    startTransition(async () => {
      setError(null);
      const r = await toggleSpaceActiveAction(space.id, !space.active);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    });

  const doDelete = () =>
    startTransition(async () => {
      setError(null);
      const r = await deleteSpaceAction(space.id);
      if (!r.ok) {
        setError(r.message);
        setConfirmingDelete(false);
        return;
      }
      // Space no longer exists — go back to the list.
      router.push("/admin/spaces");
    });

  return (
    <section className="rounded-card border border-ink/10 bg-white p-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Opérations sensibles
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          className={cn(
            "inline-flex items-center rounded-btn px-4 py-2 text-[12.5px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            space.active
              ? "border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
              : "border border-cobalt bg-cobalt/10 text-cobalt hover:bg-cobalt hover:text-white"
          )}
        >
          {pending
            ? "…"
            : space.active
              ? "Désactiver cet espace"
              : "Réactiver cet espace"}
        </button>
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          disabled={pending || !space.deletable}
          title={
            !space.deletable
              ? "Suppression refusée : des check-ins ou des permissions référencent cet espace. Désactivez-le à la place."
              : "Supprimer définitivement"
          }
          className="inline-flex items-center rounded-btn border border-red-300 bg-red-50 px-4 py-2 text-[12.5px] font-bold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Supprimer
        </button>
      </div>

      {!space.deletable && (
        <p className="mt-2 text-[11.5px] italic text-ink/50">
          La suppression est bloquée tant que cet espace comporte des
          check-ins ou des autorisations. Utilisez « Désactiver » pour
          le retirer opérationnellement.
        </p>
      )}

      {confirmingDelete && space.deletable && (
        <div
          role="dialog"
          aria-label={`Confirmer la suppression de ${space.name}`}
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3"
        >
          <p className="text-[13px] font-semibold text-red-900">
            Supprimer définitivement « {space.name} » ?
          </p>
          <p className="mt-1 text-[12px] text-red-900/80">
            Aucune donnée historique n&apos;existe pour cet espace. La
            suppression est réversible uniquement en recréant l&apos;espace
            manuellement.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={doDelete}
              disabled={pending}
              className="inline-flex items-center rounded-btn bg-red-700 px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Confirmer la suppression
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={pending}
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
    </section>
  );
}

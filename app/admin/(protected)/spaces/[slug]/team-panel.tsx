"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addTeamMemberAction, removeTeamMemberAction } from "../actions";
import { cn } from "@/lib/utils";

type Props = {
  space: { id: string; slug: string; name: string };
  team: Array<{
    adminUserId: string;
    assignedAt: Date;
    user: {
      id: string;
      name: string;
      email: string;
      role: string;
      status: string;
    };
  }>;
  assignable: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>;
  canManage: boolean;
};

export function TeamPanel({ space, team, assignable, canManage }: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const add = () =>
    startTransition(async () => {
      setError(null);
      if (!selectedId) return;
      const r = await addTeamMemberAction(space.id, selectedId);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setSelectedId("");
      router.refresh();
    });

  const remove = (adminUserId: string) =>
    startTransition(async () => {
      setError(null);
      const r = await removeTeamMemberAction(space.id, adminUserId);
      if (!r.ok) {
        setError(r.message);
        setConfirmRemoveId(null);
        return;
      }
      setConfirmRemoveId(null);
      router.refresh();
    });

  const dt = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    }).format(new Date(d));

  return (
    <section className="rounded-card border border-line bg-white p-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Équipe check-in
      </p>
      <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-ink/60">
        Personnel affecté à cet espace. <strong>Note :</strong>{" "}
        l&apos;appartenance à une équipe est une association
        organisationnelle. Elle n&apos;accorde pas automatiquement le
        droit de scanner : les permissions{" "}
        <code className="rounded bg-ink/5 px-1 font-mono text-[11px]">
          access.validate.main
        </code>{" "}
        et{" "}
        <code className="rounded bg-ink/5 px-1 font-mono text-[11px]">
          access.validate.room
        </code>{" "}
        (Phase 3) restent la source d&apos;autorisation côté serveur.
      </p>

      {team.length === 0 ? (
        <p className="mt-4 text-[13px] italic text-ink/55">
          Aucun membre affecté pour l&apos;instant.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {team.map((m) => (
            <li
              key={m.adminUserId}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13px]"
            >
              <div className="min-w-0">
                <p className="font-semibold text-ink">{m.user.name}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink/55">
                  <span>{m.user.email}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
                      "bg-cobalt/15 text-cobalt"
                    )}
                  >
                    {m.user.role.replace(/_/g, " ")}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
                      m.user.status === "ACTIVE"
                        ? "bg-lime/25 text-ink"
                        : "bg-amber-100 text-amber-900"
                    )}
                  >
                    {m.user.status === "ACTIVE" ? "Actif" : "Inactif"}
                  </span>
                  <span>· Affecté le {dt(m.assignedAt)}</span>
                </p>
              </div>
              {canManage && (
                <>
                  {confirmRemoveId === m.adminUserId ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => remove(m.adminUserId)}
                        disabled={pending}
                        className="inline-flex items-center rounded-btn bg-red-700 px-3 py-1.5 text-[11.5px] font-bold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Confirmer le retrait
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(null)}
                        disabled={pending}
                        className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[11.5px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(m.adminUserId)}
                      className="inline-flex items-center rounded-btn border border-red-200 bg-red-50 px-3 py-1.5 text-[11.5px] font-bold text-red-800 transition-colors hover:bg-red-100"
                      title="Retirer de l'équipe (n'affecte pas le compte utilisateur)"
                    >
                      Retirer
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
          <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
            Ajouter un membre
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={pending || assignable.length === 0}
              className="mt-1.5 block w-72 max-w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">
                {assignable.length === 0
                  ? "— Aucun utilisateur éligible —"
                  : "— Sélectionner un utilisateur —"}
              </option>
              {assignable.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.role.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={add}
            disabled={pending || !selectedId}
            className="inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Ajout…" : "Ajouter"}
          </button>
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

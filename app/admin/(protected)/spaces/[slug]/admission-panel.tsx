"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AccessPointType } from "@prisma/client";
import { updateSpaceAdmissionAction } from "../actions";
import { cn } from "@/lib/utils";

type Props = {
  space: {
    id: string;
    admissionMode: "FREE" | "PAID" | null;
    type: AccessPointType;
  };
  canManage: boolean;
};

export function AdmissionPanel({ space, canManage }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"" | "FREE" | "PAID">(
    space.admissionMode ?? ""
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await updateSpaceAdmissionAction(space.id, mode || null);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    });

  return (
    <section className="rounded-card border border-line bg-white p-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Politique d&apos;admission
      </p>
      <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-ink/60">
        Étiquette d&apos;affichage pour cet espace. <strong>Note importante :</strong>{" "}
        cette étiquette est métadonnée uniquement. La règle
        d&apos;accès effective (paiement + autorisations) reste celle
        du validateur d&apos;accès (Phase 11) : un espace « Gratuit »
        n&apos;autorise pas automatiquement des participants non payés,
        et un espace « Payant » applique les règles paiement/matrice
        d&apos;accès habituelles.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Mode
          <select
            value={mode}
            onChange={(e) =>
              setMode(e.target.value as "" | "FREE" | "PAID")
            }
            disabled={!canManage || pending}
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">Non défini</option>
            <option value="FREE">Gratuit</option>
            <option value="PAID">Payant</option>
          </select>
        </label>

        {canManage && (
          <button
            type="button"
            onClick={save}
            disabled={pending || mode === (space.admissionMode ?? "")}
            className={cn(
              "inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {pending ? "Enregistrement…" : "Appliquer"}
          </button>
        )}
      </div>

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

"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { updateApplication, type UpdateApplicationState } from "./actions";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABEL,
  type ApplicationStatusKey
} from "@/lib/applications";

const initial: UpdateApplicationState = { status: "idle" };

export function StatusForm({
  applicationId,
  currentStatus,
  currentNotes
}: {
  applicationId: string;
  currentStatus: ApplicationStatusKey;
  currentNotes: string;
}) {
  const [state, formAction] = useActionState(
    updateApplication.bind(null, applicationId),
    initial
  );

  return (
    <form action={formAction} className="rounded-card border border-line bg-white p-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        Décision
      </p>

      <label className="mt-3 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/60">
        Statut
      </label>
      <select
        name="status"
        defaultValue={currentStatus}
        className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] outline-none transition-colors focus:border-cobalt"
      >
        {APPLICATION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {APPLICATION_STATUS_LABEL[s]}
          </option>
        ))}
      </select>

      <label className="mt-4 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/60">
        Notes internes
      </label>
      <textarea
        name="reviewNotes"
        defaultValue={currentNotes}
        rows={4}
        maxLength={4000}
        placeholder="Contexte, décision, prochaines étapes…"
        className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] leading-relaxed outline-none transition-colors focus:border-cobalt"
      />

      {state.status === "success" && (
        <p className="mt-3 rounded-btn border border-lime/30 bg-lime/10 px-3 py-2 text-[12.5px] text-ink">
          {state.message}
        </p>
      )}
      {state.status === "error" && (
        <p className="mt-3 rounded-btn border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
          {state.message}
        </p>
      )}

      <SaveButton />
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-btn bg-ink px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-navy disabled:opacity-60"
    >
      {pending ? "Enregistrement…" : "Enregistrer la décision"}
    </button>
  );
}

"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { createAccessPointAction } from "./actions";

// Inline "New access point" form. Collapsed by default (small footprint on
// a page that mostly lists existing points). Opens when the admin clicks
// "Nouveau point d'accès". Type is a required select — MAIN_ENTRANCE or
// ROOM — because it is create-only per Phase 8 policy.
export function CreateAccessPointForm() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (formData: FormData) => {
    startTransition(async () => {
      setError(null);
      const result = await createAccessPointAction(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      // Reset field state via form re-mount on next render — nothing to
      // do here explicitly; the form element unmounts when `open` flips.
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-btn border border-cobalt bg-cobalt/10 px-4 py-2 text-[13px] font-bold text-cobalt transition-colors hover:bg-cobalt hover:text-white"
      >
        + Nouveau point d&apos;accès
      </button>
    );
  }

  return (
    <form
      action={handleSubmit}
      className="rounded-card border border-line bg-white p-5"
    >
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Nouveau point d&apos;accès
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55 sm:col-span-2">
          Nom
          <input
            type="text"
            name="name"
            required
            maxLength={80}
            placeholder="Ex. : Salle 06"
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
          />
        </label>
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Slug
          <input
            type="text"
            name="slug"
            required
            maxLength={48}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            placeholder="room-06"
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-cobalt"
          />
          <span className="mt-1 block text-[10px] font-normal normal-case tracking-normal text-ink/55">
            Utilisé dans les URLs de scanner (Phase 9).
          </span>
        </label>
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Type
          <select
            name="type"
            required
            defaultValue="ROOM"
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
          >
            <option value="ROOM">Salle</option>
            <option value="MAIN_ENTRANCE">Entrée principale</option>
          </select>
        </label>
      </div>
      <label className="mt-3 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
        Ordre (affichage)
        <input
          type="number"
          name="order"
          defaultValue={0}
          min={0}
          max={999}
          className="mt-1.5 block w-24 rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
        />
      </label>

      {error && (
        <p
          role="alert"
          className={cn(
            "mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
          )}
        >
          {error}
        </p>
      )}

      <div className="mt-5 flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Création…" : "Créer le point d'accès"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}

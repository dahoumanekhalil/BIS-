"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSpaceAction } from "./actions";
import { cn } from "@/lib/utils";

export function CreateSpaceForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState<"MAIN_ENTRANCE" | "ROOM">("ROOM");
  const [description, setDescription] = useState("");
  const [order, setOrder] = useState("0");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("name", name);
      fd.set("slug", slug);
      fd.set("type", type);
      fd.set("description", description);
      fd.set("order", order);
      const r = await createSpaceAction(fd);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      // Navigate to the new space's detail page.
      router.push(`/admin/spaces/${encodeURIComponent(r.slug)}`);
    });
  };

  if (!open) {
    return (
      <section className="rounded-card border border-dashed border-line bg-white p-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-btn bg-cobalt px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-cobalt-700"
        >
          Créer un espace →
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-card border border-line bg-white p-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Nouvel espace
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Nom
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
          />
        </label>
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Slug technique
          <input
            type="text"
            required
            maxLength={48}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="salle-06"
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 font-mono text-[13px] normal-case tracking-normal text-ink outline-none focus:border-cobalt"
          />
          <span className="mt-1 block text-[10px] font-normal normal-case tracking-normal text-ink/55">
            Minuscules / chiffres / tirets. Utilisé dans l&apos;URL du
            scanner : /admin/scan/&lt;slug&gt;.
          </span>
        </label>
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Type
          <select
            value={type}
            onChange={(e) =>
              setType(e.target.value as "MAIN_ENTRANCE" | "ROOM")
            }
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
          >
            <option value="ROOM">Salle</option>
            <option value="MAIN_ENTRANCE">Entrée principale</option>
          </select>
          <span className="mt-1 block text-[10px] font-normal normal-case tracking-normal text-ink/55">
            Figé après création. Le changer inverserait la logique de
            validation.
          </span>
        </label>
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Ordre d&apos;affichage
          <input
            type="number"
            min={0}
            max={999}
            value={order}
            onChange={(e) => setOrder(e.target.value)}
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
          />
        </label>
        <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55 sm:col-span-2">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
            rows={3}
            className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
          />
        </label>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900 sm:col-span-2"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className={cn(
              "inline-flex items-center rounded-btn bg-cobalt px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {pending ? "Création…" : "Créer l'espace"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            disabled={pending}
            className="inline-flex items-center rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Annuler
          </button>
        </div>
      </form>
    </section>
  );
}

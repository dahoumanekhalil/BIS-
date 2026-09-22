"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import {
  updateSpaceNameAction,
  updateSpaceSlugAction,
  updateSpaceDescriptionAction,
  updateSpaceOrderAction
} from "../actions";

type Props = {
  space: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    order: number;
    slugLocked: boolean;
  };
  canManage: boolean;
};

export function IdentityPanel({ space, canManage }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(space.name);
  const [slug, setSlug] = useState(space.slug);
  const [description, setDescription] = useState(space.description ?? "");
  const [order, setOrder] = useState(String(space.order));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const errs: string[] = [];
      if (name !== space.name) {
        const r = await updateSpaceNameAction(space.id, name);
        if (!r.ok) errs.push(r.message);
      }
      if (slug !== space.slug) {
        const r = await updateSpaceSlugAction(space.id, slug);
        if (!r.ok) errs.push(r.message);
      }
      if ((description || "") !== (space.description || "")) {
        const r = await updateSpaceDescriptionAction(space.id, description);
        if (!r.ok) errs.push(r.message);
      }
      if (order !== String(space.order)) {
        const r = await updateSpaceOrderAction(space.id, Number(order));
        if (!r.ok) errs.push(r.message);
      }
      if (errs.length > 0) {
        setError(errs.join(" · "));
        return;
      }
      setEditing(false);
      // If the slug changed, the URL is now stale — navigate to the new one.
      if (slug !== space.slug) {
        router.push(`/admin/spaces/${encodeURIComponent(slug)}`);
      }
      router.refresh();
    });

  return (
    <section className="rounded-card border border-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Identité
          </p>
          {!editing && (
            <div className="mt-3 space-y-2">
              <p className="font-display text-lg font-black tracking-tight text-ink">
                {space.name}
              </p>
              <p className="font-mono text-[11.5px] text-ink/55">
                /{space.slug}
              </p>
              {space.description ? (
                <p className="max-w-2xl text-[13px] leading-relaxed text-ink/70">
                  {space.description}
                </p>
              ) : (
                <p className="text-[12px] italic text-ink/45">
                  Aucune description saisie.
                </p>
              )}
              <p className="text-[11.5px] text-ink/55">
                Ordre d&apos;affichage : {space.order}
              </p>
            </div>
          )}
        </div>
        {canManage && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
          >
            Modifier
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
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
              disabled={space.slugLocked}
              className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-1.5 font-mono text-[13px] normal-case tracking-normal text-ink outline-none focus:border-cobalt disabled:cursor-not-allowed disabled:bg-frost disabled:opacity-70"
            />
            {space.slugLocked && (
              <span className="mt-1 block text-[10px] font-normal normal-case tracking-normal text-ink/55">
                Verrouillé — des check-ins référencent cet espace.
              </span>
            )}
          </label>
          <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
            Ordre
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
              rows={4}
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
              type="button"
              onClick={save}
              disabled={pending}
              className={cn(
                "inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
              )}
            >
              {pending ? "Enregistrement…" : "Enregistrer"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setError(null);
                setName(space.name);
                setSlug(space.slug);
                setDescription(space.description ?? "");
                setOrder(String(space.order));
              }}
              className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

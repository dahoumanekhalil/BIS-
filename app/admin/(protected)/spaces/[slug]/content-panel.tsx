"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  updateSpaceActivitiesAction,
  updateSpaceTopicsAction,
  updateSpaceExhibitorsAction
} from "../actions";
import { cn } from "@/lib/utils";
import type {
  SpaceActivity,
  SpaceExhibitor,
  SpaceTopic
} from "@/lib/admin/space-content";

// Phase 17 — content editor for the three lightweight JSON lists
// (activities / topics / exhibitors). Each list is stored as a JSON
// array on AccessPoint and validated by Zod inside the server action.
// UI pattern: local edit state, "Enregistrer" replaces the entire
// list atomically. NOOPs (byte-identical payloads) skip the audit
// server-side.

type Props = {
  space: {
    id: string;
    activities: SpaceActivity[];
    topics: SpaceTopic[];
    exhibitors: SpaceExhibitor[];
  };
  canManage: boolean;
};

export function ContentPanel({ space, canManage }: Props) {
  return (
    <section className="space-y-6">
      <ActivitiesEditor
        id={space.id}
        initial={space.activities}
        canManage={canManage}
      />
      <TopicsEditor
        id={space.id}
        initial={space.topics}
        canManage={canManage}
      />
      <ExhibitorsEditor
        id={space.id}
        initial={space.exhibitors}
        canManage={canManage}
      />
    </section>
  );
}

// ─── Activities ──────────────────────────────────────────────────────────

function ActivitiesEditor({
  id,
  initial,
  canManage
}: {
  id: string;
  initial: SpaceActivity[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<SpaceActivity[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await updateSpaceActivitiesAction(id, items);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    });

  return (
    <div className="rounded-card border border-line bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Activités
        </p>
        <p className="text-[11px] text-ink/50">{items.length} entrée{items.length === 1 ? "" : "s"}</p>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-[13px] italic text-ink/55">
          Aucune activité enregistrée.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((a, i) => (
            <li
              key={i}
              className="rounded-lg border border-line bg-frost/50 p-3"
            >
              {canManage ? (
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="grid gap-2">
                    <input
                      type="text"
                      value={a.title}
                      onChange={(e) => {
                        const next = [...items];
                        next[i] = { ...a, title: e.target.value };
                        setItems(next);
                      }}
                      maxLength={120}
                      placeholder="Titre de l'activité"
                      className="rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-cobalt"
                    />
                    <textarea
                      value={a.description ?? ""}
                      onChange={(e) => {
                        const next = [...items];
                        next[i] = {
                          ...a,
                          description: e.target.value || undefined
                        };
                        setItems(next);
                      }}
                      maxLength={400}
                      rows={2}
                      placeholder="Description (optionnelle)"
                      className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-cobalt"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setItems(items.filter((_, j) => j !== i))
                    }
                    className="self-start inline-flex items-center rounded-btn border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-bold text-red-800 transition-colors hover:bg-red-100"
                  >
                    Retirer
                  </button>
                </div>
              ) : (
                <div>
                  <p className="font-semibold text-ink">{a.title}</p>
                  {a.description && (
                    <p className="mt-1 text-[12.5px] text-ink/70">
                      {a.description}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={() =>
              setItems([...items, { title: "", description: undefined }])
            }
            disabled={items.length >= 30}
            className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-60"
          >
            + Ajouter une activité
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className={cn(
              "inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {pending ? "Enregistrement…" : "Enregistrer les activités"}
          </button>
          <button
            type="button"
            onClick={() => {
              setItems(initial);
              setError(null);
            }}
            disabled={pending}
            className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Réinitialiser
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
    </div>
  );
}

// ─── Topics ──────────────────────────────────────────────────────────────

function TopicsEditor({
  id,
  initial,
  canManage
}: {
  id: string;
  initial: SpaceTopic[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<SpaceTopic[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await updateSpaceTopicsAction(id, items);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    });

  return (
    <div className="rounded-card border border-line bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Thèmes
        </p>
        <p className="text-[11px] text-ink/50">{items.length} thème{items.length === 1 ? "" : "s"}</p>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-[13px] italic text-ink/55">
          Aucun thème enregistré.
        </p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2">
          {items.map((t, i) => (
            <li
              key={i}
              className="inline-flex items-center gap-2 rounded-full border border-line bg-frost/50 px-3 py-1"
            >
              {canManage ? (
                <>
                  <input
                    type="text"
                    value={t.label}
                    onChange={(e) => {
                      const next = [...items];
                      next[i] = { label: e.target.value };
                      setItems(next);
                    }}
                    maxLength={120}
                    placeholder="Thème"
                    className="w-40 rounded border-none bg-transparent text-[12.5px] font-medium text-ink outline-none focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setItems(items.filter((_, j) => j !== i))}
                    className="text-[11px] font-bold text-red-800 hover:text-red-900"
                    aria-label="Retirer ce thème"
                  >
                    ×
                  </button>
                </>
              ) : (
                <span className="text-[12.5px] font-medium text-ink">
                  {t.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => setItems([...items, { label: "" }])}
            disabled={items.length >= 30}
            className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-60"
          >
            + Ajouter un thème
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Enregistrement…" : "Enregistrer les thèmes"}
          </button>
          <button
            type="button"
            onClick={() => {
              setItems(initial);
              setError(null);
            }}
            disabled={pending}
            className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Réinitialiser
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
    </div>
  );
}

// ─── Exhibitors ──────────────────────────────────────────────────────────

function ExhibitorsEditor({
  id,
  initial,
  canManage
}: {
  id: string;
  initial: SpaceExhibitor[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<SpaceExhibitor[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await updateSpaceExhibitorsAction(id, items);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    });

  return (
    <div className="rounded-card border border-line bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          Exposants
        </p>
        <p className="text-[11px] text-ink/50">{items.length} exposant{items.length === 1 ? "" : "s"}</p>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-[13px] italic text-ink/55">
          Aucun exposant enregistré.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((x, i) => (
            <li
              key={i}
              className="rounded-lg border border-line bg-frost/50 p-3"
            >
              {canManage ? (
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="grid gap-2">
                    <input
                      type="text"
                      value={x.name}
                      onChange={(e) => {
                        const next = [...items];
                        next[i] = { ...x, name: e.target.value };
                        setItems(next);
                      }}
                      maxLength={120}
                      placeholder="Nom de l'exposant"
                      className="rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink outline-none focus:border-cobalt"
                    />
                    <input
                      type="url"
                      value={x.website ?? ""}
                      onChange={(e) => {
                        const next = [...items];
                        next[i] = {
                          ...x,
                          website: e.target.value || undefined
                        };
                        setItems(next);
                      }}
                      maxLength={200}
                      placeholder="Site web (optionnel, https://…)"
                      className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-cobalt"
                    />
                    <textarea
                      value={x.description ?? ""}
                      onChange={(e) => {
                        const next = [...items];
                        next[i] = {
                          ...x,
                          description: e.target.value || undefined
                        };
                        setItems(next);
                      }}
                      maxLength={400}
                      rows={2}
                      placeholder="Description (optionnelle)"
                      className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-cobalt"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setItems(items.filter((_, j) => j !== i))
                    }
                    className="self-start inline-flex items-center rounded-btn border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-bold text-red-800 transition-colors hover:bg-red-100"
                  >
                    Retirer
                  </button>
                </div>
              ) : (
                <div>
                  <p className="font-semibold text-ink">{x.name}</p>
                  {x.website && (
                    <p className="mt-0.5 text-[11.5px] text-cobalt">
                      {x.website}
                    </p>
                  )}
                  {x.description && (
                    <p className="mt-1 text-[12.5px] text-ink/70">
                      {x.description}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={() =>
              setItems([
                ...items,
                { name: "", website: undefined, description: undefined }
              ])
            }
            disabled={items.length >= 30}
            className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-60"
          >
            + Ajouter un exposant
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="inline-flex items-center rounded-btn bg-cobalt px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Enregistrement…" : "Enregistrer les exposants"}
          </button>
          <button
            type="button"
            onClick={() => {
              setItems(initial);
              setError(null);
            }}
            disabled={pending}
            className="inline-flex items-center rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Réinitialiser
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
    </div>
  );
}

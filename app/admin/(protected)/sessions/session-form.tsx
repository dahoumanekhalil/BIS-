"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { createSession, updateSession, type SessionFormState } from "./actions";
import {
  SESSION_CATEGORIES,
  SESSION_CATEGORY_LABEL,
  SESSION_TYPES,
  SESSION_TYPE_LABEL
} from "@/lib/admin/session-labels";
import { Card } from "@/components/admin/page-kit";
import { cn } from "@/lib/utils";

export type SessionFormInitial = {
  title: string;
  summary: string;
  type: string;
  category: string;
  startsAt: string; // "YYYY-MM-DDTHH:mm" in event time
  durationMin: number;
  stage: string;
  spaceId: string;
  isHighlighted: boolean;
  order: number;
  speakerIds: string[];
};

const EMPTY: SessionFormInitial = {
  title: "",
  summary: "",
  type: "TALK",
  category: "INNOVATION",
  startsAt: "",
  durationMin: 45,
  stage: "",
  spaceId: "",
  isHighlighted: false,
  order: 0,
  speakerIds: []
};

const IDLE: SessionFormState = { status: "idle" };

const inputCls =
  "w-full rounded-btn border border-line bg-white px-3 py-2.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink/40 focus:border-cobalt focus:ring-2 focus:ring-cobalt/10";

export function SessionForm({
  mode,
  id,
  initial,
  spaces,
  speakers
}: {
  mode: "create" | "edit";
  id?: string;
  initial?: SessionFormInitial;
  spaces: Array<{ id: string; name: string }>;
  speakers: Array<{ id: string; fullName: string; organization: string }>;
}) {
  const init = initial ?? EMPTY;
  const action =
    mode === "edit" && id ? updateSession.bind(null, id) : createSession;
  const [state, formAction] = useActionState(action, IDLE);
  const err =
    state.status === "error"
      ? (state.fieldErrors ?? {})
      : ({} as Record<string, string>);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(init.speakerIds)
  );
  const needle = filter.trim().toLowerCase();

  function toggle(speakerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(speakerId)) next.delete(speakerId);
      else next.add(speakerId);
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-6">
      {state.status === "error" && (
        <div
          role="alert"
          className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-800"
        >
          {state.message}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card title="Contenu" description="Ce que les participants verront.">
            <div className="space-y-4">
              <Field label="Titre" error={err.title}>
                <input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={init.title}
                  placeholder="Ex. Le paradoxe du fondateur africain"
                  className={inputCls}
                />
              </Field>
              <Field label="Description" hint="Facultatif" error={err.summary}>
                <textarea
                  name="summary"
                  rows={4}
                  maxLength={2000}
                  defaultValue={init.summary}
                  placeholder="Deux ou trois phrases qui résument la session"
                  className={cn(inputCls, "resize-y")}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Type" error={err.type}>
                  <select
                    name="type"
                    defaultValue={init.type}
                    className={inputCls}
                  >
                    {SESSION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {SESSION_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Thème" error={err.category}>
                  <select
                    name="category"
                    defaultValue={init.category}
                    className={inputCls}
                  >
                    {SESSION_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {SESSION_CATEGORY_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
          </Card>

          <Card
            title="Horaire et lieu"
            description="Heure d'Alger (UTC+1)."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Début" error={err.startsAt}>
                <input
                  type="datetime-local"
                  name="startsAt"
                  required
                  defaultValue={init.startsAt}
                  className={inputCls}
                />
              </Field>
              <Field label="Durée (minutes)" error={err.durationMin}>
                <input
                  type="number"
                  name="durationMin"
                  required
                  min={5}
                  max={720}
                  step={5}
                  defaultValue={init.durationMin}
                  className={inputCls}
                />
              </Field>
              <Field label="Espace" hint="Facultatif" error={err.spaceId}>
                <select
                  name="spaceId"
                  defaultValue={init.spaceId}
                  className={inputCls}
                >
                  <option value="">Aucun espace</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Scène ou salle" hint="Facultatif" error={err.stage}>
                <input
                  name="stage"
                  maxLength={120}
                  defaultValue={init.stage}
                  placeholder="Ex. Main Stage"
                  className={inputCls}
                />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card
            title="Intervenants"
            description={`${selected.size} sélectionné${selected.size > 1 ? "s" : ""}`}
          >
            {speakers.length === 0 ? (
              <p className="text-[14px] text-ink/60">
                Aucun intervenant n&apos;existe encore dans la base.
              </p>
            ) : (
              <>
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Rechercher un intervenant"
                  aria-label="Rechercher un intervenant"
                  className={cn(inputCls, "mb-3")}
                />
                <ul className="max-h-[320px] space-y-1 overflow-y-auto rounded-card border border-line p-1.5">
                  {speakers.map((s) => {
                    const match =
                      !needle ||
                      `${s.fullName} ${s.organization}`
                        .toLowerCase()
                        .includes(needle);
                    return (
                      <li key={s.id} hidden={!match}>
                        <label className="flex cursor-pointer items-center gap-3 rounded-btn px-3 py-2.5 text-[14px] transition-colors hover:bg-frost">
                          <input
                            type="checkbox"
                            name="speakerIds"
                            value={s.id}
                            checked={selected.has(s.id)}
                            onChange={() => toggle(s.id)}
                            className="h-4 w-4 rounded border-line accent-cobalt"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-ink">
                              {s.fullName}
                            </span>
                            <span className="block truncate text-[12.5px] text-ink/55">
                              {s.organization}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {err.speakerIds && (
              <p role="alert" className="mt-2 text-[13px] text-red-700">
                {err.speakerIds}
              </p>
            )}
          </Card>

          <Card title="Options">
            <div className="space-y-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  name="isHighlighted"
                  defaultChecked={init.isHighlighted}
                  className="mt-0.5 h-4 w-4 rounded border-line accent-cobalt"
                />
                <span className="text-[14px]">
                  <span className="block font-semibold text-ink">
                    Mettre à la une
                  </span>
                  <span className="text-[13px] text-ink/60">
                    Affichée sur la page d&apos;accueil du site.
                  </span>
                </span>
              </label>
              <Field
                label="Ordre d'affichage"
                hint="0 = en premier à heure égale"
                error={err.order}
              >
                <input
                  type="number"
                  name="order"
                  min={0}
                  max={9999}
                  defaultValue={init.order}
                  className={inputCls}
                />
              </Field>
            </div>
          </Card>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link
          href="/admin/sessions"
          className="rounded-btn border border-line bg-white px-4 py-2.5 text-[14px] font-semibold text-ink transition-colors hover:border-ink/30"
        >
          Annuler
        </Link>
        <SubmitButton mode={mode} />
      </div>
    </form>
  );
}

function SubmitButton({ mode }: { mode: "create" | "edit" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center rounded-btn bg-ink px-5 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-60"
    >
      {pending
        ? "Enregistrement…"
        : mode === "create"
          ? "Créer la session"
          : "Enregistrer les modifications"}
    </button>
  );
}

function Field({
  label,
  hint,
  error,
  children
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[13.5px] font-semibold text-ink/80">{label}</span>
        {hint && <span className="text-[12.5px] text-ink/45">{hint}</span>}
      </span>
      <span className="mt-1.5 block">{children}</span>
      {error && (
        <span role="alert" className="mt-1 block text-[13px] text-red-700">
          {error}
        </span>
      )}
    </label>
  );
}

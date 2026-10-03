"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateScheduleAction } from "../../actions";

type SafeError = {
  ok: false;
  code: string;
  publicMessage: string;
  operationId: string;
};

function NumberField({
  label,
  help,
  unit,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  help: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const id = useId();
  return (
    <div className="rounded-card border border-line bg-white p-4 transition-colors focus-within:border-cobalt/50 focus-within:ring-2 focus-within:ring-cobalt/10">
      <label
        htmlFor={id}
        className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/50"
      >
        {label}
      </label>
      <div className="mt-3 flex items-baseline gap-2">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(Math.floor(Number(e.target.value) || 0))}
          className="w-full min-w-0 border-0 bg-transparent p-0 font-display text-[28px] font-black leading-none tracking-tight text-ink tabular-nums outline-none focus:ring-0"
        />
        <span className="shrink-0 text-[12px] font-semibold text-ink/45">
          {unit}
        </span>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink/55">{help}</p>
      <p className="mt-1 text-[10.5px] font-mono text-ink/35">
        {min} – {max}
      </p>
    </div>
  );
}

export function ScheduleForm({
  initial
}: {
  initial: {
    enabled: boolean;
    frequencyHours: number;
    retentionCount: number;
    retentionAgeDays: number;
  };
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [frequencyHours, setFrequencyHours] = useState(initial.frequencyHours);
  const [retentionCount, setRetentionCount] = useState(initial.retentionCount);
  const [retentionAgeDays, setRetentionAgeDays] = useState(
    initial.retentionAgeDays
  );
  const [result, setResult] = useState<
    | null
    | { ok: true; operationId: string }
    | SafeError
  >(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const switchId = useId();

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setResult(null);
          const r = await updateScheduleAction({
            enabled,
            frequencyHours,
            retentionCount,
            retentionAgeDays
          });
          if (r.ok) {
            setResult({ ok: true, operationId: r.operationId });
            router.refresh();
          } else {
            setResult(r);
          }
        });
      }}
    >
      <div
        className={`flex items-center justify-between gap-4 rounded-card border p-4 transition-colors ${
          enabled
            ? "border-lime/50 bg-lime/10"
            : "border-line bg-ink/[0.02]"
        }`}
      >
        <div>
          <label
            htmlFor={switchId}
            className="block text-[13.5px] font-semibold text-ink"
          >
            Planificateur automatique
          </label>
          <p className="mt-0.5 text-[12px] text-ink/60">
            {enabled
              ? "Actif — une sauvegarde est créée à chaque intervalle (cron externe requis)."
              : "Désactivé — aucune sauvegarde automatique ne sera créée."}
          </p>
        </div>
        <button
          id={switchId}
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((v) => !v)}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40 focus-visible:ring-offset-2 ${
            enabled ? "bg-ink" : "bg-ink/20"
          }`}
        >
          <span
            aria-hidden
            className={`inline-block h-5 w-5 transform rounded-full shadow transition-transform ${
              enabled ? "translate-x-6 bg-lime" : "translate-x-1 bg-white"
            }`}
          />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <NumberField
          label="Fréquence"
          unit="heures"
          min={1}
          max={168}
          value={frequencyHours}
          onChange={setFrequencyHours}
          help="Intervalle entre deux sauvegardes automatiques (jusqu'à une semaine)."
        />
        <NumberField
          label="Nombre conservé"
          unit="sauvegardes"
          min={1}
          max={365}
          value={retentionCount}
          onChange={setRetentionCount}
          help="Nombre de sauvegardes récentes toujours préservées."
        />
        <NumberField
          label="Âge maximum"
          unit="jours"
          min={0}
          max={3650}
          value={retentionAgeDays}
          onChange={setRetentionAgeDays}
          help="Une sauvegarde plus ancienne peut être élaguée hors du nombre conservé. 0 désactive la règle."
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-btn bg-ink px-4 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Enregistrer les paramètres"}
        </button>
        {result && result.ok === true && (
          <p
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-[12px] font-semibold text-emerald-800"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
            Enregistré
            <span className="font-mono text-[11px] font-normal text-emerald-800/70">
              Op {result.operationId}
            </span>
          </p>
        )}
        {result && result.ok === false && (
          <p
            role="alert"
            className="rounded-btn border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] text-red-800"
          >
            <span className="font-semibold">Échec ({result.code})</span> —{" "}
            {result.publicMessage}
          </p>
        )}
      </div>
    </form>
  );
}

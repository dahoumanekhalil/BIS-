"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateScheduleAction } from "../../actions";

type SafeError = {
  ok: false;
  code: string;
  publicMessage: string;
  operationId: string;
};

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

  return (
    <form
      className="grid gap-4"
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
      <label className="flex items-center gap-3 text-[13px]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>
          <strong>Activer</strong> le planificateur (cron externe requis).
        </span>
      </label>

      <label className="block text-[13px]">
        <span className="font-semibold">Fréquence (heures)</span>
        <p className="text-[11.5px] text-ink/55">
          Intervalle entre deux sauvegardes automatiques. Entre 1 et 168 (une
          semaine).
        </p>
        <input
          type="number"
          min={1}
          max={168}
          step={1}
          value={frequencyHours}
          onChange={(e) => setFrequencyHours(Math.floor(Number(e.target.value) || 0))}
          className="mt-2 w-32 rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] tabular-nums"
        />
      </label>

      <label className="block text-[13px]">
        <span className="font-semibold">Nombre conservé</span>
        <p className="text-[11.5px] text-ink/55">
          Nombre de sauvegardes récentes toujours préservées. Entre 1 et 365.
        </p>
        <input
          type="number"
          min={1}
          max={365}
          step={1}
          value={retentionCount}
          onChange={(e) => setRetentionCount(Math.floor(Number(e.target.value) || 0))}
          className="mt-2 w-32 rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] tabular-nums"
        />
      </label>

      <label className="block text-[13px]">
        <span className="font-semibold">Âge maximum (jours)</span>
        <p className="text-[11.5px] text-ink/55">
          Une sauvegarde plus ancienne peut être élaguée si elle sort du
          nombre conservé. Mettre 0 désactive la règle d&apos;âge.
        </p>
        <input
          type="number"
          min={0}
          max={3650}
          step={1}
          value={retentionAgeDays}
          onChange={(e) => setRetentionAgeDays(Math.floor(Number(e.target.value) || 0))}
          className="mt-2 w-32 rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] tabular-nums"
        />
      </label>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center rounded-btn bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Enregistrer"}
        </button>
        {result && result.ok === true && (
          <p role="status" aria-live="polite" className="text-[12px] text-emerald-800">
            Enregistré · Op {result.operationId}
          </p>
        )}
        {result && result.ok === false && (
          <p role="alert" className="text-[12px] text-red-800">
            Échec ({result.code}) — {result.publicMessage}
          </p>
        )}
      </div>
    </form>
  );
}

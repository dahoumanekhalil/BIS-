"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AccessPointType, CheckInResult } from "@prisma/client";

// Phase 16 — filter form for /admin/scan/history.
//
// Client-only form that composes a URL query string and pushes it via
// `router.push`. The server page re-renders with the new filters and
// executes the bounded `getScanHistory` query. No JSON API. No
// client-side data fetching. No authorization logic here — the server
// page is the ONLY thing that can decide whether the user sees the
// results.

type Facets = {
  points: Array<{
    id: string;
    slug: string;
    name: string;
    type: AccessPointType;
    active: boolean;
  }>;
  operators: Array<{ id: string; name: string }>;
};

const RESULT_LABEL: Record<CheckInResult, string> = {
  VALID: "Autorisé",
  ALREADY_CHECKED_IN: "Déjà présent",
  WRONG_GATE: "Mauvaise porte",
  WRONG_TIME: "Hors créneau",
  CANCELLED: "Annulé",
  UNKNOWN: "Inconnu / refusé"
};
const RESULT_ORDER: CheckInResult[] = [
  "VALID",
  "ALREADY_CHECKED_IN",
  "UNKNOWN",
  "CANCELLED",
  "WRONG_GATE",
  "WRONG_TIME"
];

function pickStr(v: unknown, max = 128): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? "" : s;
}

export function HistoryFilters({
  facets,
  initial
}: {
  facets: Facets;
  initial: Record<string, string | string[] | undefined>;
}) {
  const router = useRouter();
  const [from, setFrom] = useState(pickStr(initial.from, 10));
  const [to, setTo] = useState(pickStr(initial.to, 10));
  const [accessPointId, setAccessPointId] = useState(
    pickStr(initial.accessPointId, 64)
  );
  const [result, setResult] = useState(pickStr(initial.result, 32));
  const [operatorId, setOperatorId] = useState(
    pickStr(initial.operatorId, 64)
  );
  const [q, setQ] = useState(pickStr(initial.q, 80));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (accessPointId) params.set("accessPointId", accessPointId);
    if (result) params.set("result", result);
    if (operatorId) params.set("operatorId", operatorId);
    if (q) params.set("q", q);
    const qs = params.toString();
    router.push(qs ? `/admin/scan/history?${qs}` : "/admin/scan/history");
  };

  const reset = () => {
    setFrom("");
    setTo("");
    setAccessPointId("");
    setResult("");
    setOperatorId("");
    setQ("");
    router.push("/admin/scan/history");
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-card border border-line bg-white p-4"
      aria-label="Filtres de l'historique des scans"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Du">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-cobalt"
          />
        </Field>
        <Field label="Au">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-cobalt"
          />
        </Field>
        <Field label="Point d'accès">
          <select
            value={accessPointId}
            onChange={(e) => setAccessPointId(e.target.value)}
            className="w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-cobalt"
          >
            <option value="">— Tous —</option>
            {facets.points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.active ? "" : "(désactivé)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Résultat">
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-cobalt"
          >
            <option value="">— Tous —</option>
            {RESULT_ORDER.map((r) => (
              <option key={r} value={r}>
                {RESULT_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Opérateur">
          <select
            value={operatorId}
            onChange={(e) => setOperatorId(e.target.value)}
            className="w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-cobalt"
          >
            <option value="">— Tous —</option>
            {facets.operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Recherche participant">
          <input
            type="search"
            value={q}
            maxLength={80}
            placeholder="Nom, email, ticket…"
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-cobalt"
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="submit"
          className="inline-flex items-center gap-2 rounded-btn bg-cobalt px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-cobalt-700"
        >
          Appliquer les filtres
        </button>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-bold text-ink transition-colors hover:border-ink/40"
        >
          Effacer
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
      {label}
      <div className="mt-1.5 normal-case tracking-normal">{children}</div>
    </label>
  );
}

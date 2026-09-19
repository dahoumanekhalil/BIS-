"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { value: "ALL", label: "Toutes catégories" },
  { value: "account", label: "Compte" },
  { value: "profile", label: "Profil" },
  { value: "payment", label: "Paiement" },
  { value: "checkin", label: "Check-in" },
  { value: "email", label: "Email" },
  { value: "security", label: "Sécurité" }
];

const STATUSES = [
  { value: "ALL", label: "Tous statuts" },
  { value: "success", label: "Succès" },
  { value: "failed", label: "Échec" },
  { value: "warn", label: "Alerte" },
  { value: "info", label: "Information" }
];

const RANGES = [
  { value: "all", label: "Tout l'historique" },
  { value: "today", label: "Aujourd'hui" },
  { value: "yesterday", label: "Hier" },
  { value: "7d", label: "7 derniers jours" },
  { value: "30d", label: "30 derniers jours" }
];

export function LogFilters({
  clientId,
  total
}: {
  clientId: string;
  total: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");

  useEffect(() => {
    const t = setTimeout(() => {
      updateParam("q", q || null);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value == null || value === "" || value === "ALL") next.delete(key);
    else next.set(key, value);
    next.delete("page");
    startTransition(() => {
      router.replace(`/admin/registrants/${clientId}/logs?${next.toString()}`, {
        scroll: false
      });
    });
  }

  function clearAll() {
    setQ("");
    startTransition(() => {
      router.replace(`/admin/registrants/${clientId}/logs`, { scroll: false });
    });
  }

  const activeFilters = ["category", "status", "range"].filter((k) =>
    params.get(k)
  ).length;

  return (
    <div className="rounded-card border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex min-w-[220px] flex-1 items-center">
          <svg
            className="pointer-events-none absolute left-3 h-4 w-4 text-ink/40"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden
          >
            <circle cx="9" cy="9" r="6.25" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 14l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un événement, un opérateur…"
            className="w-full rounded-btn border border-line bg-white py-2 pl-9 pr-3 text-[13px] outline-none focus:border-ink/40"
            aria-label="Rechercher un événement"
          />
        </label>

        <Select
          label="Catégorie"
          value={params.get("category") ?? "ALL"}
          onChange={(v) => updateParam("category", v)}
          options={CATEGORIES}
        />
        <Select
          label="Statut"
          value={params.get("status") ?? "ALL"}
          onChange={(v) => updateParam("status", v)}
          options={STATUSES}
        />
        <Select
          label="Période"
          value={params.get("range") ?? "all"}
          onChange={(v) => updateParam("range", v)}
          options={RANGES}
        />

        {activeFilters > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="rounded-btn border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/70 hover:border-ink/30 hover:text-ink"
          >
            Effacer les filtres
          </button>
        )}

        <p
          className={cn(
            "ml-auto text-[11.5px] uppercase tracking-[0.2em] text-ink/50",
            pending && "animate-pulse text-cobalt"
          )}
        >
          {pending
            ? "Actualisation…"
            : `${total.toLocaleString("fr-FR")} événements`}
        </p>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink/50">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-btn border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-medium normal-case tracking-normal text-ink outline-none focus:border-ink/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

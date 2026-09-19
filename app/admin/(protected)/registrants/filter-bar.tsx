"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition, useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const TIERS = ["ALL", "VVIP", "VIP", "CONTENT_CREATOR", "IMPACT_MAKER"];
const STATUSES = ["ALL", "PENDING", "CONFIRMED", "CANCELLED"];
const PAYMENTS = ["ALL", "UNPAID", "PENDING", "PAID", "REFUNDED", "FAILED"];
const GATES = ["ALL", "Gate A", "Gate B", "Gate C", "Gate D"];

const TIER_LABEL: Record<string, string> = {
  ALL: "Tous",
  VVIP: "VVIP",
  VIP: "VIP",
  CONTENT_CREATOR: "Content Creator",
  IMPACT_MAKER: "Impact Maker"
};

export function RegistrationsFilterBar({ total }: { total: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");

  // Debounced search
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
      router.replace(`/admin/registrants?${next.toString()}`, {
        scroll: false
      });
    });
  }

  function clearAll() {
    setQ("");
    startTransition(() => {
      router.replace(`/admin/registrants`, { scroll: false });
    });
  }

  const activeFilters = ["tier", "status", "payment", "gate"].filter((k) =>
    params.get(k)
  ).length;

  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex flex-1 min-w-[220px] items-center">
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
            placeholder="Nom, email, ticket, référence…"
            className="w-full rounded-btn border border-line bg-white py-2 pl-9 pr-3 text-[13px] outline-none focus:border-ink/40"
            aria-label="Rechercher"
          />
        </label>

        <Select
          value={params.get("tier") ?? "ALL"}
          onChange={(v) => updateParam("tier", v)}
          label="Tier"
          options={TIERS}
          format={(v) => TIER_LABEL[v]}
        />
        <Select
          value={params.get("status") ?? "ALL"}
          onChange={(v) => updateParam("status", v)}
          label="Statut"
          options={STATUSES}
        />
        <Select
          value={params.get("payment") ?? "ALL"}
          onChange={(v) => updateParam("payment", v)}
          label="Paiement"
          options={PAYMENTS}
        />
        <Select
          value={params.get("gate") ?? "ALL"}
          onChange={(v) => updateParam("gate", v)}
          label="Gate"
          options={GATES}
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
            : `${total.toLocaleString("fr-FR")} inscrits`}
        </p>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  format
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  format?: (v: string) => string;
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
          <option key={o} value={o}>
            {format ? format(o) : o === "ALL" ? "Tous" : o}
          </option>
        ))}
      </select>
    </label>
  );
}

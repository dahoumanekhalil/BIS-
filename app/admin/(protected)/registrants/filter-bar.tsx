"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition, useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const TIERS = ["ALL", "VVIP", "VIP", "CONTENT_CREATOR", "IMPACT_MAKER"];
const GATES = ["ALL", "Gate A", "Gate B", "Gate C", "Gate D"];
// Status moved to the tabs rendered by the page; the dropdown is gone.

const TIER_LABEL: Record<string, string> = {
  ALL: "Toutes",
  VVIP: "VVIP",
  VIP: "VIP",
  CONTENT_CREATOR: "Content Creator",
  IMPACT_MAKER: "Impact Maker"
};

const GATE_LABEL = (v: string) =>
  v === "ALL" ? "Toutes" : v.replace("Gate", "Porte");

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

  const activeFilters = ["tier", "status", "gate", "q"].filter((k) =>
    params.get(k)
  ).length;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(15,25,60,0.05)]">
      <div className="flex flex-wrap items-end gap-4">
        <label className="relative flex min-w-[260px] flex-1 flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-ink/75">
            Rechercher
          </span>
          <svg
            className="pointer-events-none absolute bottom-[13px] left-3.5 h-[18px] w-[18px] text-ink/45"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden
          >
            <circle cx="9" cy="9" r="6.25" stroke="currentColor" strokeWidth="1.6" />
            <path d="M14 14l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nom, email ou code billet"
            className="w-full rounded-btn border border-line bg-white py-2.5 pl-10 pr-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink/40 focus:border-cobalt focus:ring-2 focus:ring-cobalt/10"
          />
        </label>

        <Select
          value={params.get("tier") ?? "ALL"}
          onChange={(v) => updateParam("tier", v)}
          label="Catégorie"
          options={TIERS}
          format={(v) => TIER_LABEL[v]}
        />
        <Select
          value={params.get("gate") ?? "ALL"}
          onChange={(v) => updateParam("gate", v)}
          label="Porte"
          options={GATES}
          format={GATE_LABEL}
        />

        <div className="flex items-center gap-3 pb-1.5">
          {activeFilters > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="rounded-btn border border-line px-3.5 py-2 text-[13.5px] font-semibold text-ink/75 transition-colors hover:border-ink/30 hover:text-ink"
            >
              Tout effacer
            </button>
          )}
          <p
            className={cn(
              "text-[13.5px] font-semibold text-ink/60 tabular-nums",
              pending && "animate-pulse text-cobalt"
            )}
          >
            {pending
              ? "Actualisation…"
              : `${total.toLocaleString("fr-FR")} résultat${total > 1 ? "s" : ""}`}
          </p>
        </div>
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
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-ink/75">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-btn border border-line bg-white px-3 py-2.5 text-[14px] font-medium text-ink outline-none transition-colors focus:border-cobalt focus:ring-2 focus:ring-cobalt/10"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {format ? format(o) : o === "ALL" ? "Toutes" : o}
          </option>
        ))}
      </select>
    </label>
  );
}

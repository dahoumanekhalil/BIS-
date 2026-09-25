"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { TemplateListRow } from "@/lib/email/templates/service";

type Filter = "all" | "active" | "inactive" | "system" | "custom" | "db" | "code";

// Category → French display label. Any unknown category (e.g. one an
// operator invented) falls through to a capitalised version of the key.
const CATEGORY_LABEL: Record<string, string> = {
  auth: "Authentification",
  registration: "Inscription",
  room: "Salles",
  event: "Événement",
  marketing: "Marketing",
  system: "Système",
  contact: "Contact",
  custom: "Personnalisé",
  logistics: "Logistique",
  reminder: "Rappel",
  application: "Candidature",
  security: "Sécurité",
  onboarding: "Accueil"
};

function labelFor(cat: string): string {
  return CATEGORY_LABEL[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
}

export function TemplatesList({ rows }: { rows: TemplateListRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "active" && !r.isActive) return false;
      if (filter === "inactive" && r.isActive) return false;
      if (filter === "system" && !r.isSystem) return false;
      if (filter === "custom" && r.isSystem) return false;
      if (filter === "db" && r.source !== "db") return false;
      if (filter === "code" && r.source !== "code") return false;
      if (needle) {
        const hay = `${r.name} ${r.key} ${r.category} ${r.description ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, filter, q]);

  const grouped = useMemo(() => {
    const map = new Map<string, TemplateListRow[]>();
    for (const r of filtered) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    return Array.from(map.entries()).sort((a, b) =>
      labelFor(a[0]).localeCompare(labelFor(b[0]))
    );
  }, [filtered]);

  const counts = useMemo(() => {
    const c = { all: rows.length, active: 0, inactive: 0, system: 0, custom: 0, db: 0, code: 0 };
    for (const r of rows) {
      if (r.isActive) c.active++;
      else c.inactive++;
      if (r.isSystem) c.system++;
      else c.custom++;
      if (r.source === "db") c.db++;
      else c.code++;
    }
    return c;
  }, [rows]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="rounded-[16px] border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/40">
              <SearchIcon />
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder="Chercher par nom, clé, description…"
              className="w-full rounded-btn border border-line bg-frost/50 pl-9 pr-3 py-2 text-[13px] text-ink placeholder:text-ink/40 focus:border-cobalt focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={filter === "all"} onClick={() => setFilter("all")} label="Tous" count={counts.all} />
            <Chip active={filter === "active"} onClick={() => setFilter("active")} label="Actifs" count={counts.active} tone="ok" />
            <Chip active={filter === "inactive"} onClick={() => setFilter("inactive")} label="Inactifs" count={counts.inactive} tone="bad" />
            <Chip active={filter === "db"} onClick={() => setFilter("db")} label="Personnalisés" count={counts.db} tone="brand" />
            <Chip active={filter === "code"} onClick={() => setFilter("code")} label="Système" count={counts.code} />
          </div>
        </div>
        {filtered.length === 0 && (
          <p className="mt-4 text-center text-[13px] text-ink/50">
            Aucun modèle ne correspond à ce filtre.
          </p>
        )}
      </div>

      {/* Grouped list */}
      <div className="space-y-6">
        {grouped.map(([cat, items]) => (
          <div key={cat}>
            <div className="mb-2 flex items-center gap-3">
              <h3 className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
                {labelFor(cat)}
              </h3>
              <span className="text-[10.5px] font-bold text-ink/40">
                {items.length}
              </span>
              <div className="flex-1 h-px bg-line" />
            </div>
            <ul className="grid gap-2">
              {items.map((r) => (
                <li key={r.key}>
                  <TemplateCard row={r} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateCard({ row }: { row: TemplateListRow }) {
  return (
    <Link
      href={`/admin/settings/email/templates/${row.key}`}
      className="group grid grid-cols-[1fr_auto] items-center gap-4 rounded-[14px] border border-line bg-white px-5 py-4 transition hover:border-cobalt/40 hover:shadow-[0_4px_18px_-8px_rgba(15,25,60,0.12)]"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-[14.5px] font-bold text-ink truncate">
            {row.name}
          </h4>
          <StatusPill active={row.isActive} />
          <SourcePill source={row.source} isSystem={row.isSystem} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink/55">
          <span className="font-mono text-ink/70">{row.key}</span>
          {row.updatedAt && (
            <>
              <Sep />
              <span>Mis à jour {row.updatedAt.toISOString().slice(0, 10)}</span>
            </>
          )}
        </div>
        {row.description && (
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/65 line-clamp-2">
            {row.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden text-[12.5px] font-bold text-cobalt sm:inline">
          Éditer
        </span>
        <span className="grid h-8 w-8 place-items-center rounded-full border border-line bg-frost/60 text-cobalt transition group-hover:bg-cobalt group-hover:text-white">
          <ArrowRightIcon />
        </span>
      </div>
    </Link>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-lime/25 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink">
      <Dot className="bg-lime" /> Actif
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink/8 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink/60">
      <Dot className="bg-ink/40" /> Inactif
    </span>
  );
}

function SourcePill({ source, isSystem }: { source: "db" | "code"; isSystem: boolean }) {
  if (source === "db") {
    return (
      <span className="inline-flex items-center rounded-full bg-cobalt/10 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-cobalt">
        {isSystem ? "Override système" : "Personnalisé"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-ink/5 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink/55">
      Système (code)
    </span>
  );
}

function Chip({
  active,
  onClick,
  label,
  count,
  tone
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "ok" | "bad" | "brand";
}) {
  const toneCls =
    active
      ? tone === "ok"
        ? "bg-lime/30 border-lime text-ink"
        : tone === "bad"
          ? "bg-red-100 border-red-300 text-red-800"
          : tone === "brand"
            ? "bg-cobalt text-white border-cobalt"
            : "bg-ink text-lime border-ink"
      : "bg-white border-line text-ink/70 hover:border-ink/30";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-bold transition ${toneCls}`}
    >
      {label}
      <span
        className={`inline-flex min-w-[18px] justify-center rounded-full px-1.5 text-[10px] font-bold ${
          active ? "bg-white/25" : "bg-ink/8 text-ink/60"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} />;
}

function Sep() {
  return <span aria-hidden className="text-ink/30">·</span>;
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

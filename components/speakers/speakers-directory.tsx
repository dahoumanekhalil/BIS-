"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SpeakerCard, type SpeakerCardData } from "./speaker-card";

type Pillar =
  | "Tous"
  | "Innovation"
  | "Impact"
  | "Culture"
  | "Business"
  | "Tech"
  | "Société";

const PILLARS: Pillar[] = [
  "Tous",
  "Innovation",
  "Impact",
  "Culture",
  "Business",
  "Tech",
  "Société"
];

export function SpeakersDirectory({
  speakers
}: {
  speakers: SpeakerCardData[];
}) {
  const [active, setActive] = useState<Pillar>("Tous");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return speakers.filter((s) => {
      const matchesPillar =
        active === "Tous" || s.pillars.includes(active);
      if (!matchesPillar) return false;
      if (!q) return true;
      return (
        s.fullName.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.organization.toLowerCase().includes(q) ||
        (s.country ?? "").toLowerCase().includes(q)
      );
    });
  }, [speakers, active, query]);

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {PILLARS.map((p) => {
            const isActive = active === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setActive(p)}
                className={cn(
                  "rounded-btn px-3.5 py-1.5 text-[12px] font-semibold transition-colors",
                  isActive
                    ? "bg-ink text-white"
                    : "border border-line bg-white text-ink/70 hover:border-ink/30 hover:text-ink"
                )}
              >
                {p}
              </button>
            );
          })}
        </div>

        <label className="relative inline-flex w-full items-center sm:w-72">
          <svg
            className="pointer-events-none absolute left-3 h-4 w-4 text-ink/40"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden
          >
            <circle
              cx="9"
              cy="9"
              r="6.25"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M14 14l3 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un intervenant"
            className="w-full rounded-btn border border-line bg-white py-2 pl-9 pr-3 text-[12.5px] text-ink placeholder:text-ink/40 focus:border-ink/40 focus:outline-none"
            aria-label="Rechercher un intervenant"
          />
        </label>
      </div>

      {/* Meta row */}
      <div className="mt-6 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-ink/50">
        <span>
          {filtered.length} {filtered.length > 1 ? "intervenants" : "intervenant"}{" "}
          affichés
        </span>
        <span className="hidden sm:inline">Édition 2026 · CIC Alger</span>
      </div>

      {/* Grid */}
      {filtered.length > 0 ? (
        <ul
          className={cn(
            "mt-8 grid gap-x-5 gap-y-10",
            "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          )}
        >
          {filtered.map((s) => (
            <li key={s.slug} className="relative">
              <SpeakerCard speaker={s} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-16 flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-white py-16 text-center">
          <p className="font-display text-lg font-bold text-ink">
            Aucun intervenant ne correspond.
          </p>
          <p className="max-w-md text-sm text-ink/60">
            Essayez un autre pilier ou effacez votre recherche pour retrouver
            l&apos;ensemble des voix annoncées.
          </p>
          <button
            type="button"
            onClick={() => {
              setActive("Tous");
              setQuery("");
            }}
            className="mt-2 rounded-btn border border-ink/15 bg-white px-4 py-2 text-[12px] font-semibold text-ink transition-colors hover:border-ink/40"
          >
            Réinitialiser
          </button>
        </div>
      )}
    </div>
  );
}

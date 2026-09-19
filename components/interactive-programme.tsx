"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Prisma } from "@prisma/client";
import { cn } from "@/lib/utils";
import {
  MapLegend,
  ProgrammeMap,
  typeLabel,
  universes
} from "@/components/programme-map";

type SessionRow = Prisma.SessionGetPayload<{
  include: { speakers: { include: { speaker: true } }; space: true };
}>;

type Day = {
  iso: string;
  date: Date;
  items: SessionRow[];
};

const STORAGE_KEY = "bis:journey:v1";
const ALL_TYPES = ["TALK", "PANEL", "WORKSHOP", "MASTERMIND", "KEYNOTE", "FIRESIDE", "MASTERCLASS", "PITCH", "SHOWCASE"];

function fmtHour(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC"
  }).format(d);
}
function fmtWeekday(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    timeZone: "UTC"
  }).format(d);
}
function fmtDayNum(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    timeZone: "UTC"
  }).format(d);
}
function fmtMonth(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    month: "short",
    timeZone: "UTC"
  }).format(d);
}

function overlaps(a: SessionRow, b: SessionRow) {
  const aStart = a.startsAt.getTime();
  const aEnd = aStart + a.durationMin * 60_000;
  const bStart = b.startsAt.getTime();
  const bEnd = bStart + b.durationMin * 60_000;
  return aStart < bEnd && bStart < aEnd;
}

export function InteractiveProgramme({ days }: { days: Day[] }) {
  const [query, setQuery] = useState("");
  const [selectedUniverses, setSelectedUniverses] = useState<Set<string>>(
    new Set(universes.map((u) => u.slug))
  );
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set(ALL_TYPES));
  const [selectedSession, setSelectedSession] = useState<SessionRow | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Hydrate from localStorage after mount to avoid SSR mismatch
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSaved(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(saved)));
    } catch {
      /* ignore */
    }
  }, [saved, hydrated]);

  // Close sheet on Escape
  useEffect(() => {
    if (!selectedSession) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedSession(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSession]);

  const toggleSaved = useCallback(
    (id: string) => {
      setSaved((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          setToast("Retiré de ma journée");
        } else {
          next.add(id);
          setToast("Ajouté à ma journée");
        }
        return next;
      });
    },
    []
  );

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const matches = useCallback(
    (s: SessionRow) => {
      if (!selectedUniverses.has(s.space?.slug ?? "get-beyond")) return false;
      if (!selectedTypes.has(s.type)) return false;
      if (!query.trim()) return true;
      const q = query.trim().toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        (s.summary ?? "").toLowerCase().includes(q) ||
        s.speakers.some((ss) => ss.speaker.fullName.toLowerCase().includes(q)) ||
        s.speakers.some((ss) =>
          ss.speaker.organization.toLowerCase().includes(q)
        )
      );
    },
    [selectedUniverses, selectedTypes, query]
  );

  const allSessions = useMemo(() => days.flatMap((d) => d.items), [days]);
  const matchCount = useMemo(
    () => allSessions.filter(matches).length,
    [allSessions, matches]
  );

  const savedSessions = useMemo(
    () =>
      allSessions
        .filter((s) => saved.has(s.id))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
    [allSessions, saved]
  );

  const savedConflicts = useMemo(() => {
    const conflicts = new Set<string>();
    for (let i = 0; i < savedSessions.length; i++) {
      for (let j = i + 1; j < savedSessions.length; j++) {
        if (overlaps(savedSessions[i], savedSessions[j])) {
          conflicts.add(savedSessions[i].id);
          conflicts.add(savedSessions[j].id);
        }
      }
    }
    return conflicts;
  }, [savedSessions]);

  const savedByDay = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const s of savedSessions) {
      const key = s.startsAt.toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return map;
  }, [savedSessions]);

  const filtersActive =
    query.trim().length > 0 ||
    selectedUniverses.size !== universes.length ||
    selectedTypes.size !== ALL_TYPES.length;

  const clearFilters = () => {
    setQuery("");
    setSelectedUniverses(new Set(universes.map((u) => u.slug)));
    setSelectedTypes(new Set(ALL_TYPES));
  };

  return (
    <>
      {/* FILTER BAR */}
      <div className="mb-10 rounded-[24px] border border-line bg-white p-6 shadow-[0_10px_30px_-20px_rgba(15,26,56,0.15)] lg:p-8">
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-8">
          {/* Search */}
          <div className="lg:col-span-5">
            <label className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50">
              Rechercher un arrêt
            </label>
            <div className="relative mt-2">
              <svg
                aria-hidden
                className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40"
                viewBox="0 0 20 20"
                fill="none"
              >
                <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="m14 14 4 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Titre, intervenant, organisation…"
                className="w-full rounded-btn border border-line bg-frost pl-11 pr-4 py-3 text-[14px] font-medium text-ink outline-none transition-colors focus:border-cobalt focus:bg-white"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Effacer"
                  className="absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-ink/10 text-[10px] text-ink hover:bg-ink/20"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Universe multiselect */}
          <div className="lg:col-span-4">
            <label className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50">
              Lignes
            </label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {universes.map((u) => {
                const on = selectedUniverses.has(u.slug);
                return (
                  <button
                    key={u.slug}
                    type="button"
                    onClick={() => {
                      const next = new Set(selectedUniverses);
                      if (on) next.delete(u.slug);
                      else next.add(u.slug);
                      setSelectedUniverses(next);
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] transition-all",
                      on
                        ? "border-transparent text-white"
                        : "border-line bg-white text-ink/45 hover:border-ink/25"
                    )}
                    style={
                      on
                        ? { backgroundColor: u.color, color: u.ink }
                        : undefined
                    }
                    aria-pressed={on}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: on ? u.ink : u.color }}
                    />
                    {u.code}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Type multiselect */}
          <div className="lg:col-span-3">
            <label className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50">
              Format
            </label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {["TALK", "PANEL", "WORKSHOP", "MASTERMIND"].map((t) => {
                const on = selectedTypes.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      const next = new Set(selectedTypes);
                      if (on) next.delete(t);
                      else next.add(t);
                      setSelectedTypes(next);
                    }}
                    className={cn(
                      "inline-flex items-center rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] transition-all",
                      on
                        ? "border-ink bg-ink text-white"
                        : "border-line bg-white text-ink/45 hover:border-ink/25"
                    )}
                    aria-pressed={on}
                  >
                    {typeLabel[t] ?? t}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Meta row */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-ink/60">
            <span>
              <span className="font-bold text-ink">{matchCount}</span> résultat
              {matchCount > 1 ? "s" : ""}
              {filtersActive && ` sur ${allSessions.length}`}
            </span>
            {filtersActive && (
              <>
                <span className="text-ink/20">·</span>
                <button
                  type="button"
                  onClick={clearFilters}
                  className="font-semibold text-cobalt underline-offset-4 hover:underline"
                >
                  Réinitialiser
                </button>
              </>
            )}
          </div>
          <MapLegend />
        </div>
      </div>

      {/* MAPS PER DAY */}
      <div className="space-y-14">
        {days.map((d, dayIdx) => {
          const dayMatchCount = d.items.filter(matches).length;
          return (
            <div key={d.iso} id={`jour-${dayIdx + 1}`} className="scroll-mt-32">
              {/* Day header */}
              <div className="mb-6 flex items-end justify-between gap-6">
                <div className="flex items-end gap-5">
                  <div className="relative">
                    <p className="font-display text-[clamp(4rem,10vw,7rem)] font-black leading-[0.85] tracking-tighter text-ink">
                      {fmtDayNum(d.date)}
                    </p>
                    <span className="absolute -right-4 -top-1 rounded-full bg-lime px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-ink">
                      Jour 0{dayIdx + 1}
                    </span>
                  </div>
                  <div className="pb-2">
                    <p className="font-display text-2xl font-extrabold capitalize tracking-tight text-ink sm:text-3xl">
                      {fmtWeekday(d.date)}
                    </p>
                    <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.18em] text-ink/50">
                      {fmtMonth(d.date)} 2026 · {d.items.length} arrêts
                      {filtersActive && ` · ${dayMatchCount} correspondent au filtre`}
                    </p>
                  </div>
                </div>
                <div className="hidden text-right md:block">
                  <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/40">
                    Service
                  </p>
                  <p className="mt-1 font-display text-[13px] font-bold text-ink">
                    07:00 → 20:00
                  </p>
                </div>
              </div>

              <ProgrammeMap
                sessions={d.items}
                startHour={7}
                endHour={20}
                matches={matches}
                selectedId={selectedSession?.id ?? null}
                savedIds={saved}
                onSelect={(s) => setSelectedSession(s)}
              />

              {dayMatchCount === 0 && filtersActive && (
                <div className="mt-4 rounded-card border border-dashed border-line bg-white p-6 text-center">
                  <p className="font-display text-[13px] font-bold text-ink">
                    Aucun arrêt ne correspond au filtre ce jour.
                  </p>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="mt-3 text-[12px] font-semibold text-cobalt underline-offset-4 hover:underline"
                  >
                    Réinitialiser les filtres
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* SESSION DETAIL SHEET */}
      {selectedSession && (
        <SessionSheet
          session={selectedSession}
          saved={saved.has(selectedSession.id)}
          conflict={savedConflicts.has(selectedSession.id)}
          onClose={() => setSelectedSession(null)}
          onToggleSave={() => toggleSaved(selectedSession.id)}
        />
      )}

      {/* FLOATING JOURNEY FAB */}
      <button
        type="button"
        onClick={() => setJourneyOpen(true)}
        aria-label="Ouvrir ma journée"
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-3 text-white shadow-[0_20px_40px_-16px_rgba(0,0,0,0.4)] transition-transform hover:scale-105"
      >
        <span className="relative">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 3h12v18l-6-4-6 4V3z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
              fill={saved.size > 0 ? "currentColor" : "none"}
            />
          </svg>
          {saved.size > 0 && (
            <span className="absolute -right-2 -top-2 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-lime px-1 text-[10px] font-black text-ink">
              {saved.size}
            </span>
          )}
        </span>
        <span className="text-[13px] font-bold uppercase tracking-[0.14em]">
          Ma journée
        </span>
      </button>

      {/* JOURNEY DRAWER */}
      {journeyOpen && (
        <JourneyDrawer
          days={days}
          savedSessions={savedSessions}
          savedByDay={savedByDay}
          conflicts={savedConflicts}
          onClose={() => setJourneyOpen(false)}
          onRemove={(id) => toggleSaved(id)}
          onOpenSession={(s) => {
            setJourneyOpen(false);
            setSelectedSession(s);
          }}
          onClearAll={() => {
            setSaved(new Set());
            setToast("Journée vidée");
          }}
        />
      )}

      {/* TOAST */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2.5 text-[12px] font-semibold text-white shadow-[0_20px_40px_-16px_rgba(0,0,0,0.4)]"
        >
          {toast}
        </div>
      )}
    </>
  );
}

/* ── SESSION SHEET ─────────────────────────────────────── */
function SessionSheet({
  session: s,
  saved,
  conflict,
  onClose,
  onToggleSave
}: {
  session: SessionRow;
  saved: boolean;
  conflict: boolean;
  onClose: () => void;
  onToggleSave: () => void;
}) {
  const universe = universes.find((u) => u.slug === s.space?.slug);
  const color = universe?.color ?? "#2453E0";
  const ink = universe?.ink ?? "#FFFFFF";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={s.title}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl overflow-hidden rounded-t-[24px] bg-white shadow-2xl sm:rounded-[24px]"
      >
        {/* Header with universe color */}
        <div
          className="relative overflow-hidden px-8 pb-6 pt-8 text-white"
          style={{
            background: `linear-gradient(135deg, ${color} 0%, #0F1A38 130%)`,
            color: ink
          }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 backdrop-blur transition-colors hover:bg-white/25"
          >
            ✕
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className="flex h-7 items-center justify-center rounded-md px-2 font-display text-[10px] font-black uppercase tracking-[0.18em]"
              style={{ backgroundColor: ink === "#FFFFFF" ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.15)", color: ink }}
            >
              {universe?.code ?? "L1"} · {typeLabel[s.type] ?? s.type}
            </span>
            {s.isHighlighted && (
              <span className="inline-flex items-center rounded-full bg-lime px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink">
                ★ À la une
              </span>
            )}
            {conflict && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                ⚠ Conflit dans ma journée
              </span>
            )}
          </div>

          <h3 className="mt-5 font-display text-[clamp(1.5rem,3vw,2rem)] font-black leading-tight tracking-tight">
            {s.title}
          </h3>

          <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.22em] opacity-80">
            {fmtHour(s.startsAt)} · {s.durationMin} min · {s.space?.name ?? "Impact Stage"}
          </p>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-8 py-6">
          {s.summary && (
            <p className="text-[15px] leading-relaxed text-ink/75">{s.summary}</p>
          )}

          {s.stage && (
            <div className="mt-6 flex items-center gap-3 rounded-btn border border-line bg-frost px-4 py-3">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path
                  d="M10 17.5s6-6 6-10.5A6 6 0 1 0 4 7c0 4.5 6 10.5 6 10.5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <circle cx="10" cy="7" r="2" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span className="text-[13px] font-semibold text-ink">
                Salle · {s.stage}
              </span>
            </div>
          )}

          {s.speakers.length > 0 && (
            <div className="mt-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50">
                Intervenants
              </p>
              <ul className="mt-3 space-y-2.5">
                {s.speakers.map((ss) => (
                  <li key={ss.speakerId}>
                    <Link
                      href={`/intervenants/${ss.speaker.slug}`}
                      className="flex items-center gap-3 rounded-btn border border-line p-3 transition-colors hover:border-ink/25 hover:bg-frost"
                      onClick={onClose}
                    >
                      <span
                        className="flex h-10 w-10 flex-none items-center justify-center rounded-full font-display text-[12px] font-black text-white"
                        style={{ backgroundColor: color }}
                      >
                        {ss.speaker.fullName
                          .split(" ")
                          .filter(Boolean)
                          .slice(0, 2)
                          .map((p) => p[0])
                          .join("")
                          .toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-display text-[14px] font-bold text-ink">
                          {ss.speaker.fullName}
                        </p>
                        <p className="truncate text-[12px] text-ink/60">
                          {ss.speaker.title} · {ss.speaker.organization}
                        </p>
                      </div>
                      <span className="text-ink/40">→</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-3 border-t border-line bg-white px-8 py-4">
          <button
            type="button"
            onClick={onToggleSave}
            className={cn(
              "flex-1 inline-flex items-center justify-center gap-2 rounded-btn px-5 py-3 text-[13px] font-bold transition-colors",
              saved
                ? "bg-ink text-lime"
                : "bg-lime text-ink hover:bg-lime-600"
            )}
          >
            {saved ? "✓ Dans ma journée" : "+ Ajouter à ma journée"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── JOURNEY DRAWER ────────────────────────────────────── */
function JourneyDrawer({
  days,
  savedSessions,
  savedByDay,
  conflicts,
  onClose,
  onRemove,
  onOpenSession,
  onClearAll
}: {
  days: Day[];
  savedSessions: SessionRow[];
  savedByDay: Map<string, SessionRow[]>;
  conflicts: Set<string>;
  onClose: () => void;
  onRemove: (id: string) => void;
  onOpenSession: (s: SessionRow) => void;
  onClearAll: () => void;
}) {
  const totalMin = savedSessions.reduce((a, s) => a + s.durationMin, 0);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Ma journée"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl"
      >
        {/* Header */}
        <div className="border-b border-line bg-frost px-6 py-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50">
                Ma journée
              </p>
              <p className="mt-1 font-display text-2xl font-black tracking-tight text-ink">
                {savedSessions.length} arrêt{savedSessions.length > 1 ? "s" : ""}
              </p>
              <p className="mt-1 text-[12px] text-ink/60">
                {hours > 0 ? `${hours}h ` : ""}
                {mins > 0 ? `${mins}min ` : ""}
                de programme
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink transition-colors hover:bg-ink hover:text-white"
            >
              ✕
            </button>
          </div>

          {conflicts.size > 0 && (
            <div className="mt-4 flex items-center gap-2 rounded-btn border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-700">
              ⚠ {conflicts.size / 2} conflit
              {conflicts.size > 2 ? "s" : ""} d'horaire
              détecté{conflicts.size > 2 ? "s" : ""}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {savedSessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
              <div className="mb-4 text-6xl">✧</div>
              <p className="font-display text-lg font-bold text-ink">
                Votre journée est vide
              </p>
              <p className="mt-2 max-w-xs text-[13px] text-ink/60">
                Cliquez sur un arrêt de la carte pour l'ajouter à votre parcours
                personnalisé.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-6 btn-lime"
              >
                Explorer la carte
              </button>
            </div>
          ) : (
            <div className="px-6 py-4">
              {days.map((d, dayIdx) => {
                const items = savedByDay.get(d.iso) ?? [];
                if (items.length === 0) return null;
                return (
                  <div key={d.iso} className="mb-6 last:mb-0">
                    <div className="mb-3 flex items-baseline gap-2">
                      <p className="font-display text-[13px] font-black tracking-tight text-ink">
                        Jour 0{dayIdx + 1}
                      </p>
                      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink/50 capitalize">
                        · {fmtWeekday(d.date)}
                      </p>
                    </div>
                    <ul className="space-y-2">
                      {items.map((s) => {
                        const universe = universes.find(
                          (u) => u.slug === s.space?.slug
                        );
                        const color = universe?.color ?? "#2453E0";
                        const hasConflict = conflicts.has(s.id);
                        return (
                          <li key={s.id}>
                            <div
                              className={cn(
                                "group flex items-center gap-3 rounded-btn border p-3 transition-colors",
                                hasConflict
                                  ? "border-red-500/40 bg-red-500/5"
                                  : "border-line bg-white hover:border-ink/20"
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => onOpenSession(s)}
                                className="flex flex-1 items-center gap-3 text-left"
                              >
                                <span
                                  className="flex h-8 w-8 flex-none items-center justify-center rounded-md font-display text-[10px] font-black text-white"
                                  style={{ backgroundColor: color }}
                                >
                                  {fmtHour(s.startsAt)}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-display text-[13px] font-bold text-ink">
                                    {s.title}
                                  </p>
                                  <p className="text-[11px] text-ink/55">
                                    {typeLabel[s.type]} · {s.durationMin}min
                                    {hasConflict && (
                                      <span className="ml-1.5 font-bold text-red-600">
                                        · Conflit
                                      </span>
                                    )}
                                  </p>
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={() => onRemove(s.id)}
                                aria-label="Retirer"
                                className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
                              >
                                ✕
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {savedSessions.length > 0 && (
          <div className="border-t border-line bg-frost px-6 py-4">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={onClearAll}
                className="text-[12px] font-semibold text-ink/60 underline-offset-4 hover:text-red-600 hover:underline"
              >
                Tout retirer
              </button>
              <Link
                href="/inscription"
                className="btn-lime"
                onClick={onClose}
              >
                Réserver mon badge
                <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

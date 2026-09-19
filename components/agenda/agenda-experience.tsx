"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type SessionType = "IMPACT_TALK" | "PANEL" | "WORKSHOP" | "MASTERMIND";
type Pillar =
  | "Innovation"
  | "Impact"
  | "Culture"
  | "Business"
  | "Tech"
  | "Société";

type Session = {
  id: string;
  time: string;
  endTime: string;
  type: SessionType;
  duration: string;
  title: string;
  description: string;
  speaker: string | null;
  speakerRole: string | null;
  pillar: Pillar;
  gate: string;
  accessTier: string | null;
};

const SESSIONS: Session[] = [
  {
    id: "s1",
    time: "09:00",
    endTime: "09:20",
    type: "IMPACT_TALK",
    duration: "20 MIN",
    title: "Le paradoxe du fondateur africain",
    description:
      "Explorer les tensions entre héritage culturel et innovation mondiale.",
    speaker: "Amara Diallo",
    speakerRole: "CEO · ImpactLab",
    pillar: "Impact",
    gate: "GATE A",
    accessTier: null,
  },
  {
    id: "s2",
    time: "09:30",
    endTime: "10:15",
    type: "PANEL",
    duration: "45 MIN",
    title: "IA & Impact systémique : hype vs réalité",
    description:
      "Un panel d'experts décortiquant les promesses et réalités de l'IA pour le développement.",
    speaker: "Nadia Oussedik",
    speakerRole: "CTO · TechDZ",
    pillar: "Tech",
    gate: "GATE A",
    accessTier: null,
  },
  {
    id: "s3",
    time: "11:00",
    endTime: "11:45",
    type: "WORKSHOP",
    duration: "45 MIN",
    title: "Construire des ventures durables",
    description:
      "Méthodologie pratique pour bâtir des startups à impact long terme.",
    speaker: "Kofi Mensah",
    speakerRole: "Partner · Africa Impact",
    pillar: "Business",
    gate: "GATE B",
    accessTier: null,
  },
  {
    id: "s4",
    time: "13:30",
    endTime: "14:00",
    type: "MASTERMIND",
    duration: "30 MIN",
    title: "Scaling impact en marchés émergents",
    description:
      "Session fermée pour accélérer la croissance de vos initiatives.",
    speaker: "Sara Meziane",
    speakerRole: "Creative Director · Cultural Lab",
    pillar: "Innovation",
    gate: "B2B COFFEE",
    accessTier: "VIP+",
  },
  {
    id: "s5",
    time: "14:15",
    endTime: "14:35",
    type: "IMPACT_TALK",
    duration: "20 MIN",
    title: "ClimateTech comme stratégie économique",
    description:
      "Comment la transition écologique devient un avantage compétitif.",
    speaker: "Leila Benali",
    speakerRole: "Minister · Gouvernement",
    pillar: "Société",
    gate: "GATE A",
    accessTier: null,
  },
  {
    id: "s6",
    time: "15:00",
    endTime: "15:35",
    type: "PANEL",
    duration: "35 MIN",
    title: "Médias, culture & nouveau récit africain",
    description:
      "Comment les créateurs redéfinissent l'identité culturelle à l'échelle mondiale.",
    speaker: "Sara Meziane",
    speakerRole: "Creative Director · Cultural Lab",
    pillar: "Culture",
    gate: "GATE C",
    accessTier: null,
  },
  {
    id: "s7",
    time: "16:00",
    endTime: "16:30",
    type: "WORKSHOP",
    duration: "30 MIN",
    title: "Fundraising sans frontières",
    description:
      "Lever des fonds internationaux depuis l'Algérie — stratégies concrètes.",
    speaker: "Yasmine Benali",
    speakerRole: "VC Partner · NordAfrica Ventures",
    pillar: "Business",
    gate: "GATE B",
    accessTier: null,
  },
  {
    id: "s8",
    time: "17:00",
    endTime: "17:30",
    type: "MASTERMIND",
    duration: "30 MIN",
    title: "Deal Flow Session VIP",
    description:
      "Mise en relation exclusive entre investisseurs et fondateurs sélectionnés.",
    speaker: null,
    speakerRole: null,
    pillar: "Business",
    gate: "B2B COFFEE",
    accessTier: "VIP+",
  },
];

const TYPE_META: Record<SessionType, { label: string; color: string }> = {
  IMPACT_TALK: { label: "IMPACT TALK", color: "#2453E0" },
  PANEL: { label: "PANEL", color: "#7C3AED" },
  WORKSHOP: { label: "WORKSHOP", color: "#8FB61E" },
  MASTERMIND: { label: "MASTERMIND", color: "#EC5B4F" },
};

const TYPE_FILTERS: Array<{ label: string; value: "ALL" | SessionType }> = [
  { label: "Tout", value: "ALL" },
  { label: "Impact Talks", value: "IMPACT_TALK" },
  { label: "Panels", value: "PANEL" },
  { label: "Workshops", value: "WORKSHOP" },
  { label: "Masterminds", value: "MASTERMIND" },
];

const PILLARS: Array<{
  label: string;
  value: "ALL" | Pillar;
  icon: React.ReactNode;
}> = [
  {
    label: "Tous les piliers",
    value: "ALL",
    icon: (
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="currentColor"
        aria-hidden
      >
        <circle cx="6" cy="6" r="2" />
      </svg>
    ),
  },
  {
    label: "Innovation",
    value: "Innovation",
    icon: (
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        aria-hidden
      >
        <path
          d="M6 1v2M6 9v2M1 6h2M9 6h2M2.5 2.5l1.4 1.4M8.1 8.1l1.4 1.4M2.5 9.5l1.4-1.4M8.1 3.9l1.4-1.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    label: "Impact",
    value: "Impact",
    icon: (
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        aria-hidden
      >
        <path
          d="m2 8 3-3 2 2 3-4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M7 3h3v3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Culture",
    value: "Culture",
    icon: (
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        aria-hidden
      >
        <circle cx="6" cy="6" r="4.5" />
        <path d="M1.5 6h9M6 1.5c1.5 2 2.3 3.6 2.3 4.5S7.5 8.5 6 10.5C4.5 8.5 3.7 6.9 3.7 6S4.5 3.5 6 1.5Z" />
      </svg>
    ),
  },
  {
    label: "Business",
    value: "Business",
    icon: (
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        aria-hidden
      >
        <rect x="2" y="4" width="8" height="6" rx="1" />
        <path
          d="M4.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    label: "Tech",
    value: "Tech",
    icon: (
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        aria-hidden
      >
        <rect x="3" y="3" width="6" height="6" rx="0.5" />
        <path
          d="M2 5h1M2 7h1M9 5h1M9 7h1M5 2v1M7 2v1M5 9v1M7 9v1"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    label: "Société",
    value: "Société",
    icon: (
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        aria-hidden
      >
        <circle cx="4" cy="4.5" r="1.6" />
        <circle cx="8" cy="5" r="1.4" />
        <path
          d="M1.5 10c0-1.5 1.1-2.5 2.5-2.5s2.5 1 2.5 2.5M6 10c0-1.1.9-2 2-2s2 .9 2 2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export function AgendaExperience() {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"ALL" | SessionType>("ALL");
  const [pillarFilter, setPillarFilter] = useState<"ALL" | Pillar>("ALL");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SESSIONS.filter((s) => {
      if (typeFilter !== "ALL" && s.type !== typeFilter) return false;
      if (pillarFilter !== "ALL" && s.pillar !== pillarFilter) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.speaker?.toLowerCase().includes(q) ?? false) ||
        (s.speakerRole?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [query, typeFilter, pillarFilter]);

  return (
    <>
      {/* ─── COBALT BAND: sub-nav + header ─── */}
      <section className="bg-cobalt text-white">
        <div className="mx-auto w-full max-w-[820px] px-6">
          {/* Header */}
          <div className="flex flex-col items-start justify-between gap-6 py-7 md:flex-row md:items-end md:gap-8">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/65">
                GET+ SUMMIT 2026 · CIC ALGER
              </p>
              <h1 className="mt-2 font-display text-[26px] font-black leading-none tracking-tight text-white">
                Programme
              </h1>
              <p className="mt-2.5 max-w-md text-[10.5px] leading-relaxed text-white/70">
                {filtered.length} session{filtered.length > 1 ? "s" : ""} ·
                Impact Talks, Panels, Workshops & Masterminds répartis sur tous
                les piliers stratégiques.
              </p>
            </div>

            <div className="relative w-full md:w-auto">
              <svg
                aria-hidden
                className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-white/60"
                viewBox="0 0 20 20"
                fill="none"
              >
                <circle
                  cx="9"
                  cy="9"
                  r="6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
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
                placeholder="Chercher une session, un intervenant"
                className="w-full rounded-md border border-white/20 bg-white/[0.08] py-[6px] pl-7 pr-2.5 text-[10px] text-white placeholder:text-white/50 outline-none transition-colors focus:border-white/40 focus:bg-white/[0.14] md:w-[210px]"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ─── FILTER AREA ─── */}
      <section className="border-b border-line bg-white">
        <div className="mx-auto w-full max-w-[820px] px-6 py-3">
          {/* Row 1 — session type */}
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setTypeFilter(f.value)}
                className={cn(
                  "flex-none rounded-md border px-2.5 py-[5px] text-[10px] font-semibold tracking-tight transition-colors",
                  typeFilter === f.value
                    ? "border-cobalt bg-cobalt text-white"
                    : "border-line bg-white text-ink/70 hover:border-ink/25 hover:text-ink",
                )}
                aria-pressed={typeFilter === f.value}
              >
                {f.label}
              </button>
            ))}
            <span className="ml-auto flex-none pl-3 text-[9px] font-medium uppercase tracking-[0.16em] text-ink/45">
              {filtered.length} session{filtered.length > 1 ? "s" : ""}
            </span>
          </div>

          {/* Row 2 — strategic pillars */}
          <div className="mt-2 flex items-center gap-1 overflow-x-auto">
            {PILLARS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPillarFilter(p.value)}
                className={cn(
                  "inline-flex flex-none items-center gap-1 rounded-md px-2 py-[4px] text-[9.5px] font-medium tracking-tight transition-colors",
                  pillarFilter === p.value
                    ? "bg-ink text-white"
                    : "text-ink/55 hover:bg-frost hover:text-ink",
                )}
                aria-pressed={pillarFilter === p.value}
              >
                {p.icon}
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ─── TIMELINE ─── */}
      <section className="min-h-[70vh]" style={{ backgroundColor: "#F4F7FD" }}>
        <div className="mx-auto w-full max-w-[820px] px-6 py-14">
          {filtered.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink/15 bg-white py-16 text-center">
              <p className="text-[11px] font-semibold text-ink/60">
                Aucune session ne correspond aux filtres.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setTypeFilter("ALL");
                  setPillarFilter("ALL");
                }}
                className="mt-3 text-[10px] font-bold text-cobalt underline-offset-4 hover:underline"
              >
                Réinitialiser
              </button>
            </div>
          ) : (
            <ul className="space-y-10">
              {filtered.map((s) => (
                <li key={s.id}>
                  {/* Time row */}
                  <div className="flex items-center gap-3">
                    <span className="font-display text-[19px] font-black leading-none tracking-tight text-cobalt">
                      {s.time}
                    </span>
                    <span className="h-px flex-1 bg-ink/10" />
                    <span className="text-[9px] font-medium uppercase tracking-[0.16em] text-ink/45">
                      1 session
                    </span>
                  </div>

                  {/* Session card */}
                  <div className="mt-4">
                    <SessionCard session={s} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

/* ── SUB-NAV LINK ─────────────────────────────────────── */
function SubLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "relative py-1 text-[10.5px] font-medium tracking-tight transition-colors",
        active ? "text-white" : "text-white/65 hover:text-white",
      )}
    >
      {children}
      {active && (
        <span className="absolute inset-x-0 -bottom-[15px] h-[2px] bg-lime" />
      )}
    </Link>
  );
}

/* ── SESSION CARD ─────────────────────────────────────── */
function SessionCard({ session: s }: { session: Session }) {
  const meta = TYPE_META[s.type];
  const isLight = meta.color === "#8FB61E";

  return (
    <article className="relative w-[240px] overflow-hidden rounded-[8px] border border-line bg-white shadow-[0_1px_2px_rgba(15,26,56,0.04)]">
      {/* Top accent line */}
      <div className="h-[3px]" style={{ backgroundColor: meta.color }} />

      <div className="p-3.5">
        {/* Top row: type · duration · bookmark */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span
              className="text-[8px] font-black uppercase tracking-[0.14em]"
              style={{ color: meta.color }}
            >
              {meta.label}
            </span>
            <span className="text-ink/25">·</span>
            <span className="text-[8px] font-semibold uppercase tracking-[0.14em] text-ink/45">
              {s.duration}
            </span>
          </div>
          <button
            type="button"
            aria-label="Enregistrer"
            className="text-ink/30 transition-colors hover:text-ink"
          >
            <svg
              width="9"
              height="11"
              viewBox="0 0 10 12"
              fill="none"
              aria-hidden
            >
              <path
                d="M1 1h8v10L5 8.5 1 11V1z"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* Title */}
        <h3 className="mt-2 font-display text-[12px] font-bold leading-[1.2] tracking-tight text-ink line-clamp-2">
          {s.title}
        </h3>

        {/* Description */}
        <p className="mt-1.5 text-[9.5px] leading-[1.35] text-ink/55 line-clamp-2">
          {s.description}
        </p>

        {/* Speaker */}
        {s.speaker && (
          <div className="mt-3 flex items-center gap-2">
            <span
              className="flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full text-[9px] font-bold"
              style={{
                backgroundColor: meta.color,
                color: isLight ? "#0A0A0A" : "#FFFFFF",
              }}
              aria-hidden
            >
              {s.speaker.charAt(0)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[9px] font-bold leading-tight text-ink">
                {s.speaker}
              </p>
              {s.speakerRole && (
                <p className="truncate text-[8.5px] leading-tight text-ink/50">
                  {s.speakerRole}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Divider */}
        <div className="my-3 h-px bg-line" />

        {/* Bottom meta */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-ink/55">
            <svg
              width="8"
              height="8"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden
            >
              <circle
                cx="5"
                cy="5"
                r="4"
                stroke="currentColor"
                strokeWidth="1"
              />
              <path
                d="M5 2.5V5l1.5 1"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
            <span>
              {s.time}–{s.endTime}
            </span>
          </div>
          <div className="flex flex-none items-center gap-1">
            <span
              className="rounded-full px-1.5 py-[1px] text-[7.5px] font-bold uppercase tracking-[0.12em]"
              style={{
                backgroundColor: `${meta.color}18`,
                color: meta.color,
              }}
            >
              {s.pillar}
            </span>
            {s.accessTier && (
              <span className="rounded-full bg-lime px-1.5 py-[1px] text-[7.5px] font-black uppercase tracking-[0.12em] text-ink">
                {s.accessTier}
              </span>
            )}
            <span className="rounded-full border border-line px-1.5 py-[1px] text-[7.5px] font-semibold uppercase tracking-[0.12em] text-ink/55">
              {s.gate}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

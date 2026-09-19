"use client";

import type { Prisma } from "@prisma/client";
import { cn } from "@/lib/utils";

type SessionRow = Prisma.SessionGetPayload<{
  include: { speakers: { include: { speaker: true } }; space: true };
}>;

export type Universe = {
  slug: string;
  code: string;
  name: string;
  color: string;
  ink: string;
  terminusOrigin: string;
  terminusEnd: string;
};

export const universes: Universe[] = [
  {
    slug: "get-beyond",
    code: "L1",
    name: "GET BEYOND",
    color: "#2453E0",
    ink: "#FFFFFF",
    terminusOrigin: "Origine",
    terminusEnd: "Futur"
  },
  {
    slug: "get-rooted",
    code: "L2",
    name: "GET ROOTED",
    color: "#8FB61E",
    ink: "#0A0A0A",
    terminusOrigin: "Héritage",
    terminusEnd: "Transmission"
  },
  {
    slug: "get-iconic",
    code: "L3",
    name: "GET ICONIC",
    color: "#EC5B4F",
    ink: "#FFFFFF",
    terminusOrigin: "Studio",
    terminusEnd: "Diffusion"
  },
  {
    slug: "get-connected",
    code: "L4",
    name: "GET CONNECTED",
    color: "#7C3AED",
    ink: "#FFFFFF",
    terminusOrigin: "Rencontre",
    terminusEnd: "Alliance"
  }
];

export const typeLabel: Record<string, string> = {
  KEYNOTE: "Keynote",
  TALK: "Talk",
  PANEL: "Panel",
  FIRESIDE: "Fireside",
  WORKSHOP: "Workshop",
  MASTERCLASS: "Masterclass",
  MASTERMIND: "Mastermind",
  PITCH: "Pitch",
  SHOWCASE: "Showcase"
};

const speakerBg = ["#2453E0", "#111827", "#7C3AED", "#EC5B4F", "#8FB61E"];

function fmtHour(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC"
  }).format(d);
}

function toMinutes(d: Date) {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

export function ProgrammeMap({
  sessions,
  startHour = 7,
  endHour = 20,
  matches,
  selectedId,
  savedIds = new Set(),
  onSelect
}: {
  sessions: SessionRow[];
  startHour?: number;
  endHour?: number;
  matches?: (s: SessionRow) => boolean;
  selectedId?: string | null;
  savedIds?: Set<string>;
  onSelect?: (s: SessionRow) => void;
}) {
  const startMin = startHour * 60;
  const spanMin = (endHour - startHour) * 60;

  const byUniverse = new Map<string, SessionRow[]>();
  for (const u of universes) byUniverse.set(u.slug, []);
  for (const s of sessions) {
    const key = s.space?.slug ?? "get-beyond";
    if (byUniverse.has(key)) byUniverse.get(key)!.push(s);
    else byUniverse.get("get-beyond")!.push(s);
  }

  // Detect interchange columns
  const timeToLines = new Map<number, Set<string>>();
  for (const [slug, items] of byUniverse) {
    for (const s of items) {
      const t = toMinutes(s.startsAt);
      if (!timeToLines.has(t)) timeToLines.set(t, new Set());
      timeToLines.get(t)!.add(slug);
    }
  }
  const interchanges = Array.from(timeToLines.entries())
    .filter(([, set]) => set.size >= 2)
    .map(([t]) => t);

  const majorHours: number[] = [];
  for (let h = startHour; h <= endHour; h++) majorHours.push(h);
  const minorHalves: number[] = [];
  for (let h = startHour; h < endHour; h++) minorHalves.push(h + 0.5);

  const pct = (m: number) =>
    Math.max(0, Math.min(100, ((m - startMin) / spanMin) * 100));

  return (
    <div className="relative overflow-hidden rounded-[24px] border border-line bg-white shadow-[0_28px_60px_-40px_rgba(15,26,56,0.25)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b border-line bg-frost/60 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="font-display text-[11px] font-bold uppercase tracking-[0.24em] text-ink/70">
            Plan du réseau
          </span>
          <span className="hidden text-ink/20 sm:inline">·</span>
          <span className="hidden text-[11px] uppercase tracking-[0.18em] text-ink/50 sm:inline">
            07:00 — 20:00 · 4 lignes
          </span>
        </div>
        <div className="hidden items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-ink/50 md:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-lime" /> Arrêt
          </span>
          <span className="text-ink/20">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="block h-3 w-px bg-ink/40" /> Correspondance
          </span>
          <span className="text-ink/20">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="rounded-sm bg-ink px-1 py-0.5 text-[8px] font-bold text-white">
              T
            </span>
            Terminus
          </span>
        </div>
      </div>

      <div className="relative overflow-x-auto">
        <div className="relative min-w-[960px]">
          {/* Time axis */}
          <div className="grid grid-cols-[180px_1fr] items-end border-b border-line pt-6">
            <div className="pl-6 pr-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/40">
                Heure
              </p>
            </div>
            <div className="relative h-14 pr-8">
              {minorHalves.map((h) => (
                <span
                  key={h}
                  className="absolute bottom-0 h-1.5 w-px bg-ink/10"
                  style={{
                    left: `${((h - startHour) / (endHour - startHour)) * 100}%`
                  }}
                />
              ))}
              {majorHours.map((h) => (
                <div
                  key={h}
                  className="absolute bottom-0 flex flex-col items-center"
                  style={{
                    left: `${((h - startHour) / (endHour - startHour)) * 100}%`,
                    transform: "translateX(-50%)"
                  }}
                >
                  <span className="font-display text-[11px] font-bold tracking-tight text-ink">
                    {h.toString().padStart(2, "0")}:00
                  </span>
                  <span className="mt-1 h-2.5 w-px bg-ink/30" />
                </div>
              ))}
              {interchanges.map((t) => (
                <span
                  key={t}
                  className="absolute -bottom-1 rounded-full bg-ink px-1.5 py-[1px] text-[8px] font-bold uppercase tracking-[0.14em] text-white"
                  style={{
                    left: `${pct(t)}%`,
                    transform: "translateX(-50%)"
                  }}
                >
                  Corresp.
                </span>
              ))}
            </div>
          </div>

          {/* Interchange vertical connectors */}
          <div
            className="pointer-events-none absolute inset-x-0 top-20 z-0"
            style={{ height: `${universes.length * 128}px` }}
          >
            <div className="relative ml-[180px] mr-8 h-full">
              {interchanges.map((t) => (
                <span
                  key={t}
                  className="absolute inset-y-2 w-px"
                  style={{
                    left: `${pct(t)}%`,
                    borderLeft: "1px dashed rgba(10,10,10,0.25)"
                  }}
                />
              ))}
            </div>
          </div>

          {/* Universe rails */}
          {universes.map((u, uIdx) => {
            const items = (byUniverse.get(u.slug) ?? []).sort(
              (a, b) => a.startsAt.getTime() - b.startsAt.getTime()
            );
            return (
              <div
                key={u.slug}
                className={cn(
                  "relative grid grid-cols-[180px_1fr] border-b border-line last:border-b-0",
                  uIdx % 2 === 1 && "bg-frost/40"
                )}
              >
                <div className="flex items-center gap-3 border-r border-line py-10 pl-6 pr-4">
                  <span
                    className="flex h-11 w-11 flex-none items-center justify-center rounded-[10px] font-display text-[15px] font-black tracking-tight"
                    style={{ backgroundColor: u.color, color: u.ink }}
                    aria-hidden
                  >
                    {u.code}
                  </span>
                  <div className="min-w-0">
                    <p
                      className="font-display text-[12px] font-bold uppercase tracking-[0.14em]"
                      style={{ color: u.color }}
                    >
                      {u.name}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ink/45">
                      {items.length} arrêt{items.length > 1 ? "s" : ""}
                      <span className="mx-1.5 text-ink/20">·</span>
                      {items.reduce((a, s) => a + s.durationMin, 0)} min
                    </p>
                  </div>
                </div>

                <div className="relative py-10 pr-8">
                  <div
                    className="absolute inset-x-0 top-1/2 h-[6px] -translate-y-1/2 rounded-full"
                    style={{ backgroundColor: u.color, opacity: 0.18 }}
                  />
                  {items.length > 0 && (
                    <div
                      className="absolute top-1/2 h-[6px] -translate-y-1/2 rounded-full"
                      style={{
                        left: `${pct(toMinutes(items[0].startsAt))}%`,
                        right: `${100 - pct(toMinutes(items[items.length - 1].startsAt))}%`,
                        backgroundColor: u.color
                      }}
                    />
                  )}

                  <Terminus side="left" color={u.color} ink={u.ink} label={u.terminusOrigin} />
                  <Terminus side="right" color={u.color} ink={u.ink} label={u.terminusEnd} />

                  {items.map((s, i) => {
                    const isMatch = matches ? matches(s) : true;
                    const isSelected = selectedId === s.id;
                    const isSaved = savedIds.has(s.id);
                    return (
                      <Station
                        key={s.id}
                        session={s}
                        color={u.color}
                        leftPct={pct(toMinutes(s.startsAt))}
                        widthPct={(s.durationMin / spanMin) * 100}
                        labelAbove={i % 2 === 0}
                        dim={!isMatch}
                        selected={isSelected}
                        saved={isSaved}
                        onSelect={onSelect}
                      />
                    );
                  })}

                  {items.length === 0 && (
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-ink/20 bg-white px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-ink/40">
                      Ligne non desservie ce jour
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Station({
  session: s,
  color,
  leftPct,
  widthPct,
  labelAbove,
  dim,
  selected,
  saved,
  onSelect
}: {
  session: SessionRow;
  color: string;
  leftPct: number;
  widthPct: number;
  labelAbove: boolean;
  dim?: boolean;
  selected?: boolean;
  saved?: boolean;
  onSelect?: (s: SessionRow) => void;
}) {
  const speakers = s.speakers.slice(0, 2);
  return (
    <div
      className={cn(
        "absolute top-1/2 z-10 transition-opacity",
        dim && !selected && "opacity-25"
      )}
      style={{
        left: `${leftPct}%`,
        transform: "translate(-50%, -50%)"
      }}
    >
      <div
        aria-hidden
        className="absolute top-1/2 h-[8px] -translate-y-1/2 rounded-full opacity-[0.35]"
        style={{
          width: `${widthPct * 8}px`,
          maxWidth: "220px",
          minWidth: "8px",
          backgroundColor: color
        }}
      />

      <button
        type="button"
        onClick={() => onSelect?.(s)}
        aria-label={`Ouvrir la fiche de ${s.title}`}
        className={cn(
          "group absolute left-1/2 z-10 w-[178px] -translate-x-1/2 cursor-pointer rounded-[10px] border bg-white p-2.5 text-center shadow-[0_10px_30px_-18px_rgba(15,26,56,0.35)] transition-all outline-none focus-visible:ring-2 focus-visible:ring-cobalt hover:-translate-x-1/2 hover:scale-[1.03] hover:border-ink/25 hover:shadow-[0_16px_40px_-16px_rgba(15,26,56,0.4)]",
          selected ? "border-ink ring-2 ring-lime" : "border-line",
          labelAbove ? "bottom-full mb-5" : "top-full mt-5"
        )}
      >
        <div className="flex items-center justify-center gap-1.5">
          <span
            className="inline-flex items-center rounded-full px-2 py-[2px] text-[9px] font-bold uppercase tracking-[0.16em]"
            style={{
              backgroundColor: color,
              color: color === "#8FB61E" ? "#0A0A0A" : "#FFFFFF"
            }}
          >
            {typeLabel[s.type] ?? s.type}
          </span>
          {s.isHighlighted && (
            <span className="inline-flex items-center rounded-full bg-lime px-1.5 py-[1px] text-[8px] font-bold uppercase tracking-[0.16em] text-ink">
              ★
            </span>
          )}
          {saved && (
            <span
              className="inline-flex items-center rounded-full bg-ink px-1.5 py-[1px] text-[8px] font-bold uppercase tracking-[0.16em] text-lime"
              title="Dans ma journée"
            >
              ♥
            </span>
          )}
        </div>

        <p className="mt-1.5 font-display text-[11.5px] font-extrabold leading-tight tracking-tight text-ink line-clamp-2">
          {s.title}
        </p>

        <div className="mt-1 flex items-center justify-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/55">
          <span>{fmtHour(s.startsAt)}</span>
          <span className="text-ink/25">·</span>
          <span>{s.durationMin}min</span>
        </div>

        {speakers.length > 0 && (
          <div className="mt-2 flex items-center justify-center gap-1.5 border-t border-line/70 pt-1.5">
            <div className="flex -space-x-1.5">
              {speakers.map((ss, i) => (
                <span
                  key={ss.speakerId}
                  className="flex h-4 w-4 items-center justify-center rounded-full border border-white text-[7px] font-bold text-white"
                  style={{ backgroundColor: speakerBg[i % speakerBg.length] }}
                  aria-hidden
                >
                  {initials(ss.speaker.fullName)}
                </span>
              ))}
            </div>
            <span className="truncate text-[10px] text-ink/60">
              {speakers[0].speaker.fullName}
              {s.speakers.length > 2 && (
                <span className="text-ink/40"> +{s.speakers.length - 2}</span>
              )}
            </span>
          </div>
        )}
      </button>

      <span
        aria-hidden
        className={cn(
          "absolute left-1/2 w-px -translate-x-1/2",
          labelAbove ? "bottom-full mb-1 h-4" : "top-full mt-1 h-4"
        )}
        style={{ backgroundColor: color }}
      />

      <span
        className="relative z-10 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white"
        style={{
          boxShadow: selected
            ? `0 0 0 4px ${color}, 0 0 0 6px #B8E62E`
            : `0 0 0 3px ${color}, 0 4px 10px -4px rgba(0,0,0,0.35)`
        }}
        aria-hidden
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      </span>
    </div>
  );
}

function Terminus({
  side,
  color,
  ink,
  label
}: {
  side: "left" | "right";
  color: string;
  ink: string;
  label: string;
}) {
  return (
    <div
      className={cn(
        "absolute top-1/2 z-[5] -translate-y-1/2",
        side === "left" ? "left-0" : "right-0"
      )}
    >
      <div className="flex items-center gap-2">
        {side === "right" && (
          <span
            className="text-[10px] font-bold uppercase tracking-[0.16em]"
            style={{ color }}
          >
            {label}
          </span>
        )}
        <span
          className="flex h-6 items-center justify-center rounded-md px-2 font-display text-[10px] font-black uppercase tracking-[0.16em]"
          style={{ backgroundColor: color, color: ink }}
          aria-label={`Terminus ${label}`}
        >
          T
        </span>
        {side === "left" && (
          <span
            className="text-[10px] font-bold uppercase tracking-[0.16em]"
            style={{ color }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

export function MapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-ink/60">
        Lignes
      </p>
      {universes.map((u) => (
        <span key={u.slug} className="inline-flex items-center gap-2">
          <span
            className="flex h-5 w-5 items-center justify-center rounded-[6px] font-display text-[9px] font-black"
            style={{ backgroundColor: u.color, color: u.ink }}
          >
            {u.code}
          </span>
          <span className="text-[12px] font-semibold text-ink">{u.name}</span>
        </span>
      ))}
    </div>
  );
}

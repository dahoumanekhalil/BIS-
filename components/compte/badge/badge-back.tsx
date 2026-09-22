import { cn } from "@/lib/utils";
import {
  BADGE_ROLE_ACCENTS,
  BIS_EVENT_2027,
  type BadgeRole
} from "@/lib/badge/role";

// Phase 18 — reverse side of the physical-credential badge.
//
// Communicates the EVENT, not the participant. Strong Ink Navy
// composition, restrained Cobalt structural lines, small Lime and
// role-tinted accents. Text is deliberately minimal — this is a
// credential, not a marketing landing page.
//
// Portrait 3:4, matches BadgeFront's dimensions so the two sides
// stack cleanly in the PDF export.

export function BadgeBack({
  role,
  className,
  captureMode = false
}: {
  role: BadgeRole;
  className?: string;
  captureMode?: boolean;
}) {
  const accent = BADGE_ROLE_ACCENTS[role];

  return (
    <article
      className={cn(
        "relative isolate flex aspect-[3/4] w-full flex-col overflow-hidden rounded-[26px] text-white",
        !captureMode &&
          "shadow-[0_30px_80px_-40px_rgba(15,25,60,0.35),inset_0_0_0_1px_rgba(15,25,60,0.06)]"
      )}
      style={{ backgroundColor: "#111827" }}
      aria-label="Badge BIS 2027 — verso"
    >
      {/* Subtle grid overlay for depth. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid-lines-dark opacity-[0.10]"
      />

      {/* Diagonal geometric accent — Cobalt band descending from top-right. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(155deg, transparent 0%, transparent 55%, rgba(36, 83, 224, 0.14) 55%, rgba(36, 83, 224, 0.14) 62%, transparent 62%)"
        }}
      />
      {/* Second diagonal — Lime hairline. Thin, restrained. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(155deg, transparent 0%, transparent 65%, rgba(184, 230, 46, 0.60) 65%, rgba(184, 230, 46, 0.60) 65.6%, transparent 65.6%)"
        }}
      />

      <div
        aria-hidden
        className="pointer-events-none absolute right-[-40px] top-[-40px] h-[220px] w-[220px] rounded-full"
        style={{
          background: `radial-gradient(circle, ${accent.softBg} 0%, transparent 60%)`
        }}
      />

      {/* Header — event mark. */}
      <header className="relative px-6 pt-6">
        <p className="font-display text-[40px] font-black leading-none tracking-tight">
          BIS
          <span style={{ color: "#B8E62E" }}>+</span>
        </p>
        <p className="mt-2 text-[9.5px] font-bold uppercase leading-tight tracking-[0.24em] text-white/70">
          {BIS_EVENT_2027.name}
          <br />
          Édition {BIS_EVENT_2027.edition}
        </p>
      </header>

      {/* Event details block — negative space allowed. */}
      <div className="relative mt-auto px-6 pb-6">
        <div className="mb-5 flex items-center gap-2">
          <span
            aria-hidden
            className="h-[2px] w-8"
            style={{ backgroundColor: accent.stripe }}
          />
          <span className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/60">
            Informations
          </span>
        </div>

        <dl className="grid grid-cols-1 gap-3 text-white">
          <div>
            <dt className="text-[9px] font-bold uppercase tracking-[0.22em] text-white/50">
              Dates
            </dt>
            <dd className="mt-1 font-display text-[16px] font-black leading-tight tracking-tight">
              {BIS_EVENT_2027.datesLabel}
            </dd>
          </div>
          <div>
            <dt className="text-[9px] font-bold uppercase tracking-[0.22em] text-white/50">
              Lieu
            </dt>
            <dd className="mt-1 text-[13px] font-semibold leading-tight text-white">
              {BIS_EVENT_2027.venue}
              <br />
              <span className="text-white/70">{BIS_EVENT_2027.city}</span>
            </dd>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <div>
              <dt className="text-[9px] font-bold uppercase tracking-[0.22em] text-white/50">
                Web
              </dt>
              <dd
                className="mt-1 text-[12px] font-semibold"
                style={{ color: "#B8E62E" }}
              >
                {BIS_EVENT_2027.website}
              </dd>
            </div>
            <div>
              <dt className="text-[9px] font-bold uppercase tracking-[0.22em] text-white/50">
                Hashtag
              </dt>
              <dd
                className="mt-1 font-mono text-[12px] font-semibold text-white"
              >
                {BIS_EVENT_2027.hashtag}
              </dd>
            </div>
          </div>
        </dl>

        <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-3 text-[9.5px] uppercase tracking-[0.20em] text-white/45">
          <span className="font-bold">BIS+ · 2027</span>
          <span className="font-semibold">Business Innovation Summit</span>
        </div>
      </div>
    </article>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type SpeakerCardData = {
  slug: string;
  fullName: string;
  title: string;
  organization: string;
  country?: string | null;
  photoUrl?: string | null;
  cutoutUrl?: string | null;
  pillars: string[];
  accent: string;
};

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function useIsCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: none), (pointer: coarse)");
    setCoarse(mq.matches);
    const handler = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return coarse;
}

export function SpeakerCard({ speaker }: { speaker: SpeakerCardData }) {
  const rootRef = useRef<HTMLAnchorElement>(null);
  const [tapPreview, setTapPreview] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const isTouch = useIsCoarsePointer();

  const cutout = speaker.cutoutUrl ?? speaker.photoUrl ?? null;
  const hasImage = Boolean(cutout);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (reducedMotion) return;
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
      el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
      el.style.setProperty("--px", `${((x - 0.5) * 6).toFixed(2)}px`);
      el.style.setProperty("--py", `${((y - 0.5) * 6).toFixed(2)}px`);
    },
    [reducedMotion]
  );

  const onMouseLeave = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    el.style.setProperty("--px", "0px");
    el.style.setProperty("--py", "0px");
    el.style.setProperty("--mx", "50%");
    el.style.setProperty("--my", "35%");
  }, []);

  // First tap reveals; second tap navigates. Only for coarse pointers.
  const onTouchClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isTouch) return;
    if (!tapPreview) {
      e.preventDefault();
      setTapPreview(true);
    }
  };

  useEffect(() => {
    if (!tapPreview) return;
    const t = setTimeout(() => setTapPreview(false), 4200);
    return () => clearTimeout(t);
  }, [tapPreview]);

  return (
    <Link
      ref={rootRef}
      href={`/intervenants/${speaker.slug}`}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onTouchClick}
      data-active={tapPreview ? "true" : undefined}
      style={
        {
          "--accent": speaker.accent,
          "--mx": "50%",
          "--my": "35%",
          "--px": "0px",
          "--py": "0px"
        } as React.CSSProperties
      }
      className={cn(
        "speaker-card group relative block h-[340px] w-full",
        "outline-none focus-visible:ring-2 focus-visible:ring-cobalt focus-visible:ring-offset-2 focus-visible:ring-offset-frost",
        "rounded-[12px]"
      )}
      aria-label={`${speaker.fullName} — ${speaker.title}, ${speaker.organization}`}
    >
      {/* Card visual layer (clipped) */}
      <div
        aria-hidden
        className={cn(
          "speaker-card__bg absolute inset-0 overflow-hidden rounded-[12px]",
          "border border-line bg-white",
          "transition-[transform,box-shadow,border-color,background-color] duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          "group-hover:-translate-y-1.5 group-hover:border-ink/15 group-hover:shadow-[0_28px_60px_-30px_rgba(15,25,60,0.35)]",
          "group-focus-visible:-translate-y-1.5 group-focus-visible:shadow-[0_28px_60px_-30px_rgba(15,25,60,0.35)]",
          "group-data-[active=true]:-translate-y-1.5 group-data-[active=true]:shadow-[0_28px_60px_-30px_rgba(15,25,60,0.35)]"
        )}
      >
        {/* Atmosphere gradient — appears on hover */}
        <div
          className={cn(
            "absolute inset-0",
            "bg-[radial-gradient(120%_90%_at_50%_120%,rgba(17,24,39,0.55)_0%,rgba(36,83,224,0.35)_38%,rgba(248,250,249,0)_70%)]",
            "opacity-0 transition-opacity duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[active=true]:opacity-100"
          )}
        />

        {/* Faint studio light following the cursor */}
        <div
          className={cn(
            "absolute inset-0",
            "bg-[radial-gradient(220px_180px_at_var(--mx)_var(--my),rgba(255,255,255,0.28),transparent_60%)]",
            "opacity-0 mix-blend-screen transition-opacity duration-500",
            "group-hover:opacity-100"
          )}
        />

        {/* Accent hairline at bottom */}
        <div
          className="absolute inset-x-4 bottom-[92px] h-px opacity-0 transition-opacity duration-500 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[active=true]:opacity-100"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--accent), transparent)"
          }}
        />

        {/* Grid pattern lines — subtle editorial texture on hover */}
        <div
          className={cn(
            "absolute inset-0 opacity-0 transition-opacity duration-700",
            "group-hover:opacity-40 group-focus-visible:opacity-40 group-data-[active=true]:opacity-40"
          )}
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)",
            backgroundSize: "24px 24px"
          }}
        />
      </div>

      {/* Portrait shadow (soft blob) — visible on hover */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-1/2 top-[52%] h-40 w-[70%] -translate-x-1/2",
          "rounded-[100%] blur-2xl",
          "opacity-0 transition-opacity duration-[600ms]",
          "group-hover:opacity-90 group-focus-visible:opacity-90 group-data-[active=true]:opacity-90"
        )}
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(8,13,24,0.6), transparent 65%)"
        }}
      />

      {/* Portrait / subject */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-[96px] z-10 flex items-end justify-center",
          "transition-transform duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          "will-change-transform",
          "group-hover:z-30 group-focus-visible:z-30 group-data-[active=true]:z-30"
        )}
        style={{
          transform:
            "translate3d(var(--px, 0px), var(--py, 0px), 0)"
        }}
      >
        {hasImage ? (
          <div
            className={cn(
              "relative flex h-[260px] w-full items-end justify-center",
              "transition-transform duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
              "group-hover:-translate-y-10 group-hover:scale-[1.1]",
              "group-focus-visible:-translate-y-10 group-focus-visible:scale-[1.1]",
              "group-data-[active=true]:-translate-y-10 group-data-[active=true]:scale-[1.1]"
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={cutout ?? undefined}
              alt=""
              draggable={false}
              className={cn(
                "h-full w-auto max-w-none select-none object-contain object-bottom",
                "drop-shadow-[0_18px_20px_rgba(8,13,24,0.28)]"
              )}
            />
          </div>
        ) : (
          <InitialsSubject
            name={speaker.fullName}
            accent={speaker.accent}
          />
        )}
      </div>

      {/* Top country label */}
      {speaker.country && (
        <div className="pointer-events-none absolute left-4 top-4 z-10">
          <span
            className={cn(
              "inline-flex items-center rounded-full border border-ink/10 bg-white/80 px-2 py-[3px] text-[9px] font-bold uppercase tracking-[0.16em] text-ink/70 backdrop-blur",
              "transition-[color,text-shadow,font-size,padding,background-color,border-color] duration-500",
              "group-hover:border-cobalt/40 group-hover:bg-white/95 group-hover:px-1.5 group-hover:py-[2px] group-hover:text-[8px] group-hover:text-cobalt group-hover:[text-shadow:0_0_10px_rgba(36,83,224,0.75),0_1px_2px_rgba(0,0,0,0.25)]",
              "group-focus-visible:border-cobalt/40 group-focus-visible:bg-white/95 group-focus-visible:px-1.5 group-focus-visible:py-[2px] group-focus-visible:text-[8px] group-focus-visible:text-cobalt group-focus-visible:[text-shadow:0_0_10px_rgba(36,83,224,0.75)]",
              "group-data-[active=true]:border-cobalt/40 group-data-[active=true]:bg-white/95 group-data-[active=true]:px-1.5 group-data-[active=true]:py-[2px] group-data-[active=true]:text-[8px] group-data-[active=true]:text-cobalt group-data-[active=true]:[text-shadow:0_0_10px_rgba(36,83,224,0.75)]"
            )}
          >
            {speaker.country}
          </span>
        </div>
      )}

      {/* Info section (bottom) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-4">
        <div className="min-h-[76px]">
          <h3
            className={cn(
              "font-display text-[15px] font-black leading-[1.15] tracking-tight",
              "text-cobalt [text-shadow:0_0_14px_rgba(36,83,224,0.45),0_1px_2px_rgba(0,0,0,0.15)] transition-[color,text-shadow] duration-500",
              "group-hover:text-lime group-hover:[text-shadow:0_0_18px_rgba(184,230,46,0.6),0_1px_2px_rgba(0,0,0,0.35)]",
              "group-focus-visible:text-lime group-focus-visible:[text-shadow:0_0_18px_rgba(184,230,46,0.6),0_1px_2px_rgba(0,0,0,0.35)]",
              "group-data-[active=true]:text-lime group-data-[active=true]:[text-shadow:0_0_18px_rgba(184,230,46,0.6),0_1px_2px_rgba(0,0,0,0.35)]"
            )}
          >
            {speaker.fullName}
          </h3>
          <p
            className={cn(
              "mt-1 line-clamp-1 text-[11.5px] font-medium leading-tight",
              "text-cobalt/90 [text-shadow:0_0_10px_rgba(36,83,224,0.35)] transition-[color,text-shadow] duration-500",
              "group-hover:text-lime group-hover:[text-shadow:0_0_12px_rgba(184,230,46,0.55)]",
              "group-focus-visible:text-lime group-focus-visible:[text-shadow:0_0_12px_rgba(184,230,46,0.55)]",
              "group-data-[active=true]:text-lime group-data-[active=true]:[text-shadow:0_0_12px_rgba(184,230,46,0.55)]"
            )}
          >
            {speaker.title}
          </p>
          <p
            className={cn(
              "mt-0.5 line-clamp-1 text-[10.5px] font-medium leading-tight",
              "text-cobalt/70 transition-colors duration-500",
              "group-hover:text-lime/85 group-focus-visible:text-lime/85 group-data-[active=true]:text-lime/85"
            )}
          >
            {speaker.organization}
          </p>
        </div>

        {/* Pillars + arrow row */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {speaker.pillars.slice(0, 2).map((p) => (
              <span
                key={p}
                className={cn(
                  "rounded-full border border-ink/15 px-1.5 py-[2px] text-[8.5px] font-bold uppercase tracking-[0.14em] text-ink/60 transition-colors duration-500",
                  "group-hover:border-white/25 group-hover:text-white/80",
                  "group-focus-visible:border-white/25 group-focus-visible:text-white/80",
                  "group-data-[active=true]:border-white/25 group-data-[active=true]:text-white/80"
                )}
              >
                {p}
              </span>
            ))}
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.18em] opacity-0 transition-opacity duration-500",
              "text-lime",
              "group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[active=true]:opacity-100"
            )}
          >
            Profil <span aria-hidden>→</span>
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Editorial fallback subject for speakers without a cutout image.
 * Uses initials on a gradient block to preserve the emerging-subject language.
 */
function InitialsSubject({
  name,
  accent
}: {
  name: string;
  accent: string;
}) {
  const inits = initials(name);
  return (
    <div
      className={cn(
        "relative flex h-[220px] w-[168px] items-end justify-center",
        "transition-transform duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        "group-hover:-translate-y-8 group-hover:scale-[1.08]",
        "group-focus-visible:-translate-y-8 group-focus-visible:scale-[1.08]",
        "group-data-[active=true]:-translate-y-8 group-data-[active=true]:scale-[1.08]"
      )}
    >
      {/* Silhouette base with soft gradient */}
      <div
        className="absolute inset-0 rounded-t-[80px] shadow-[inset_0_-20px_40px_rgba(0,0,0,0.15)] transition-shadow duration-500 group-hover:shadow-[inset_0_-20px_40px_rgba(0,0,0,0.35)]"
        style={{
          background: `linear-gradient(180deg, ${accent}22 0%, ${accent}55 40%, ${accent}CC 100%)`
        }}
      />
      {/* Rising-I mark faintly behind */}
      <div
        aria-hidden
        className="absolute left-1/2 top-3 h-16 w-[2px] -translate-x-1/2 rounded-full opacity-30"
        style={{
          background: `linear-gradient(180deg, ${accent}, transparent)`
        }}
      />
      <span
        className={cn(
          "relative z-[1] mb-6 font-display text-[52px] font-black leading-none tracking-tight",
          "text-white/95 transition-colors duration-500 drop-shadow-[0_8px_18px_rgba(0,0,0,0.35)]"
        )}
      >
        {inits}
      </span>
      {/* Head suggestion — a small circle for the "person emerging" cue */}
      <div
        aria-hidden
        className="absolute left-1/2 top-6 h-[38px] w-[38px] -translate-x-1/2 rounded-full bg-white/20 blur-[1px]"
      />
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type DayNav = {
  index: number;
  iso: string;
  weekday: string;
  dayNum: string;
  count: number;
};

export function ProgrammeDayNav({ days }: { days: DayNav[] }) {
  const [active, setActive] = useState<number>(1);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    // Track which day is currently in view.
    const targets = days
      .map((d) => document.getElementById(`jour-${d.index}`))
      .filter(Boolean) as HTMLElement[];

    const io = new IntersectionObserver(
      (entries) => {
        // Pick the highest-index day whose top has passed the sticky bar.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          const idx = Number(visible[0].target.id.split("-")[1]);
          if (!Number.isNaN(idx)) setActive(idx);
        }
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 }
    );
    targets.forEach((t) => io.observe(t));

    const onScroll = () => setStuck(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, [days]);

  return (
    <div
      className={cn(
        "sticky top-[calc(var(--ticker-height)+var(--nav-height))] z-30 border-y border-line bg-white/95 backdrop-blur transition-shadow",
        stuck && "shadow-[0_10px_30px_-20px_rgba(0,0,0,0.15)]"
      )}
    >
      <div className="container-page">
        <div className="flex items-center justify-between gap-6 py-4">
          <div className="flex items-center gap-1 overflow-x-auto">
            {days.map((d) => (
              <a
                key={d.iso}
                href={`#jour-${d.index}`}
                className={cn(
                  "group flex items-center gap-3 rounded-btn px-4 py-2 text-[13px] font-semibold transition-colors",
                  active === d.index
                    ? "bg-ink text-white"
                    : "text-ink/70 hover:bg-frost hover:text-ink"
                )}
              >
                <span
                  className={cn(
                    "font-display text-[11px] font-bold uppercase tracking-[0.18em]",
                    active === d.index ? "text-lime" : "text-ink/40"
                  )}
                >
                  Jour 0{d.index}
                </span>
                <span className="capitalize">{d.weekday}</span>
                <span
                  className={cn(
                    "hidden text-[11px] font-medium sm:inline",
                    active === d.index ? "text-white/60" : "text-ink/40"
                  )}
                >
                  · {d.count} sessions
                </span>
              </a>
            ))}
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink/50">
              Filtres
            </span>
            <FilterPill label="Format" />
            <FilterPill label="Univers" />
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterPill({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-2 rounded-btn border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-ink/30"
    >
      {label}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
        <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

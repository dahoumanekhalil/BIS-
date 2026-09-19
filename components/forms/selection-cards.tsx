"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SelectionOption = {
  key: string;
  index: string; // "01", "02"
  title: string;
  description: string;
  href: string;
  ctaLabel?: string;
  accent?: "cobalt" | "lime";
};

/**
 * Landing selection layout (two columns): left column has the eyebrow +
 * headline + intro, right column has the cards. Used on pages that OWN the
 * whole viewport (e.g. `/be-a-part` marketing page).
 *
 * If you're rendering inside a FormShell whose left column already provides
 * context, use `<SelectionGrid />` instead.
 */
export function SelectionCards({
  eyebrow,
  title,
  intro,
  options
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  options: SelectionOption[];
}) {
  return (
    <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
      <div className="lg:col-span-5">
        <p className="eyebrow">
          <span className="h-px w-6 bg-black/40" /> {eyebrow}
        </p>
        <h1 className="mt-6 font-display text-display-xl text-balance">
          {title}
        </h1>
        <div className="mt-8 max-w-lg text-lg text-ink/70">{intro}</div>
      </div>

      <div className="lg:col-span-7">
        <SelectionGrid options={options} />
      </div>
    </div>
  );
}

/**
 * Just the grid of selection cards — no left column, no headline. Meant to
 * be dropped inside another container (e.g. FormShell's right column).
 */
export function SelectionGrid({
  options,
  columns = 2
}: {
  options: SelectionOption[];
  columns?: 1 | 2;
}) {
  return (
    <ul
      className={cn(
        "grid gap-4",
        columns === 2 && "sm:grid-cols-2"
      )}
    >
      {options.map((opt) => (
        <li key={opt.key}>
          <Link
            href={opt.href}
            className={cn(
              "group relative flex h-full flex-col justify-between rounded-[28px] border border-black/[0.08] bg-white p-6 transition-all duration-300",
              "hover:-translate-y-0.5 hover:border-black/20 hover:shadow-[0_28px_60px_-32px_rgba(15,25,60,0.28)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt"
            )}
          >
            <div>
              <span className="font-display text-3xl font-black text-cobalt tabular-nums">
                {opt.index}
              </span>
              <h3 className="mt-6 font-display text-2xl font-black tracking-tight text-ink">
                {opt.title}
              </h3>
              <p className="mt-3 text-[14.5px] leading-relaxed text-ink/65">
                {opt.description}
              </p>
            </div>
            <div
              className={cn(
                "mt-6 inline-flex items-center gap-2 text-[12.5px] font-semibold uppercase tracking-[0.18em]",
                opt.accent === "lime" ? "text-ink" : "text-cobalt"
              )}
            >
              <span>{opt.ctaLabel ?? "Continuer"}</span>
              <span
                aria-hidden
                className="transition-transform duration-300 group-hover:translate-x-1"
              >
                →
              </span>
            </div>
            <span
              className={cn(
                "pointer-events-none absolute inset-x-6 top-0 h-[3px] rounded-b-full opacity-0 transition-opacity duration-300 group-hover:opacity-100",
                opt.accent === "lime" ? "bg-lime" : "bg-cobalt"
              )}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Two-column shell used by every /register and /be-a-part form.
 * Left column: context (eyebrow, back link, title, "what happens next").
 * Right column: the form card.
 */
export function FormShell({
  eyebrow,
  backHref,
  backLabel,
  title,
  intro,
  steps,
  aside,
  children
}: {
  eyebrow: string;
  backHref?: string;
  backLabel?: string;
  title: string;
  intro?: ReactNode;
  steps?: { n: string; title: string; body: string }[];
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
      <div className="lg:col-span-5">
        {backHref && (
          <Link
            href={backHref}
            className="inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.2em] text-ink/60 transition-colors hover:text-ink"
          >
            <span aria-hidden>←</span>
            {backLabel ?? "Retour"}
          </Link>
        )}
        <p className={cn("eyebrow", backHref && "mt-6")}>
          <span className="h-px w-6 bg-black/40" /> {eyebrow}
        </p>
        <h1 className="mt-4 font-display text-display-xl text-balance">
          {title}
        </h1>
        {intro && (
          <div className="mt-6 max-w-lg text-lg text-ink/70">{intro}</div>
        )}
        {steps && steps.length > 0 && (
          <div className="mt-10 space-y-6 border-t border-black/[0.08] pt-8">
            {steps.map((s) => (
              <div key={s.n} className="flex gap-5">
                <span className="font-display text-3xl font-bold text-cobalt tabular-nums">
                  {s.n}
                </span>
                <div>
                  <p className="font-display text-lg font-semibold text-ink">
                    {s.title}
                  </p>
                  <p className="mt-1 text-sm text-ink/70">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {aside}
      </div>

      <div className="lg:col-span-7">
        <div className="rounded-[32px] border border-black/[0.08] bg-frost p-6 sm:p-10">
          {children}
        </div>
      </div>
    </div>
  );
}

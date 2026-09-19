import { cn } from "@/lib/utils";

/**
 * Minimal 4-step progress indicator used across the unified /register flow.
 *
 * Steps:
 *   1. Inscription
 *   2. Participation
 *   3. Détails
 *   4. Confirmation
 *
 * Visitor path collapses Step 3 into a lightweight confirmation.
 */

const STEPS = [
  { n: "01", label: "Inscription" },
  { n: "02", label: "Participation" },
  { n: "03", label: "Détails" },
  { n: "04", label: "Confirmation" }
];

export function FormProgress({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <ol
      className="mb-8 flex items-center gap-2 overflow-x-auto text-[10.5px] font-bold uppercase tracking-[0.22em]"
      aria-label="Étapes"
    >
      {STEPS.map((s, i) => {
        const idx = i + 1;
        const active = idx === current;
        const done = idx < current;
        return (
          <li key={s.n} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 min-w-6 items-center justify-center rounded-full px-2 tabular-nums",
                active
                  ? "bg-cobalt text-white"
                  : done
                    ? "bg-lime text-ink"
                    : "bg-black/[0.06] text-ink/40"
              )}
            >
              {s.n}
            </span>
            <span
              className={cn(
                "whitespace-nowrap",
                active
                  ? "text-ink"
                  : done
                    ? "text-ink/70"
                    : "text-ink/35"
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                className={cn(
                  "hidden h-px w-6 sm:inline-block",
                  done ? "bg-lime" : "bg-black/[0.08]"
                )}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

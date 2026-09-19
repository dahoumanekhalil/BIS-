import Link from "next/link";
import { cn } from "@/lib/utils";

// Base card used across the /compte tree. Keeps every panel visually
// coherent: identical border, radius, elevation, and typography for the
// eyebrow / title. Content lives in `children`; an optional trailing
// `action` renders a small link in the top-right.
export function CompteCard({
  eyebrow,
  title,
  action,
  children,
  className
}: {
  eyebrow?: string;
  title?: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[20px] border border-line bg-white p-6 shadow-[0_20px_60px_-40px_rgba(15,25,60,0.15)] sm:p-7",
        className
      )}
    >
      {(eyebrow || title || action) && (
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            {eyebrow && (
              <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
                {eyebrow}
              </p>
            )}
            {title && (
              <h2 className="mt-2 font-display text-xl font-black tracking-tight text-ink">
                {title}
              </h2>
            )}
          </div>
          {action && (
            <Link
              href={action.href}
              className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-semibold text-cobalt hover:text-cobalt-700"
            >
              {action.label}
              <span aria-hidden>→</span>
            </Link>
          )}
        </header>
      )}
      {children}
    </section>
  );
}

// Definition-list row used inside cards for label → value pairs.
export function CompteRow({
  label,
  value
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line/70 py-3.5 first:border-t-0 first:pt-0 last:pb-0">
      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </dt>
      <dd className="min-w-0 text-right text-[13.5px] font-medium text-ink">
        {value ?? <span className="text-ink/40">—</span>}
      </dd>
    </div>
  );
}

import Link from "next/link";
import { cn } from "@/lib/utils";

// Shared presentational primitives for the redesigned admin pages. Pure
// markup — no data access, no hooks — so they are safe in server components.

export type Tone = "ok" | "info" | "warn" | "danger" | "neutral";

export const TONE_CHIP: Record<Tone, string> = {
  ok: "bg-lime/25 text-ink",
  info: "bg-cobalt/10 text-cobalt",
  warn: "bg-amber-100 text-amber-900",
  danger: "bg-red-100 text-red-800",
  neutral: "bg-ink/[0.07] text-ink/70"
};

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-lime-600",
  info: "bg-cobalt",
  warn: "bg-amber-500",
  danger: "bg-red-500",
  neutral: "bg-ink/30"
};

/** Page canvas: soft background so white cards stand out. */
export function PageBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[calc(100vh-76px)] space-y-6 bg-frost p-6 lg:p-8">
      {children}
    </div>
  );
}

export function Card({
  title,
  description,
  action,
  className,
  children
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-line bg-white p-6 shadow-[0_1px_2px_rgba(15,25,60,0.05)]",
        className
      )}
    >
      {(title || action) && (
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            {title && (
              <h2 className="font-display text-[17px] font-bold tracking-tight text-ink">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 text-[13px] text-ink/60">{description}</p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Intro block at the top of a page: heading, one-line help, actions. */
export function PageIntro({
  title,
  description,
  actions
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-6 shadow-[0_1px_2px_rgba(15,25,60,0.05)] sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="font-display text-[22px] font-black tracking-tight text-ink">
          {title}
        </h2>
        <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink/65">
          {description}
        </p>
      </div>
      {actions && <div className="flex flex-wrap gap-2.5">{actions}</div>}
    </section>
  );
}

export function ButtonLink({
  href,
  variant = "secondary",
  children
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center rounded-btn px-4 py-2.5 text-[13.5px] font-semibold transition-colors",
        variant === "primary"
          ? "bg-ink text-white hover:bg-ink/85"
          : "border border-line bg-white text-ink hover:border-ink/30"
      )}
    >
      {children}
    </Link>
  );
}

export function Chip({
  tone = "neutral",
  children
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold",
        TONE_CHIP[tone]
      )}
    >
      {children}
    </span>
  );
}

export function Avatar({
  name,
  size = "md"
}: {
  name: string;
  size?: "sm" | "md";
}) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-cobalt/10 font-bold text-cobalt",
        size === "sm" ? "h-7 w-7 text-[11px]" : "h-10 w-10 text-[13px]"
      )}
    >
      {initials}
    </span>
  );
}

/** Pill-style link used for filter tabs (status, type...). */
export function FilterTab({
  href,
  active,
  label,
  count
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13.5px] font-semibold transition-colors",
        active
          ? "border-ink bg-ink text-white"
          : "border-line bg-white text-ink/75 hover:border-ink/30 hover:text-ink"
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[12px] tabular-nums",
            active ? "bg-white/20 text-white" : "bg-ink/[0.07] text-ink/70"
          )}
        >
          {count.toLocaleString("fr-FR")}
        </span>
      )}
    </Link>
  );
}

export function PaginationNav({
  page,
  totalPages,
  total,
  pageSize,
  hrefFor
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  hrefFor: (page: number) => string;
}) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const btn =
    "inline-flex items-center rounded-btn border px-3.5 py-2 text-[13.5px] font-semibold transition-colors";
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 text-[13.5px] text-ink/65"
    >
      <p>
        {from.toLocaleString("fr-FR")}–{to.toLocaleString("fr-FR")} sur{" "}
        {total.toLocaleString("fr-FR")} · page {page} / {totalPages}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={hrefFor(page - 1)}
            className={cn(btn, "border-line bg-white text-ink hover:border-ink/30")}
          >
            ← Précédent
          </Link>
        ) : (
          <span className={cn(btn, "border-line/60 bg-white/50 text-ink/30")}>
            ← Précédent
          </span>
        )}
        {page < totalPages ? (
          <Link
            href={hrefFor(page + 1)}
            className={cn(btn, "border-line bg-white text-ink hover:border-ink/30")}
          >
            Suivant →
          </Link>
        ) : (
          <span className={cn(btn, "border-line/60 bg-white/50 text-ink/30")}>
            Suivant →
          </span>
        )}
      </div>
    </nav>
  );
}

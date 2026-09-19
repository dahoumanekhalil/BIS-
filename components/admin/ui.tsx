import { cn } from "@/lib/utils";
import Link from "next/link";

export function KpiCard({
  label,
  value,
  hint,
  tone = "default",
  href
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "lime" | "cobalt" | "warn";
  href?: string;
}) {
  const toneRing =
    tone === "lime"
      ? "before:bg-lime"
      : tone === "cobalt"
        ? "before:bg-cobalt"
        : tone === "warn"
          ? "before:bg-amber-400"
          : "before:bg-ink/20";
  const inner = (
    <div
      className={cn(
        "relative rounded-card border border-line bg-white p-5 transition-shadow",
        "before:absolute before:left-0 before:top-4 before:h-6 before:w-[3px] before:rounded-r-full",
        toneRing,
        href && "hover:shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]"
      )}
    >
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        {label}
      </p>
      <p className="mt-3 font-display text-[32px] font-black leading-none tracking-tight text-ink tabular-nums">
        {value}
      </p>
      {hint && (
        <p className="mt-2 text-[12px] text-ink/55">{hint}</p>
      )}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export function StatusBadge({
  status
}: {
  status: string;
}) {
  const s = status.toUpperCase();
  const style =
    s === "CONFIRMED" || s === "PAID" || s === "VALID"
      ? "bg-lime/20 text-ink"
      : s === "PENDING" || s === "UNPAID"
        ? "bg-amber-100 text-amber-900"
        : s === "CANCELLED" || s === "REFUNDED" || s === "FAILED"
          ? "bg-red-100 text-red-800"
          : "bg-ink/10 text-ink/70";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
        style
      )}
    >
      {s}
    </span>
  );
}

export function TierBadge({ tier }: { tier: string | null | undefined }) {
  if (!tier)
    return (
      <span className="inline-flex items-center rounded-full border border-white/60 bg-white px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink/60 shadow-[0_1px_0_rgba(15,25,60,0.04)]">
        —
      </span>
    );
  const style =
    tier === "VVIP"
      ? "bg-cobalt text-white ring-1 ring-inset ring-white/30"
      : tier === "VIP"
        ? "bg-white text-cobalt ring-1 ring-inset ring-cobalt/50"
        : tier === "CONTENT_CREATOR"
          ? "bg-lime text-ink ring-1 ring-inset ring-ink/10"
          : "bg-white text-ink ring-1 ring-inset ring-ink/25";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
        style
      )}
    >
      {tier.replace("_", " ")}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  action
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-white py-16 text-center">
      <p className="font-display text-lg font-bold text-ink">{title}</p>
      {hint && <p className="max-w-md text-[13px] text-ink/60">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ComingSoon({
  title,
  description,
  scope
}: {
  title: string;
  description: string;
  scope: string[];
}) {
  return (
    <div className="rounded-[20px] border border-dashed border-line bg-white p-10">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
        En développement
      </p>
      <h2 className="mt-3 font-display text-2xl font-black tracking-tight text-ink">
        {title}
      </h2>
      <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink/65">
        {description}
      </p>
      <div className="mt-6">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
          Périmètre prévu
        </p>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {scope.map((s) => (
            <li
              key={s}
              className="flex items-start gap-2 text-[13px] text-ink/75"
            >
              <span
                aria-hidden
                className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cobalt"
              />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

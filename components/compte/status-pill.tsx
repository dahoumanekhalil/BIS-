import { cn } from "@/lib/utils";
import type { StatusTone } from "@/lib/account/labels";

// Small reusable status pill for the /compte tree. Keeps tone → color in one
// place; every card that shows "Badge actif" or "Inscription confirmée" uses
// this so the palette stays consistent.
export function StatusPill({
  tone,
  label,
  size = "md"
}: {
  tone: StatusTone;
  label: string;
  size?: "sm" | "md";
}) {
  const toneClasses: Record<StatusTone, string> = {
    ok: "bg-lime/25 text-ink ring-1 ring-inset ring-ink/5",
    wait: "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-900/10",
    danger: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-800/10",
    muted: "bg-ink/8 text-ink/60 ring-1 ring-inset ring-ink/10"
  };
  const sizeClasses =
    size === "sm"
      ? "px-2 py-[3px] text-[9.5px] tracking-[0.16em]"
      : "px-2.5 py-1 text-[10.5px] tracking-[0.18em]";
  const dotColor: Record<StatusTone, string> = {
    ok: "bg-lime-600",
    wait: "bg-amber-500",
    danger: "bg-red-600",
    muted: "bg-ink/40"
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-bold uppercase",
        toneClasses[tone],
        sizeClasses
      )}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", dotColor[tone])}
      />
      {label}
    </span>
  );
}

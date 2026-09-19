import type { Op, RoleTone } from "@/lib/admin/role-catalog";
import { OP_LABEL, OP_SHORT } from "@/lib/admin/role-catalog";

// ---- Tone tokens ---------------------------------------------------------

export const TONE: Record<
  RoleTone,
  {
    ring: string;
    chip: string;
    badge: string;
    gradient: string;
    accent: string;
  }
> = {
  cobalt: {
    ring: "ring-cobalt/20",
    chip: "bg-cobalt text-white",
    badge: "bg-cobalt/10 text-cobalt",
    gradient: "from-cobalt/12 via-cobalt/4 to-transparent",
    accent: "bg-cobalt"
  },
  navy: {
    ring: "ring-navy/25",
    chip: "bg-navy text-white",
    badge: "bg-navy/10 text-navy",
    gradient: "from-navy/12 via-navy/4 to-transparent",
    accent: "bg-navy"
  },
  lime: {
    ring: "ring-lime/50",
    chip: "bg-lime text-ink",
    badge: "bg-lime/25 text-ink",
    gradient: "from-lime/25 via-lime/8 to-transparent",
    accent: "bg-lime"
  },
  gold: {
    ring: "ring-amber-400/40",
    chip: "bg-amber-400 text-ink",
    badge: "bg-amber-400/15 text-amber-700",
    gradient: "from-amber-300/25 via-amber-200/8 to-transparent",
    accent: "bg-amber-400"
  },
  silver: {
    ring: "ring-zinc-300",
    chip: "bg-zinc-200 text-ink",
    badge: "bg-zinc-200 text-zinc-700",
    gradient: "from-zinc-200/60 via-zinc-100/10 to-transparent",
    accent: "bg-zinc-400"
  },
  slate: {
    ring: "ring-slate-300",
    chip: "bg-slate-600 text-white",
    badge: "bg-slate-100 text-slate-700",
    gradient: "from-slate-300/40 via-slate-200/10 to-transparent",
    accent: "bg-slate-500"
  },
  rose: {
    ring: "ring-rose-300",
    chip: "bg-rose-500 text-white",
    badge: "bg-rose-100 text-rose-700",
    gradient: "from-rose-300/25 via-rose-200/8 to-transparent",
    accent: "bg-rose-500"
  }
};

// ---- CRUD chip -----------------------------------------------------------

export function OpChip({
  op,
  granted,
  size = "md"
}: {
  op: Op;
  granted: boolean;
  size?: "sm" | "md";
}) {
  const base =
    size === "sm"
      ? "inline-flex h-5 min-w-[20px] items-center justify-center rounded-md px-1.5 text-[9.5px] font-bold uppercase tracking-[0.06em]"
      : "inline-flex h-6 min-w-[26px] items-center justify-center rounded-md px-2 text-[10px] font-bold uppercase tracking-[0.08em]";

  if (granted) {
    return (
      <span
        title={OP_LABEL[op]}
        aria-label={`${OP_LABEL[op]} — autorisé`}
        className={`${base} bg-lime text-ink shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)]`}
      >
        {OP_SHORT[op]}
      </span>
    );
  }
  return (
    <span
      title={`${OP_LABEL[op]} — refusé`}
      aria-label={`${OP_LABEL[op]} — refusé`}
      className={`${base} bg-red-100 text-red-600`}
    >
      {OP_SHORT[op]}
    </span>
  );
}

// ---- Small building blocks ----------------------------------------------

export function OpsLegend() {
  const items: { op: Op; label: string }[] = [
    { op: "create", label: "Créer" },
    { op: "read", label: "Voir" },
    { op: "update", label: "Modifier" },
    { op: "delete", label: "Supprimer" },
    { op: "export", label: "Exporter" },
    { op: "email", label: "Emailing" }
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-ink/70">
      {items.map(({ op, label }) => (
        <span key={op} className="inline-flex items-center gap-1.5">
          <OpChip op={op} granted size="sm" />
          {label}
        </span>
      ))}
    </div>
  );
}

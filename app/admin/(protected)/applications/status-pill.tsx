import {
  APPLICATION_STATUS_LABEL,
  type ApplicationStatusKey
} from "@/lib/applications";

const TONE: Record<ApplicationStatusKey, { chip: string; dot: string }> = {
  RECEIVED: { chip: "bg-cobalt/10 text-cobalt", dot: "bg-cobalt" },
  UNDER_REVIEW: { chip: "bg-amber-100 text-amber-900", dot: "bg-amber-500" },
  CONTACTED: { chip: "bg-navy/10 text-navy", dot: "bg-navy" },
  APPROVED: { chip: "bg-lime/25 text-ink", dot: "bg-lime-600" },
  REJECTED: { chip: "bg-red-100 text-red-800", dot: "bg-red-500" }
};

export function StatusPill({ status }: { status: ApplicationStatusKey }) {
  const t = TONE[status];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-semibold ${t.chip}`}
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${t.dot}`} />
      {APPLICATION_STATUS_LABEL[status]}
    </span>
  );
}

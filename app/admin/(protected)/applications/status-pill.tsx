import {
  APPLICATION_STATUS_LABEL,
  type ApplicationStatusKey
} from "@/lib/applications";

const TONE: Record<ApplicationStatusKey, string> = {
  RECEIVED: "bg-cobalt/10 text-cobalt",
  UNDER_REVIEW: "bg-amber-100 text-amber-900",
  CONTACTED: "bg-navy/10 text-navy",
  APPROVED: "bg-lime/25 text-ink",
  REJECTED: "bg-red-100 text-red-800"
};

export function StatusPill({ status }: { status: ApplicationStatusKey }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em] ${TONE[status]}`}
    >
      {APPLICATION_STATUS_LABEL[status]}
    </span>
  );
}

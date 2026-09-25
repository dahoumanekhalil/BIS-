"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { StatusBadge, TierBadge } from "@/components/admin/ui";
import { cn } from "@/lib/utils";

const HOVER_DELAY_MS = 1000;

// Payment-removal Phase 2: `paymentStatus` and `paymentAmount` are no
// longer surfaced in the registrants list row. The Prisma columns are
// still populated by legacy data + the admin edit form, but the list
// UI no longer renders them.
export type RegistrantRowData = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  tier: string | null;
  gate: string | null;
  status: string;
  checkedInAt: Date | null;
  createdAt: Date;
  ticketCode: string | null;
};

const dt = (d: Date) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(d);
const dtLong = (d: Date) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);

export function RegistrantRow({ r }: { r: RegistrantRowData }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function scheduleOpen() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
  }
  function cancelAndClose() {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }

  return (
    <tr
      onMouseEnter={scheduleOpen}
      onMouseLeave={cancelAndClose}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      className="relative hover:bg-frost"
    >
      <td className="relative px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0">
            <Link
              href={`/admin/registrants/${r.id}`}
              className="font-semibold text-ink hover:underline"
            >
              {r.firstName} {r.lastName}
            </Link>
            <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
              {r.email}
            </p>
          </div>
        </div>

        {/* Hover card */}
        <HoverCard open={open} r={r} />
      </td>
      <td className="px-4 py-3">
        <TierBadge tier={r.tier} />
      </td>
      <td className="px-4 py-3 text-ink/70">{r.gate ?? "—"}</td>
      <td className="px-4 py-3 text-[12px] text-ink/60">{dt(r.createdAt)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={r.status} />
          {r.checkedInAt && (
            <span className="rounded-full bg-lime/25 px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink">
              In
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center gap-2">
          {r.phone && (
            <a
              href={`tel:${r.phone.replace(/\s+/g, "")}`}
              title={`Appeler ${r.firstName} · ${r.phone}`}
              aria-label={`Appeler ${r.firstName} ${r.lastName}`}
              className="group/call inline-flex items-center gap-1.5 rounded-btn border border-lime bg-lime/25 px-2.5 py-1 text-[11.5px] font-bold text-ink transition-all hover:bg-lime hover:shadow-[0_10px_24px_-14px_rgba(184,230,46,0.9)]"
            >
              <PhoneIcon />
              Appeler
            </a>
          )}
          <Link
            href={`/admin/registrants/${r.id}`}
            className="text-[12px] font-semibold text-cobalt hover:underline"
          >
            Détail →
          </Link>
        </div>
      </td>
    </tr>
  );
}

function HoverCard({ open, r }: { open: boolean; r: RegistrantRowData }) {
  return (
    <div
      role="tooltip"
      aria-hidden={!open}
      className={cn(
        "pointer-events-none absolute left-4 top-full z-40 mt-2 w-[340px] origin-top-left",
        "transition-[opacity,transform] duration-200 ease-out",
        open ? "opacity-100 translate-y-0" : "-translate-y-1 opacity-0"
      )}
    >
      <div className="overflow-hidden rounded-[14px] border border-line bg-white shadow-[0_30px_60px_-30px_rgba(15,25,60,0.35)]">
        {/* Header */}
        <div className="bg-navy px-4 py-3 text-white">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-display text-[15px] font-black leading-tight tracking-tight">
                {r.firstName} {r.lastName}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-white/60">
                {r.email}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <TierBadge tier={r.tier} />
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3">
          <Row label="Téléphone" value={r.phone || "—"} />
          <Row label="Ticket" value={r.ticketCode ?? "—"} mono />
          <Row label="Gate" value={r.gate ?? "—"} />
          <Row label="Statut" value={r.status} />
          <Row
            label="Check-in"
            value={r.checkedInAt ? dtLong(r.checkedInAt) : "Pas encore"}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-line bg-frost px-4 py-2.5">
          {r.phone ? (
            <a
              href={`tel:${r.phone.replace(/\s+/g, "")}`}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-btn border border-lime bg-lime/30 px-2.5 py-1 text-[11px] font-bold text-ink transition-colors hover:bg-lime"
            >
              <PhoneIcon />
              Appeler
            </a>
          ) : (
            <span />
          )}
          <Link
            href={`/admin/registrants/${r.id}`}
            className="pointer-events-auto text-[12px] font-semibold text-cobalt hover:underline"
          >
            Voir le détail →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-[12.5px] font-semibold text-ink",
          mono && "font-mono tracking-wider"
        )}
      >
        {value}
      </p>
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.86 19.86 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.86 19.86 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" />
    </svg>
  );
}

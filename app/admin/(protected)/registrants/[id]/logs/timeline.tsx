"use client";

import { useState } from "react";
import type { ClientLogEvent } from "@/lib/admin/client-logs";
import { cn } from "@/lib/utils";

const CATEGORY_STYLE: Record<
  ClientLogEvent["category"],
  { dot: string; badge: string }
> = {
  account: { dot: "bg-cobalt", badge: "bg-cobalt/10 text-cobalt" },
  profile: { dot: "bg-cobalt", badge: "bg-cobalt/10 text-cobalt" },
  checkin: { dot: "bg-ink", badge: "bg-ink/[0.08] text-ink" },
  email: { dot: "bg-cobalt", badge: "bg-cobalt/10 text-cobalt" },
  security: { dot: "bg-amber-500", badge: "bg-amber-100 text-amber-900" }
};

const STATUS_STYLE: Record<ClientLogEvent["status"], string> = {
  success: "bg-lime/25 text-ink",
  failed: "bg-red-100 text-red-800",
  warn: "bg-amber-100 text-amber-900",
  info: "bg-ink/[0.06] text-ink/70"
};

const CATEGORY_LABEL: Record<ClientLogEvent["category"], string> = {
  account: "Compte",
  profile: "Profil",
  checkin: "Check-in",
  email: "Email",
  security: "Sécurité"
};

function dayKey(d: Date) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  if (day.getTime() === today.getTime()) return "Aujourd'hui";
  if (day.getTime() === yesterday.getTime()) return "Hier";
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year:
      day.getFullYear() === now.getFullYear() ? undefined : "numeric"
  }).format(d);
}

function fmtTime(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function fmtDateTime(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(d);
}

export function LogTimeline({ events }: { events: ClientLogEvent[] }) {
  // Group by day (preserve order — events already sorted DESC).
  const groups: Array<{ key: string; items: ClientLogEvent[] }> = [];
  for (const e of events) {
    const key = dayKey(e.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(e);
    else groups.push({ key, items: [e] });
  }

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.key}>
          <div className="mb-3 flex items-center gap-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              {g.key}
            </p>
            <div className="h-px flex-1 bg-line" />
            <span className="text-[10.5px] uppercase tracking-[0.2em] text-ink/40">
              {g.items.length} événement{g.items.length > 1 ? "s" : ""}
            </span>
          </div>
          <ul className="relative">
            {/* Vertical rail */}
            <div
              aria-hidden
              className="absolute bottom-3 left-[15px] top-3 w-px bg-line"
            />
            {g.items.map((e) => (
              <TimelineItem key={e.id} event={e} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TimelineItem({ event }: { event: ClientLogEvent }) {
  const [open, setOpen] = useState(false);
  const style = CATEGORY_STYLE[event.category];
  const metaEntries = event.metadata
    ? Object.entries(event.metadata).filter(([, v]) => v != null && v !== "")
    : [];

  return (
    <li className="relative pl-10">
      {/* Dot */}
      <span
        aria-hidden
        className={cn(
          "absolute left-3 top-3.5 h-2 w-2 rounded-full ring-4 ring-frost",
          style.dot
        )}
      />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "block w-full rounded-card border border-line bg-white p-4 text-left transition-all",
          "hover:border-ink/20 hover:shadow-[0_18px_40px_-30px_rgba(15,25,60,0.2)]",
          open && "border-cobalt/40 shadow-[0_18px_40px_-30px_rgba(36,83,224,0.35)]"
        )}
      >
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              style.badge
            )}
          >
            {CATEGORY_LABEL[event.category]}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              STATUS_STYLE[event.status]
            )}
          >
            {event.status}
          </span>
          <span className="ml-auto text-[11px] uppercase tracking-[0.18em] text-ink/50">
            {fmtTime(event.timestamp)}
          </span>
        </div>

        <p className="mt-2 font-display text-[15px] font-black tracking-tight text-ink">
          {event.title}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink/65">
          {event.description}
        </p>
        {event.actor && (
          <p className="mt-2 text-[11.5px] text-ink/50">
            par{" "}
            <span className="font-semibold text-ink/80">
              {event.actor.name}
            </span>
            <span className="text-ink/40"> · {event.actor.email}</span>
          </p>
        )}

        {(metaEntries.length > 0 || event.actor) && (
          <p className="mt-3 text-[11px] font-semibold text-cobalt">
            {open ? "Masquer les détails" : "Voir les détails"} →
          </p>
        )}
      </button>

      {open && (
        <div className="ml-0 mt-2 rounded-card border border-line bg-frost/60 p-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            <MetaRow label="Événement" value={event.action} mono />
            <MetaRow label="ID" value={event.id} mono />
            <MetaRow label="Source" value={event.source} />
            <MetaRow label="Horodatage" value={fmtDateTime(event.timestamp)} />
            {event.actor && (
              <>
                <MetaRow label="Opérateur" value={event.actor.name} />
                <MetaRow
                  label="Opérateur (email)"
                  value={event.actor.email}
                />
              </>
            )}
            {metaEntries.map(([k, v]) => (
              <MetaRow
                key={k}
                label={k}
                value={
                  typeof v === "object"
                    ? JSON.stringify(v)
                    : String(v)
                }
                mono={typeof v === "object"}
              />
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}

function MetaRow({
  label,
  value,
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[9.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 break-words text-[12.5px] text-ink",
          mono && "font-mono text-[11.5px]"
        )}
      >
        {value}
      </dd>
    </div>
  );
}

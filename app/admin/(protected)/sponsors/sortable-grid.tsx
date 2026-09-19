"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import type { PartnerTier } from "@prisma/client";
import { cn } from "@/lib/utils";
import { reorderSponsors } from "./actions";
import { DeleteSponsorButton } from "./delete-button";

const TIER_STYLE: Record<PartnerTier, string> = {
  PRESENTING: "bg-cobalt text-white",
  PLATINUM: "bg-ink text-white",
  GOLD: "bg-amber-200 text-amber-900",
  SILVER: "bg-ink/[0.08] text-ink/80",
  ECOSYSTEM: "bg-lime/25 text-ink",
  MEDIA: "bg-cobalt/10 text-cobalt"
};

export type SponsorCard = {
  id: string;
  name: string;
  tier: PartnerTier;
  order: number;
  website: string | null;
  logoUrl: string | null;
};

export function SortableSponsorGrid({
  tier,
  items,
  canManage
}: {
  tier: PartnerTier;
  items: SponsorCard[];
  canManage: boolean;
}) {
  const [list, setList] = useState<SponsorCard[]>(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  // Sync with fresh server data whenever the parent re-fetches.
  const sig = items.map((i) => i.id + ":" + i.order).join(",");
  const prevSig = useRef(sig);
  useEffect(() => {
    if (prevSig.current !== sig) {
      setList(items);
      prevSig.current = sig;
    }
  }, [sig, items]);

  function currentOrder(l: SponsorCard[] = list) {
    return l.map((i) => i.id);
  }

  function persist(next: SponsorCard[]) {
    const orderedIds = currentOrder(next);
    startTransition(async () => {
      const res = await reorderSponsors({ tier, orderedIds });
      if (!res.ok) {
        setBanner({ tone: "error", text: res.error });
        // Roll back on failure.
        setList(items);
        return;
      }
      setBanner({ tone: "success", text: "Ordre mis à jour." });
      // Clear the toast after a moment.
      setTimeout(() => setBanner(null), 1600);
    });
  }

  function onDragStart(id: string) {
    return (e: React.DragEvent<HTMLLIElement>) => {
      if (!canManage) return;
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires some data on the drag payload.
      e.dataTransfer.setData("text/plain", id);
    };
  }

  function onDragOver(id: string) {
    return (e: React.DragEvent<HTMLLIElement>) => {
      if (!canManage || !dragId || dragId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOverId(id);
    };
  }

  function onDragLeave() {
    setOverId(null);
  }

  function onDrop(id: string) {
    return (e: React.DragEvent<HTMLLIElement>) => {
      e.preventDefault();
      if (!canManage || !dragId || dragId === id) return;
      const fromIdx = list.findIndex((i) => i.id === dragId);
      const toIdx = list.findIndex((i) => i.id === id);
      if (fromIdx === -1 || toIdx === -1) return;
      const next = list.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      setList(next);
      setDragId(null);
      setOverId(null);
      persist(next);
    };
  }

  function onDragEnd() {
    setDragId(null);
    setOverId(null);
  }

  return (
    <>
      {banner && (
        <div
          role="status"
          className={cn(
            "mb-3 rounded-btn border px-3 py-1.5 text-[12px]",
            banner.tone === "success"
              ? "border-lime/40 bg-lime/10 text-ink"
              : "border-red-300 bg-red-50 text-red-800"
          )}
        >
          {banner.text}
        </div>
      )}

      <ul
        className={cn(
          "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
          pending && "opacity-90"
        )}
      >
        {list.map((p, idx) => {
          const isDragging = dragId === p.id;
          const isOver = overId === p.id;
          return (
            <li
              key={p.id}
              draggable={canManage}
              onDragStart={onDragStart(p.id)}
              onDragOver={onDragOver(p.id)}
              onDragLeave={onDragLeave}
              onDrop={onDrop(p.id)}
              onDragEnd={onDragEnd}
              className={cn(
                "group flex flex-col overflow-hidden rounded-card border bg-white transition-all",
                canManage && "cursor-grab active:cursor-grabbing",
                "border-line hover:shadow-[0_20px_50px_-30px_rgba(15,25,60,0.25)]",
                isDragging && "opacity-40",
                isOver &&
                  "ring-2 ring-cobalt ring-offset-2 ring-offset-frost translate-y-[-2px]"
              )}
              aria-label={
                canManage ? `Glisser pour réordonner ${p.name}` : p.name
              }
            >
              {/* Position pill + drag handle */}
              <div className="flex items-center justify-between border-b border-line bg-white px-3 py-1.5">
                <span className="rounded-full bg-ink/[0.06] px-2 py-[2px] text-[9.5px] font-bold tabular-nums text-ink/70">
                  #{idx + 1}
                </span>
                {canManage && (
                  <span
                    aria-hidden
                    title="Glisser pour réordonner"
                    className="inline-flex items-center gap-0.5 text-ink/30 transition-colors group-hover:text-ink/60"
                  >
                    <Dots />
                    <Dots />
                  </span>
                )}
              </div>

              {/* Logo */}
              <div className="flex h-32 items-center justify-center bg-frost p-6">
                {p.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.logoUrl}
                    alt={p.name}
                    draggable={false}
                    className="pointer-events-none h-full w-full object-contain"
                  />
                ) : (
                  <span className="font-display text-2xl font-black tracking-tight text-ink/25">
                    {p.name.slice(0, 3).toUpperCase()}
                  </span>
                )}
              </div>

              {/* Info */}
              <div className="flex flex-1 flex-col border-t border-line p-4">
                <p
                  className={cn(
                    "inline-flex w-fit items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
                    TIER_STYLE[p.tier]
                  )}
                >
                  {p.tier}
                </p>
                <h3 className="mt-2 font-display text-[15px] font-black tracking-tight text-ink">
                  {p.name}
                </h3>
                {p.website && (
                  <a
                    href={p.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1 truncate text-[11px] uppercase tracking-[0.18em] text-cobalt hover:underline"
                  >
                    {safeHost(p.website)}
                  </a>
                )}

                {canManage && (
                  <div className="mt-auto flex items-center justify-end gap-2 pt-4">
                    <Link
                      href={`/admin/sponsors/${p.id}/edit`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 rounded-btn border border-line bg-white px-2.5 py-1 text-[11px] font-bold text-ink hover:border-cobalt hover:text-cobalt"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M17 3l4 4L7 21H3v-4L17 3z" />
                      </svg>
                      Modifier
                    </Link>
                    <div onClick={(e) => e.stopPropagation()}>
                      <DeleteSponsorButton id={p.id} name={p.name} />
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Dots() {
  return (
    <svg
      width="6"
      height="14"
      viewBox="0 0 6 14"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="1.5" cy="1.5" r="1.5" />
      <circle cx="1.5" cy="7" r="1.5" />
      <circle cx="1.5" cy="12.5" r="1.5" />
      <circle cx="4.5" cy="1.5" r="1.5" />
      <circle cx="4.5" cy="7" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
    </svg>
  );
}

"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useMemo, useTransition } from "react";
import { cn } from "@/lib/utils";
import type { CheckInResult } from "@prisma/client";

// Client-side filter bar for /admin/scan/analytics.
//
// This is a URL-driven form: every change patches the query string and
// triggers a router push. The server component re-renders with the
// new filters, so nothing is fetched from the browser and no analytics
// data is ever handled here.
//
// Server-only invariants (echoed here as documentation, enforced on
// the server): date shape must be yyyy-mm-dd; accessPointId is opaque
// and validated by a DB lookup; result must be a member of the
// CheckInResult enum.

const RESULT_OPTIONS: readonly {
  value: "" | CheckInResult;
  label: string;
}[] = [
  { value: "", label: "Tous les résultats" },
  { value: "VALID", label: "Validés" },
  { value: "ALREADY_CHECKED_IN", label: "Déjà entrés" },
  { value: "CANCELLED", label: "Annulés" },
  { value: "WRONG_GATE", label: "Mauvaise porte" },
  { value: "WRONG_TIME", label: "Hors créneau" },
  { value: "UNKNOWN", label: "Refusés" }
];

const PRESETS: readonly { key: string; label: string }[] = [
  { key: "today", label: "Aujourd'hui" },
  { key: "yesterday", label: "Hier" },
  { key: "7d", label: "7 derniers jours" },
  { key: "event", label: "Sommet 15-17 Nov" },
  { key: "all", label: "Toute la période" }
];

export type FacetPoint = {
  id: string;
  slug: string;
  name: string;
  type: "MAIN_ENTRANCE" | "ROOM";
};

export type AnalyticsFiltersInitial = {
  from?: string;
  to?: string;
  accessPointId?: string;
  result?: string;
  preset?: string;
};

export function AnalyticsFilters({
  points,
  initial
}: {
  points: FacetPoint[];
  initial: AnalyticsFiltersInitial;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentPreset = initial.preset ?? "";

  const activeCount = useMemo(() => {
    let n = 0;
    if (initial.from) n++;
    if (initial.to) n++;
    if (initial.accessPointId) n++;
    if (initial.result) n++;
    return n;
  }, [initial]);

  function patch(next: Record<string, string | undefined>) {
    const params = new URLSearchParams(search?.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  function applyPreset(preset: string) {
    // Clear any explicit from/to. The server will translate the
    // preset into a concrete window so the URL stays declarative.
    patch({
      preset: preset === "all" ? undefined : preset,
      from: undefined,
      to: undefined
    });
  }

  function reset() {
    startTransition(() => {
      router.push(pathname);
    });
  }

  const mains = points.filter((p) => p.type === "MAIN_ENTRANCE");
  const rooms = points.filter((p) => p.type === "ROOM");

  return (
    <section
      aria-label="Filtres"
      className={cn(
        "rounded-card border border-line bg-white p-4 sm:p-5",
        pending && "opacity-70"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Filtres
          </p>
          <p className="mt-1 text-[12px] text-ink/60">
            {activeCount === 0
              ? "Vue globale — toute la période, tous les points d'accès."
              : `${activeCount} filtre${activeCount > 1 ? "s" : ""} actif${activeCount > 1 ? "s" : ""}.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-btn border border-line bg-white px-3 py-1.5 text-[11.5px] font-semibold text-ink/70 transition-colors hover:border-ink/30 hover:text-ink"
            disabled={pending}
          >
            Réinitialiser
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p.key)}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
              currentPreset === p.key ||
                (!currentPreset && p.key === "all" && !initial.from && !initial.to)
                ? "border-cobalt bg-cobalt/10 text-cobalt"
                : "border-line bg-white text-ink/65 hover:border-ink/30 hover:text-ink"
            )}
            disabled={pending}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Depuis
          </span>
          <input
            type="date"
            value={initial.from ?? ""}
            onChange={(e) => patch({ from: e.target.value || undefined, preset: undefined })}
            className="w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
            disabled={pending}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Jusqu'à
          </span>
          <input
            type="date"
            value={initial.to ?? ""}
            onChange={(e) => patch({ to: e.target.value || undefined, preset: undefined })}
            className="w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
            disabled={pending}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Point d'accès
          </span>
          <select
            value={initial.accessPointId ?? ""}
            onChange={(e) =>
              patch({ accessPointId: e.target.value || undefined })
            }
            className="w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
            disabled={pending}
          >
            <option value="">Tous les points</option>
            {mains.length > 0 && (
              <optgroup label="Entrée principale">
                {mains.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
            {rooms.length > 0 && (
              <optgroup label="Salles">
                {rooms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Résultat
          </span>
          <select
            value={initial.result ?? ""}
            onChange={(e) => patch({ result: e.target.value || undefined })}
            className="w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
            disabled={pending}
          >
            {RESULT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

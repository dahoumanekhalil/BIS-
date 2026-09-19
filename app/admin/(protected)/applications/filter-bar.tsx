"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABEL,
  APPLICATION_TYPES,
  APPLICATION_TYPE_LABEL
} from "@/lib/applications";

export function ApplicationsFilterBar({ total }: { total: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "" || value === "ALL") next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`);
    });
  }

  const q = params.get("q") ?? "";
  const type = params.get("type") ?? "ALL";
  const status = params.get("status") ?? "ALL";

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-white p-3">
      <input
        type="search"
        defaultValue={q}
        placeholder="Rechercher (nom, email, organisation)…"
        onKeyDown={(e) => {
          if (e.key === "Enter") update({ q: e.currentTarget.value });
        }}
        className="min-w-[240px] flex-1 rounded-btn border border-line bg-white px-3 py-2 text-[13px] outline-none transition-colors focus:border-cobalt"
      />
      <select
        value={type}
        onChange={(e) => update({ type: e.target.value })}
        className="rounded-btn border border-line bg-white px-3 py-2 text-[13px] outline-none transition-colors focus:border-cobalt"
      >
        <option value="ALL">Tous les rôles</option>
        {APPLICATION_TYPES.map((t) => (
          <option key={t} value={t}>
            {APPLICATION_TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <select
        value={status}
        onChange={(e) => update({ status: e.target.value })}
        className="rounded-btn border border-line bg-white px-3 py-2 text-[13px] outline-none transition-colors focus:border-cobalt"
      >
        <option value="ALL">Tous les statuts</option>
        {APPLICATION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {APPLICATION_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <span className="ml-auto text-[11.5px] font-semibold uppercase tracking-[0.18em] text-ink/50 tabular-nums">
        {total} résultat{total > 1 ? "s" : ""}
      </span>
    </div>
  );
}

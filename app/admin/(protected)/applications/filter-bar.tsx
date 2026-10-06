"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { cn } from "@/lib/utils";

// Search box + result count. Role and status filters are plain links
// rendered by the page; this component only owns the free-text query.
export function ApplicationsSearch({ total }: { total: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");

  useEffect(() => {
    if ((params.get("q") ?? "") === q.trim()) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set("q", q.trim());
      else next.delete("q");
      next.delete("page");
      startTransition(() => {
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="flex items-center gap-4">
      <label className="relative block w-full min-w-[260px] lg:w-[320px]">
        <span className="sr-only">Rechercher une candidature</span>
        <svg
          className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink/45"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden
        >
          <circle cx="9" cy="9" r="6.25" stroke="currentColor" strokeWidth="1.6" />
          <path d="M14 14l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nom, email ou organisation"
          className="w-full rounded-btn border border-line bg-white py-2.5 pl-10 pr-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink/40 focus:border-cobalt focus:ring-2 focus:ring-cobalt/10"
        />
      </label>
      <p
        className={cn(
          "shrink-0 text-[13.5px] font-semibold tabular-nums text-ink/60",
          pending && "animate-pulse text-cobalt"
        )}
      >
        {pending
          ? "Actualisation…"
          : `${total.toLocaleString("fr-FR")} résultat${total > 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Sub-navigation for the /compte tree. Horizontally scrollable on mobile,
// wraps to a pill row on desktop. Purely presentational — the active state
// is derived from the current pathname.
const TABS = [
  { href: "/compte", label: "Dashboard" },
  { href: "/compte/badge", label: "Mon badge" },
  { href: "/compte/acces", label: "Mes accès" },
  { href: "/compte/inscription", label: "Mon inscription" },
  { href: "/compte/demandes", label: "Mes demandes" },
  { href: "/compte/profil", label: "Mon profil" },
  { href: "/compte/securite", label: "Sécurité" }
] as const;

export function CompteTabs() {
  const pathname = usePathname() ?? "/compte";

  return (
    <nav
      aria-label="Navigation espace personnel"
      className="border-b border-line bg-white"
    >
      <div className="container-page">
        <div
          className={cn(
            "flex snap-x snap-mandatory gap-1 overflow-x-auto",
            // Hide scrollbar on WebKit / Firefox without breaking scroll.
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          )}
        >
          {TABS.map((t) => {
            // "/compte" must not match every subroute — exact-match for the
            // dashboard tab, prefix-match for the rest.
            const isActive =
              t.href === "/compte"
                ? pathname === "/compte"
                : pathname === t.href || pathname.startsWith(`${t.href}/`);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex-none snap-start whitespace-nowrap px-4 py-4 text-[13px] font-medium tracking-tight transition-colors",
                  "sm:px-5",
                  isActive
                    ? "text-cobalt"
                    : "text-ink/55 hover:text-ink"
                )}
              >
                {t.label}
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3 -bottom-px h-[2px] rounded-full transition-opacity duration-200",
                    isActive ? "bg-cobalt opacity-100" : "opacity-0"
                  )}
                />
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

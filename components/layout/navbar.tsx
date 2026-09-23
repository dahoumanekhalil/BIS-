"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { logoutAccount } from "@/app/actions/account";

const links = [
  { href: "/programme", label: "Programme" },
  { href: "/intervenants", label: "Intervenants" },
  { href: "/espaces", label: "Espaces" },
  { href: "/be-a-part", label: "Participer" },
];

export type NavAccount = {
  firstName: string;
  lastName: string;
  email: string;
};

export function Navbar({ account }: { account: NavAccount | null }) {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const overHero = isHome && !scrolled;
  const isLoggedIn = account !== null;
  const initials = account
    ? `${account.firstName.charAt(0)}${account.lastName.charAt(0)}`.toUpperCase()
    : "";

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-[var(--ticker-height)] z-40 h-[var(--nav-height)] transition-all duration-300",
        overHero
          ? "bg-cobalt"
          : "border-b border-line bg-white/95 backdrop-blur",
      )}
    >
      <div className="container-page flex h-full items-center justify-between">
        <div className="flex items-center gap-10">
          <Link
            href="/"
            aria-label="Accueil — BIS 2027"
            className="inline-flex items-baseline gap-1"
          >
            <span className={cn("font-display text-[22px] font-extrabold leading-none tracking-tight transition-colors", overHero ? "text-white" : "text-ink")}>
              GET
              <span className="text-lime">+</span>
            </span>
          </Link>

          <nav
            className="hidden items-center gap-7 md:flex"
            aria-label="Navigation principale"
          >
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "text-[13px] font-medium tracking-tight transition-colors",
                  overHero
                    ? "text-white/85 hover:text-white"
                    : "text-ink/70 hover:text-ink",
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {isLoggedIn ? (
            <div className="hidden items-center gap-3 md:flex">
              <Link
                href="/compte"
                className={cn(
                  "inline-flex items-center gap-2.5 rounded-full border px-3 py-1.5 text-[13px] font-medium tracking-tight transition-colors",
                  overHero
                    ? "border-white/25 text-white hover:border-white/60"
                    : "border-line text-ink hover:border-ink/40"
                )}
                aria-label={`Mon compte — ${account!.firstName} ${account!.lastName}`}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold",
                    overHero ? "bg-lime text-ink" : "bg-cobalt text-white"
                  )}
                  aria-hidden
                >
                  {initials}
                </span>
                <span className="max-w-[120px] truncate">
                  {account!.firstName}
                </span>
              </Link>
              <form action={logoutAccount}>
                <button
                  type="submit"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-[12.5px] font-medium tracking-tight transition-colors",
                    overHero
                      ? "text-white/80 hover:text-white"
                      : "text-ink/60 hover:text-ink"
                  )}
                >
                  Déconnexion
                </button>
              </form>
            </div>
          ) : (
            <>
              <Link
                href="/auth?mode=login"
                className={cn(
                  "hidden text-[13px] font-medium tracking-tight transition-colors md:inline-flex",
                  overHero
                    ? "text-white/85 hover:text-white"
                    : "text-ink/70 hover:text-ink",
                )}
              >
                Se connecter
              </Link>
              <Link
                href="/auth?mode=register"
                className="hidden md:inline-flex btn-lime"
              >
                S&apos;inscrire
                <span aria-hidden>→</span>
              </Link>
            </>
          )}

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={open}
            className={cn(
              "inline-flex h-10 w-10 items-center justify-center rounded-btn border transition-colors md:hidden",
              overHero
                ? "border-white/25 text-white"
                : "border-line text-ink",
            )}
          >
            <span className="relative flex h-3 w-4 flex-col justify-between">
              <span
                className={cn(
                  "block h-[2px] w-full bg-current transition-transform",
                  open && "translate-y-[5px] rotate-45",
                )}
              />
              <span
                className={cn(
                  "block h-[2px] w-full bg-current transition-transform",
                  open && "-translate-y-[5px] -rotate-45",
                )}
              />
            </span>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <div
        className={cn(
          "fixed inset-x-0 top-[calc(var(--ticker-height)+var(--nav-height))] z-40 transition-all duration-300 md:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        <div className="min-h-[calc(100vh-var(--ticker-height)-var(--nav-height))] bg-white">
          <div className="container-page flex h-full flex-col justify-between pb-8 pt-6">
            {isLoggedIn && (
              <div className="mb-4 flex items-center gap-3 rounded-2xl border border-line bg-frost p-4">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-cobalt text-sm font-bold text-white"
                  aria-hidden
                >
                  {initials}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {account!.firstName} {account!.lastName}
                  </p>
                  <p className="truncate text-[12px] text-ink/55">
                    {account!.email}
                  </p>
                </div>
              </div>
            )}

            <nav className="flex flex-col" aria-label="Navigation mobile">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between border-b border-line py-5 font-display text-2xl font-bold tracking-tight text-ink"
                >
                  {l.label}
                  <span className="text-cobalt" aria-hidden>
                    →
                  </span>
                </Link>
              ))}
            </nav>

            <div className="mt-8 flex flex-col gap-3">
              {isLoggedIn ? (
                <>
                  <Link
                    href="/compte"
                    onClick={() => setOpen(false)}
                    className="btn-ghost w-full justify-center"
                  >
                    Mon compte
                  </Link>
                  <form action={logoutAccount} className="w-full">
                    <button
                      type="submit"
                      onClick={() => setOpen(false)}
                      className="btn-lime-lg w-full justify-center"
                    >
                      Se déconnecter
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <Link
                    href="/auth?mode=login"
                    onClick={() => setOpen(false)}
                    className="btn-ghost w-full justify-center"
                  >
                    Se connecter
                  </Link>
                  <Link
                    href="/auth?mode=register"
                    onClick={() => setOpen(false)}
                    className="btn-lime-lg w-full justify-center"
                  >
                    S&apos;inscrire maintenant
                    <span aria-hidden>→</span>
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

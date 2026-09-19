"use client";

import { usePathname } from "next/navigation";
import { LiveTicker } from "./ticker";
import { Navbar, type NavAccount } from "./navbar";
import { Footer } from "./footer";
import { cn } from "@/lib/utils";

export function SiteFrame({
  children,
  account
}: {
  children: React.ReactNode;
  account: NavAccount | null;
}) {
  const pathname = usePathname();
  const isAdmin = pathname?.startsWith("/admin") ?? false;

  return (
    <>
      {!isAdmin && <LiveTicker />}
      {!isAdmin && <Navbar account={account} />}
      <main
        className={cn(
          !isAdmin && "pt-[calc(var(--ticker-height)+var(--nav-height))]",
          isAdmin && "min-h-screen"
        )}
      >
        {children}
      </main>
      {!isAdmin && <Footer />}
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Reveals its children with a fade + upward lift when scrolled into view.
 * Under prefers-reduced-motion the entrance is skipped and content
 * appears in its final position immediately.
 */
type RevealTag = "div" | "li" | "section" | "article" | "span";

export function Reveal({
  children,
  delay = 0,
  className,
  as = "div"
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: RevealTag;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (reduced) {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commonProps: any = {
    ref,
    style: { transitionDelay: `${delay}ms` },
    className: cn(
      "transition-[opacity,transform] duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
      shown ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
      className
    )
  };

  switch (as) {
    case "li":
      return <li {...commonProps}>{children}</li>;
    case "section":
      return <section {...commonProps}>{children}</section>;
    case "article":
      return <article {...commonProps}>{children}</article>;
    case "span":
      return <span {...commonProps}>{children}</span>;
    default:
      return <div {...commonProps}>{children}</div>;
  }
}

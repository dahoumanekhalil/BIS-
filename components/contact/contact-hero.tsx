"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { RisingI } from "@/components/rising-i";
import { Reveal } from "./reveal";

export function ContactHero() {
  const ref = useRef<HTMLDivElement>(null);

  // Very subtle cursor parallax on the Rising-I mark (max 6px).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (reduced) return;
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const px = ((e.clientX / w) - 0.5) * 12; // -6px..+6px
      const py = ((e.clientY / h) - 0.5) * 10; // -5px..+5px
      el.style.setProperty("--px", `${px.toFixed(2)}px`);
      el.style.setProperty("--py", `${py.toFixed(2)}px`);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <section className="relative isolate overflow-hidden bg-navy text-white">
      <div
        className="pointer-events-none absolute inset-0 grid-lines-dark opacity-30"
        aria-hidden
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-0 h-[640px] w-[640px] rounded-full bg-cobalt/30 blur-3xl animate-[contact-drift-a_18s_ease-in-out_infinite] motion-reduce:animate-none"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -left-24 h-[420px] w-[420px] rounded-full bg-lime/20 blur-3xl animate-[contact-drift-b_22s_ease-in-out_infinite] motion-reduce:animate-none"
      />

      <div className="container-page relative pb-24 pt-16 lg:pb-32 lg:pt-24">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-7">
            <Reveal>
              <div className="flex items-center gap-3">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-lime" />
                </span>
                <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-white/80">
                  BIS · Contact
                </p>
              </div>
            </Reveal>

            <Reveal delay={120}>
              <h1 className="mt-8 font-display text-[clamp(2.75rem,7.5vw,6.25rem)] font-black leading-[0.92] tracking-tighter text-white">
                Parlons
                <br />
                <span className="text-lime">d&apos;impact.</span>
              </h1>
            </Reveal>

            <Reveal delay={240}>
              <p className="mt-8 max-w-xl text-[17px] leading-relaxed text-white/70">
                Une question, une collaboration, un partenariat ou l&apos;envie
                d&apos;échanger avec l&apos;équipe BIS 2026 — écrivez-nous.
                Nous répondons sous 48 heures ouvrées.
              </p>
            </Reveal>

            <Reveal delay={360}>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                <a
                  href="#form"
                  className="btn-lime-lg"
                >
                  Écrire à l&apos;équipe
                  <span aria-hidden>→</span>
                </a>
                <Link href="/inscription" className="btn-outline-white">
                  Réserver mon billet
                </Link>
              </div>
            </Reveal>

            <Reveal delay={480}>
              <div className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-3 text-[11px] uppercase tracking-[0.22em] text-white/50">
                <span>15 · 17 Nov 2026</span>
                <span>CIC Alger</span>
                <span>12 611+ Attendus</span>
              </div>
            </Reveal>
          </div>

          <div className="hidden lg:col-span-5 lg:block">
            <Reveal delay={200}>
              <div
                ref={ref}
                className="relative mx-auto flex h-full w-full items-center justify-center"
                style={
                  {
                    "--px": "0px",
                    "--py": "0px"
                  } as React.CSSProperties
                }
              >
                <div
                  aria-hidden
                  className="absolute inset-0 rounded-[36px] border border-white/10 bg-white/[0.03] backdrop-blur-sm"
                />
                <div
                  className="relative flex h-[420px] w-[320px] items-center justify-center transition-transform duration-500 ease-out will-change-transform"
                  style={{
                    transform:
                      "translate3d(var(--px, 0px), var(--py, 0px), 0)"
                  }}
                >
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-full bg-cobalt/40 blur-3xl"
                  />
                  <RisingI className="relative z-10 h-[380px] w-auto opacity-90" />
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

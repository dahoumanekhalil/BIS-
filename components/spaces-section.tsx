import Link from "next/link";
import type { Space } from "@prisma/client";

export function SpacesSection({ spaces }: { spaces: Space[] }) {
  return (
    <section id="espaces" className="section-padding relative overflow-hidden bg-brand-ink text-white">
      <div className="pointer-events-none absolute inset-0 grid-lines-invert opacity-40" aria-hidden />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-40 h-[500px] w-[500px] rounded-full bg-brand-blue/40 blur-3xl"
      />

      <div className="container-wide relative">
        <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow-invert">
              <span className="h-px w-6 bg-white/40" /> Univers
            </p>
            <h2 className="mt-6 font-display text-display-xl text-balance">
              4 univers,
              <br />
              <span className="text-brand-lime">4 expériences.</span>
            </h2>
          </div>
          <p className="max-w-md text-lg text-white/70">
            Le sommet est organisé autour de quatre univers thématiques, chacun
            avec sa scène, son ton et sa communauté.
          </p>
        </div>

        <ul className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2">
          {spaces.map((sp, i) => (
            <li
              key={sp.id}
              className="group relative overflow-hidden rounded-[32px] border border-white/10 bg-white/[0.03] transition-all hover:border-white/30 hover:bg-white/[0.05]"
            >
              <div className="grid gap-6 p-8 sm:p-10 md:min-h-[420px] md:grid-rows-[auto_1fr_auto]">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/50">
                    Univers 0{i + 1}
                  </span>
                  <div
                    className="h-12 w-12 rounded-full"
                    style={{ backgroundColor: sp.color }}
                    aria-hidden
                  />
                </div>
                <div>
                  <h3 className="font-display text-4xl font-semibold tracking-tight md:text-5xl">
                    {sp.name}
                  </h3>
                  <p className="mt-4 max-w-md text-lg italic text-white/70">
                    {sp.headline}
                  </p>
                  <p className="mt-6 max-w-md text-sm leading-relaxed text-white/60">
                    {sp.description}
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <Link
                    href="/espaces"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-brand-lime underline-offset-4 hover:underline"
                  >
                    Explorer l'univers
                    <span aria-hidden>→</span>
                  </Link>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                    {sp.slug}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

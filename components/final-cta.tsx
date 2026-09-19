import Link from "next/link";
import { RisingI } from "@/components/rising-i";

export function FinalCTA() {
  return (
    <section className="relative isolate overflow-hidden bg-cobalt text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[820px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[580px] w-[580px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[320px] w-[320px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15"
      />
      <div className="pointer-events-none absolute inset-0 grid-lines-dark opacity-25" aria-hidden />

      <div className="container-page relative py-24 text-center lg:py-32">
        <div className="mx-auto max-w-3xl">
          <div className="mx-auto mb-10 h-24 w-24 opacity-80">
            <RisingI />
          </div>
          <h2 className="font-display text-section-xl text-white sm:text-[3.5rem]">
            Rejoignez le mouvement
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-white/80">
            Places limitées. Inscrivez-vous maintenant pour garantir votre accès
            au BIS Algeria — 15 Novembre 2026.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/inscription" className="btn-lime-lg">
              S'inscrire maintenant
              <span aria-hidden>→</span>
            </Link>
            <Link href="/programme" className="btn-outline-white">
              Voir le programme
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";

export function ContactCTA() {
  return (
    <section className="relative isolate overflow-hidden bg-navy text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-cobalt/30 blur-3xl animate-[contact-drift-a_20s_ease-in-out_infinite] motion-reduce:animate-none"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 right-10 h-[320px] w-[320px] rounded-full bg-lime/15 blur-3xl animate-[contact-drift-b_24s_ease-in-out_infinite] motion-reduce:animate-none"
      />

      <div className="container-page relative py-20 lg:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow-invert justify-center">
            <span className="h-px w-6 bg-white/40" /> BIS 2027
          </p>
          <h2 className="mt-6 font-display text-[clamp(2rem,4.8vw,3.75rem)] font-black leading-[0.95] tracking-tight">
            Une idée.
            <br />
            Une question.
            <br />
            <span className="text-lime">Un impact.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[15px] leading-relaxed text-white/70">
            La conversation commence ici. Rejoignez BIS 2027 pour construire
            l&apos;écosystème de l&apos;impact africain.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link href="/inscription" className="btn-lime-lg">
              S&apos;inscrire au BIS
              <span aria-hidden>→</span>
            </Link>
            <Link href="/programme" className="btn-outline-white">
              Découvrir le programme
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

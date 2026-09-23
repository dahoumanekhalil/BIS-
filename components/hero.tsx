import Link from "next/link";
import { RisingI } from "@/components/rising-i";

export function Hero() {
  return (
    <section
      className="hero-flush relative isolate overflow-hidden bg-cobalt text-white"
      aria-label="Hero"
    >
      {/* Decorative oversized circles */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 -top-40 h-[720px] w-[720px] rounded-full border border-white/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 top-24 h-[520px] w-[520px] rounded-full border border-white/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-72 -left-40 h-[520px] w-[520px] rounded-full bg-cobalt-800/50 blur-3xl"
      />
      <div
        className="pointer-events-none absolute inset-0 grid-lines-dark opacity-40"
        aria-hidden
      />

      <div
        className="container-page relative pb-16 lg:pb-12"
        style={{
          paddingTop: "calc(var(--ticker-height) + var(--nav-height) + 48px)",
        }}
      >
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-8">
          {/* LEFT — content */}
          <div className="lg:col-span-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/80">
              BIS · ALGERIA · 3-5 JANVIER 2027
            </p>

            <h1 className="mt-6 font-display text-hero-xl text-balance text-white">
              Le sommet
              <br />
              de l'
              <span className="text-lime">impact</span>
              <br />
              africain
            </h1>

            <p className="mt-6 max-w-[500px] text-base leading-relaxed text-white/80 sm:text-[17px]">
              Réunissant les visionnaires, créateurs et acteurs du changement de
              demain. Trois piliers :{" "}
              <span className="text-white">Identity</span>,{" "}
              <span className="text-white">Growth</span> et{" "}
              <span className="text-white">Legacy</span>.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/inscription" className="btn-lime-lg">
                S'inscrire maintenant
                <span aria-hidden>→</span>
              </Link>
              <Link href="/programme" className="btn-outline-white">
                Voir le programme
              </Link>
            </div>

            <ul className="mt-8 flex flex-wrap items-center gap-2.5">
              <li>
                <span className="chip">
                  <IconCalendar />
                  3-5 Janvier 2027
                </span>
              </li>
              <li>
                <span className="chip">
                  <IconPin />
                  BIS · Algeria
                </span>
              </li>
              <li>
                <span className="chip">
                  <IconPeople />
                  12 000+ participants
                </span>
              </li>
            </ul>
          </div>

          {/* RIGHT — Rising I visual */}
          <div className="relative lg:col-span-5">
            <div className="relative mx-auto aspect-square w-full max-w-[520px]">
              {/* Concentric rings */}
              <div className="absolute inset-0 rounded-full border border-white/15" />
              <div className="absolute inset-[8%] rounded-full border border-white/10" />
              <div className="absolute inset-[18%] rounded-full border border-white/10" />
              <div className="absolute inset-[30%] rounded-full border border-white/15" />
              {/* Rising I mark */}
              <div className="absolute inset-[15%] flex items-center justify-center">
                <RisingI className="text-white/90" />
              </div>
              {/* Small orbit dot */}
              <div
                aria-hidden
                className="absolute left-1/2 top-2 h-2 w-2 -translate-x-1/2 rounded-full bg-lime shadow-[0_0_16px_rgba(184,230,46,0.9)]"
              />
            </div>
          </div>
        </div>

        {/* DISCOVER scroll indicator */}
        <div className="mt-14 flex justify-center lg:mt-20">
          <a
            href="#stats"
            className="group inline-flex flex-col items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.32em] text-white/70 transition-colors hover:text-white"
          >
            <span>Discover</span>
            <svg
              width="12"
              height="14"
              viewBox="0 0 12 14"
              fill="none"
              className="transition-transform group-hover:translate-y-1"
              aria-hidden
            >
              <path
                d="M6 1v12M1.5 8.5 6 13l4.5-4.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        </div>
      </div>
    </section>
  );
}

function IconCalendar() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4.5" width="14" height="12" rx="1.5" />
      <path d="M3 8h14M7 3v3M13 3v3" />
    </svg>
  );
}
function IconPin() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 17.5s6-6 6-10.5A6 6 0 1 0 4 7c0 4.5 6 10.5 6 10.5Z" />
      <circle cx="10" cy="7" r="2" />
    </svg>
  );
}
function IconPeople() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="7" cy="8" r="3" />
      <circle cx="14" cy="9" r="2.5" />
      <path d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5" />
      <path d="M12 17c0-2 1.5-4 4-4a4 4 0 0 1 2 .5" />
    </svg>
  );
}

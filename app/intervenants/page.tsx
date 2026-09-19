import Link from "next/link";
import { getAllSpeakers } from "@/lib/queries";
import { SpeakersDirectory } from "@/components/speakers/speakers-directory";
import type { SpeakerCardData } from "@/components/speakers/speaker-card";

export const metadata = {
  title: "Intervenants",
  description:
    "Les intervenants de BIS 2026 — fondateurs, décideurs, chercheurs et créateurs qui façonnent l'avenir de l'impact africain."
};

export const revalidate = 300;

// Pillar assignments — deterministic based on speaker order so the same
// speaker always keeps the same tags. Two pillars per speaker.
const PILLAR_ROTATION: Array<[string, string]> = [
  ["Impact", "Business"],
  ["Innovation", "Tech"],
  ["Business", "Innovation"],
  ["Culture", "Impact"],
  ["Innovation", "Impact"],
  ["Tech", "Innovation"],
  ["Culture", "Société"],
  ["Business", "Impact"],
  ["Culture", "Innovation"],
  ["Tech", "Impact"]
];

const PILLAR_ACCENT: Record<string, string> = {
  Innovation: "#2453E0",
  Impact: "#B8E62E",
  Culture: "#EC5B4F",
  Business: "#111827",
  Tech: "#7C3AED",
  Société: "#F5A524"
};

// Cutout portraits available in /public/speakers/. Indexed by speaker order.
const CUTOUT_BY_INDEX: Record<number, string> = {
  0: "/speakers/1.webp",
  1: "/speakers/2.png",
  2: "/speakers/3.png",
  3: "/speakers/4.png"
};

// Fallback cutout used for any speaker without a dedicated portrait.
const DEFAULT_CUTOUT = "/speakers/55.png";

export default async function SpeakersPage() {
  const speakers = await getAllSpeakers();

  const data: SpeakerCardData[] = speakers.map((s, i) => {
    const pillars = PILLAR_ROTATION[i % PILLAR_ROTATION.length];
    const cutoutUrl = CUTOUT_BY_INDEX[i] ?? s.photoUrl ?? DEFAULT_CUTOUT;
    return {
      slug: s.slug,
      fullName: s.fullName,
      title: s.title,
      organization: s.organization,
      country: s.country,
      photoUrl: s.photoUrl,
      cutoutUrl,
      pillars: [...pillars],
      accent: PILLAR_ACCENT[pillars[0]] ?? "#2453E0"
    };
  });

  return (
    <>
      {/* HERO — matches the Programme page visual language */}
      <section className="relative isolate overflow-hidden bg-navy text-white">
        <div
          className="pointer-events-none absolute inset-0 grid-lines-dark opacity-30"
          aria-hidden
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-40 top-0 h-[620px] w-[620px] rounded-full bg-cobalt/30 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -right-32 h-[420px] w-[420px] rounded-full bg-lime/15 blur-3xl"
        />

        <div className="container-page relative pb-20 pt-16 lg:pb-24 lg:pt-24">
          <div className="grid gap-12 lg:grid-cols-12 lg:gap-10">
            <div className="lg:col-span-8">
              <div className="flex items-center gap-3">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-lime" />
                </span>
                <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-white/80">
                  GET+ SUMMIT 2026 · CIC ALGER
                </p>
              </div>

              <h1 className="mt-8 font-display text-[clamp(2.75rem,7vw,6rem)] font-black leading-[0.92] tracking-tighter text-white">
                Des voix
                <br />
                <span className="text-lime">qui comptent.</span>
              </h1>

              <p className="mt-8 max-w-xl text-[17px] leading-relaxed text-white/70">
                Découvrez les visionnaires, créateurs, entrepreneurs et
                décideurs qui façonnent l&apos;avenir de l&apos;impact africain.
                Une nouvelle vague de speakers rejoint la programmation chaque
                semaine.
              </p>

              <div className="mt-10 flex flex-wrap items-center gap-3">
                <Link href="/inscription" className="btn-lime-lg">
                  Réserver mon billet
                  <span aria-hidden>→</span>
                </Link>
                <Link href="/programme" className="btn-outline-white">
                  Voir le programme
                </Link>
              </div>
            </div>

            <div className="lg:col-span-4">
              <div className="relative rounded-[24px] border border-white/10 bg-white/[0.04] p-7 backdrop-blur">
                <p className="font-display text-[11px] font-bold uppercase tracking-[0.22em] text-white/60">
                  Édition 2026
                </p>
                <p className="mt-2 font-display text-3xl font-black tracking-tight text-white">
                  {speakers.length}+ voix confirmées
                </p>
                <p className="mt-3 text-[13px] text-white/60">
                  Un plateau international réunissant les architectes de la
                  prochaine décennie africaine autour de trois piliers :
                  Identity, Growth, Legacy.
                </p>

                <ul className="mt-6 space-y-2.5 border-t border-white/10 pt-5">
                  {[
                    { label: "Fondateurs & CEOs", value: "18" },
                    { label: "Investisseurs", value: "9" },
                    { label: "Créatifs & Culture", value: "12" },
                    { label: "Chercheurs & Tech", value: "9" }
                  ].map((row) => (
                    <li
                      key={row.label}
                      className="flex items-baseline justify-between gap-4 text-[12px]"
                    >
                      <span className="text-white/60">{row.label}</span>
                      <span className="font-display text-base font-black tracking-tight text-white">
                        {row.value}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Directory */}
      <section className="bg-frost">
        <div className="container-page py-16 lg:py-20">
          <div className="mb-8 max-w-2xl">
            <p className="eyebrow">
              <span className="h-px w-6 bg-ink/40" /> Intervenants
            </p>
            <h2 className="mt-4 font-display text-[clamp(1.75rem,3.2vw,2.75rem)] font-black tracking-tight">
              Le plateau BIS 2026.
            </h2>
            <p className="mt-3 text-[15px] text-ink/65">
              Chaque intervenant est associé à un ou deux piliers stratégiques.
              Filtrez par pilier ou cherchez un nom pour découvrir chaque profil.
            </p>
          </div>

          <SpeakersDirectory speakers={data} />
        </div>
      </section>

      {/* Closing CTA */}
      <section className="relative isolate overflow-hidden bg-navy text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-cobalt/30 blur-3xl"
        />
        <div className="container-page relative py-20 lg:py-24">
          <div className="mx-auto max-w-3xl text-center">
            <p className="eyebrow-invert justify-center">
              <span className="h-px w-6 bg-white/40" /> Rejoindre le sommet
            </p>
            <h2 className="mt-6 font-display text-[clamp(2rem,4.5vw,3.5rem)] font-black leading-[0.95] tracking-tight">
              Partagez la scène.
              <br />
              Portez votre voix.
            </h2>
            <p className="mx-auto mt-6 max-w-xl text-[15px] leading-relaxed text-white/70">
              Vous pensez qu&apos;une voix manque à ce plateau ? Envoyez-nous
              votre profil ou celui d&apos;une personnalité qui devrait
              s&apos;exprimer à BIS 2026.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link href="/contact" className="btn-lime-lg">
                Proposer un intervenant
                <span aria-hidden>→</span>
              </Link>
              <Link href="/inscription" className="btn-outline-white">
                Réserver mon billet
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

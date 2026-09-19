import type { Metadata } from "next";
import Link from "next/link";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Participer",
  description:
    "Sponsor, partenaire, intervenant, créateur, entreprise ou visiteur — les six façons de rejoindre l'écosystème BIS 2026."
};

/**
 * Marketing / discovery page describing every way to take part in BIS 2026.
 *
 * IMPORTANT: this page is descriptive only. It is NOT a registration entry
 * point. The single canonical way to register is `/auth?mode=register`.
 */

type Role = {
  index: string;
  title: string;
  description: string;
  accent: "cobalt" | "lime";
};

const ROLES: Role[] = [
  {
    index: "01",
    title: "Sponsor",
    description:
      "Associez votre marque à l'écosystème BIS et à l'ambition Algérie 2026. Visibilité premium sur toute la scénographie du sommet, accès direct aux décideurs et intégration dans les moments forts du programme.",
    accent: "cobalt"
  },
  {
    index: "02",
    title: "Partenaire",
    description:
      "Institution, université, ONG ou média — construisez une collaboration stratégique autour du sommet. Co-production de contenus, participation aux panels éditoriaux et amplification mutuelle auprès de nos communautés respectives.",
    accent: "lime"
  },
  {
    index: "03",
    title: "Intervenant",
    description:
      "Proposez une intervention, un keynote ou une masterclass au comité éditorial. Partagez votre expertise avec un public exigeant de décideurs, entrepreneurs, chercheurs et innovateurs venus d'Algérie et d'ailleurs.",
    accent: "lime"
  },
  {
    index: "04",
    title: "Créateur de contenu",
    description:
      "Amplifiez les idées, les histoires et l'impact qui émergent du sommet. Accès presse dédié, briefings exclusifs, coulisses des intervenants et couverture éditoriale privilégiée pour vos audiences.",
    accent: "cobalt"
  },
  {
    index: "05",
    title: "Entreprise",
    description:
      "Représentez votre entreprise au BIS 2026. Rencontrez des partenaires potentiels, découvrez les tendances qui structurent votre secteur et connectez vos équipes à un écosystème régional en pleine accélération.",
    accent: "cobalt"
  },
  {
    index: "06",
    title: "Visiteur",
    description:
      "Rejoignez le sommet en tant que participant individuel. Assistez aux conférences, workshops et sessions de networking — un pass unique pour vivre pleinement les journées du BIS 2026.",
    accent: "lime"
  }
];

export default function BeAPartPage() {
  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-5">
            <p className="eyebrow">
              <span className="h-px w-6 bg-black/40" /> Participer
            </p>
            <h1 className="mt-6 font-display text-display-xl text-balance">
              Devenez partie prenante du BIS 2026.
            </h1>
            <div className="mt-8 max-w-lg space-y-4 text-lg text-ink/70">
              <p>
                Le BIS est un écosystème. Découvrez ci-contre les différentes
                façons d&apos;y contribuer — sponsor, partenaire, intervenant,
                créateur de contenu, entreprise ou visiteur.
              </p>
              <p className="text-[15px] text-ink/60">
                Cette page est purement descriptive. L&apos;inscription se fait
                exclusivement depuis l&apos;espace dédié.
              </p>
            </div>

            <div className="mt-10">
              <Link
                href="/auth?mode=register"
                className="inline-flex items-center gap-3 rounded-full bg-cobalt px-7 py-3.5 text-sm font-semibold uppercase tracking-[0.18em] text-white transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-20px_rgba(15,25,60,0.5)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt focus-visible:ring-offset-2"
              >
                <span>S&apos;inscrire au BIS 2026</span>
                <span aria-hidden>→</span>
              </Link>
            </div>
          </div>

          <div className="lg:col-span-7">
            <ul className="grid gap-4 sm:grid-cols-2">
              {ROLES.map((role) => (
                <li key={role.title}>
                  <article
                    className={cn(
                      "relative flex h-full flex-col rounded-[28px] border border-black/[0.08] bg-white p-6"
                    )}
                  >
                    <span className="font-display text-3xl font-black text-cobalt tabular-nums">
                      {role.index}
                    </span>
                    <h3 className="mt-6 font-display text-2xl font-black tracking-tight text-ink">
                      {role.title}
                    </h3>
                    <p className="mt-3 text-[14.5px] leading-relaxed text-ink/65">
                      {role.description}
                    </p>
                    <span
                      aria-hidden
                      className={cn(
                        "pointer-events-none absolute inset-x-6 top-0 h-[3px] rounded-b-full opacity-70",
                        role.accent === "lime" ? "bg-lime" : "bg-cobalt"
                      )}
                    />
                  </article>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import { cn } from "@/lib/utils";

// Role cards for the /register entry point. Server component — no client
// interactivity is needed: each role is either a plain link into its
// dedicated flow, or a disabled "Coming soon" tile.
//
// Commit 1 status:
//   • Visitor + Speaker → active links.
//   • Sponsor / Partner / Content Creator → visible but disabled with a
//     "Bientôt" badge. Do NOT link to the legacy /register/[slug] flows —
//     those are being replaced in Commit 2.

type Theme = "cobalt" | "lime";

type RoleCard = {
  slug: string;
  index: string;
  category: string;
  theme: Theme;
  title: string;
  description: string;
  hint: string;
  cta: string;
  href: string | null;
  available: boolean;
};

const ROLES: RoleCard[] = [
  {
    slug: "visitor",
    index: "01",
    category: "Participation",
    theme: "cobalt",
    title: "Visiteur",
    description:
      "Assister au sommet, découvrir les contenus, rencontrer les acteurs de l'écosystème BIS.",
    hint: "Inscription immédiate. Badge digital disponible dans l'espace personnel.",
    cta: "Continuer comme visiteur",
    href: "/register/visitor",
    available: true
  },
  {
    slug: "speaker",
    index: "02",
    category: "Expertise",
    theme: "lime",
    title: "Intervenant",
    description:
      "Proposer une intervention, un keynote ou une masterclass au comité éditorial.",
    hint: "Chaque candidature est étudiée par le comité éditorial BIS.",
    cta: "Postuler comme intervenant",
    href: "/register/speaker",
    available: true
  },
  {
    slug: "sponsor",
    index: "03",
    category: "Business",
    theme: "cobalt",
    title: "Sponsor",
    description:
      "Associer votre marque à l'écosystème BIS et à l'ambition Algérie 2027.",
    hint: "Disponible prochainement.",
    cta: "Bientôt",
    href: null,
    available: false
  },
  {
    slug: "partner",
    index: "04",
    category: "Alliance",
    theme: "lime",
    title: "Partenaire",
    description:
      "Institution, université, ONG ou média — construire une collaboration stratégique.",
    hint: "Disponible prochainement.",
    cta: "Bientôt",
    href: null,
    available: false
  },
  {
    slug: "content-creator",
    index: "05",
    category: "Média",
    theme: "cobalt",
    title: "Créateur de contenu",
    description:
      "Amplifier les idées, histoires et impact du sommet auprès de votre audience.",
    hint: "Disponible prochainement.",
    cta: "Bientôt",
    href: null,
    available: false
  }
];

export function RoleSelector({ isAuthenticated }: { isAuthenticated: boolean }) {
  return (
    <div>
      {isAuthenticated && (
        <div
          role="status"
          className="mx-auto mb-6 max-w-2xl rounded-btn border border-lime/40 bg-lime/10 px-4 py-2.5 text-center text-[12.5px] text-ink"
        >
          Vous êtes connecté(e). Sélectionnez une façon de participer — votre
          compte BIS servira à toutes vos candidatures.
        </div>
      )}
      <ul
        className="grid gap-4 md:gap-5 md:grid-cols-2 lg:grid-cols-3"
        aria-label="Choix de participation"
      >
        {ROLES.map((role) => (
          <li key={role.slug} className="h-full">
            <RoleCardView role={role} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoleCardView({ role }: { role: RoleCard }) {
  const isLime = role.theme === "lime";
  const inner = (
    <div
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-[24px] border bg-white p-6 transition-all duration-300 sm:p-7",
        role.available
          ? "border-black/[0.08] hover:-translate-y-0.5 hover:border-black/25 hover:shadow-[0_20px_50px_-32px_rgba(15,25,60,0.25)]"
          : "border-black/[0.06] opacity-70"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-[3px] transition-opacity duration-300",
          isLime ? "bg-lime" : "bg-cobalt",
          role.available ? "opacity-70 group-hover:opacity-100" : "opacity-30"
        )}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              "font-display text-[26px] font-black leading-none tabular-nums",
              role.available ? "text-ink/60" : "text-ink/30"
            )}
          >
            {role.index}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50">
            {role.category}
          </span>
        </div>
        {!role.available && (
          <span className="rounded-full border border-ink/15 bg-ink/[0.05] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink/60">
            Bientôt
          </span>
        )}
      </div>

      <div className="mt-8 min-w-0">
        <h2 className="font-display text-[22px] font-black leading-tight tracking-tight text-ink">
          {role.title}
        </h2>
        <p className="mt-3 text-[14px] leading-relaxed text-ink/65">
          {role.description}
        </p>
      </div>

      <div className="mt-auto flex flex-col gap-3 border-t border-black/[0.06] pt-5">
        <p className="text-[11.5px] text-ink/45">{role.hint}</p>
        <div
          className={cn(
            "flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.18em]",
            role.available
              ? isLime
                ? "text-ink"
                : "text-cobalt"
              : "text-ink/40"
          )}
        >
          {role.cta}
          {role.available && (
            <span
              aria-hidden
              className="transition-transform duration-300 group-hover:translate-x-1"
            >
              →
            </span>
          )}
        </div>
      </div>
    </div>
  );

  if (!role.href) {
    return (
      <div
        aria-disabled
        aria-label={`${role.title} — disponible prochainement`}
        className="block h-full"
      >
        {inner}
      </div>
    );
  }
  return (
    <Link
      href={role.href}
      aria-label={`Continuer comme ${role.title.toLowerCase()}`}
      className="block h-full"
    >
      {inner}
    </Link>
  );
}

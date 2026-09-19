const formats = [
  {
    name: "Impact Talks",
    desc: "Sessions de 20 min par des experts reconnus"
  },
  {
    name: "Panels",
    desc: "Débats stratégiques (entre 20 à 45 min)"
  },
  {
    name: "Workshops",
    desc: "Ateliers pratiques en petits groupes"
  },
  {
    name: "Masterminds",
    desc: "Sessions VIP d'intelligence collective"
  }
];

const categories = [
  {
    name: "Innovation",
    variant: "cobalt" as const,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" strokeLinecap="round" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    )
  },
  {
    name: "Impact",
    variant: "light" as const,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="m4 14 5-5 4 4 7-7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 6h6v6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    name: "Culture",
    variant: "light" as const,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 3 3.8 6 3.8 9s-1.3 6-3.8 9c-2.5-3-3.8-6-3.8-9S9.5 6 12 3Z" />
      </svg>
    )
  },
  {
    name: "Business",
    variant: "lime" as const,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="3" y="7" width="18" height="13" rx="1.5" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
];

export function AboutSummit() {
  return (
    <section className="bg-frost">
      <div className="container-page py-20 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-6">
            <p className="eyebrow">
              <span className="h-px w-6 bg-ink/40" /> À PROPOS DU SUMMIT
            </p>
            <h2 className="mt-5 font-display text-section-xl text-balance">
              Trois jours pour
              <br />
              redéfinir l'impact
            </h2>
            <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-ink/70">
              Une infrastructure nationale de branding, construite pour transformer
              « Made in Algeria » d'une signature en une excellence reconnue au-delà
              des frontières. Le sommet à l'intersection de la vision économique
              et de l'ambition créative : où l'élan de l'État rencontre une nouvelle
              génération d'entrepreneurs déterminés à construire des marques
              porteuses de poids, de sens et d'héritage.
            </p>

            <ul className="mt-10 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
              {formats.map((f) => (
                <li key={f.name} className="border-t border-line pt-4">
                  <p className="font-display text-lg font-bold text-ink">
                    {f.name}
                  </p>
                  <p className="mt-1 text-sm text-ink/65">{f.desc}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="lg:col-span-6">
            <ul className="grid grid-cols-2 gap-4">
              {categories.map((c) => (
                <li key={c.name}>
                  <CategoryCard {...c} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function CategoryCard({
  name,
  variant,
  icon
}: {
  name: string;
  variant: "cobalt" | "light" | "lime";
  icon: React.ReactNode;
}) {
  const style = {
    cobalt: "bg-cobalt text-white",
    light: "bg-white text-ink border border-line",
    lime: "bg-lime text-ink"
  }[variant];

  const iconWrap = {
    cobalt: "border-white/25 text-white",
    light: "border-line text-cobalt",
    lime: "border-black/15 text-ink"
  }[variant];

  return (
    <div
      className={`flex aspect-square flex-col justify-between rounded-card p-6 sm:p-7 ${style}`}
    >
      <span
        className={`inline-flex h-11 w-11 items-center justify-center rounded-btn border ${iconWrap}`}
      >
        <span className="block h-5 w-5">{icon}</span>
      </span>
      <p className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
        {name}
      </p>
    </div>
  );
}

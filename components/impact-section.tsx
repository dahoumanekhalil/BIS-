const pillars = [
  {
    n: "01",
    title: "Idées",
    body: "Des perspectives qui déplacent les lignes. Keynotes, fireside chats, débats — un espace pour ce qui compte vraiment."
  },
  {
    n: "02",
    title: "Rencontres",
    body: "Fondateurs, investisseurs, décideurs, créateurs. Les bonnes personnes au bon moment, à l'échelle continentale."
  },
  {
    n: "03",
    title: "Innovation",
    body: "IA, deep-tech, climate-tech, fintech. Les frontières technologiques du continent, vues par celles et ceux qui les repoussent."
  },
  {
    n: "04",
    title: "Culture",
    body: "L'Afrique créative — musique, design, storytelling — moteur d'attractivité et d'influence globale."
  },
  {
    n: "05",
    title: "Business",
    body: "Deals, partenariats, capital. Des passerelles concrètes entre startups, corporates et institutions."
  },
  {
    n: "06",
    title: "Impact",
    body: "Au-delà du business : ce que l'on construit pour les décennies qui viennent."
  }
];

export function ImpactSection() {
  return (
    <section className="section-padding relative bg-white">
      <div className="container-wide">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-5">
            <p className="eyebrow">
              <span className="h-px w-6 bg-black/40" /> À propos
            </p>
            <h2 className="mt-6 font-display text-display-xl text-balance">
              Trois jours pour redéfinir l'impact.
            </h2>
            <p className="mt-8 max-w-md text-lg text-brand-ink/70">
              GET+ SUMMIT n'est pas une conférence de plus. C'est un rendez-vous
              annuel où l'Afrique se pense, se construit et se raconte —
              à l'échelle du continent, avec des ambitions globales.
            </p>
            <div className="mt-10 flex items-center gap-6">
              <div>
                <p className="font-display text-4xl font-bold">03</p>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-black/60">
                  Jours
                </p>
              </div>
              <div className="h-12 w-px bg-black/10" />
              <div>
                <p className="font-display text-4xl font-bold">04</p>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-black/60">
                  Univers
                </p>
              </div>
              <div className="h-12 w-px bg-black/10" />
              <div>
                <p className="font-display text-4xl font-bold">45+</p>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-black/60">
                  Pays
                </p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7">
            <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-3xl border border-black/[0.08] bg-black/[0.08] sm:grid-cols-2">
              {pillars.map((p) => (
                <li key={p.n} className="bg-white p-8 transition-colors hover:bg-brand-fog">
                  <div className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-[0.22em] text-black/50">
                    <span>{p.n}</span>
                    <span aria-hidden>+</span>
                  </div>
                  <h3 className="mt-8 font-display text-2xl font-semibold">{p.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-brand-ink/70">
                    {p.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

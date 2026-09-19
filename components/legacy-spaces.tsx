const spaces = [
  {
    key: "GET BEYOND",
    name: "Beyond",
    desc: "Lab du futur & innovation.",
    accent: "#2453E0",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M12 2 3 20l9-5 9 5-9-18Z" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    key: "GET ROOTED",
    name: "Rooted",
    desc: "Héritage culturel & impact.",
    accent: "#B8E62E",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M12 3v18M6 9c0 4 3 6 6 6s6-2 6-6M8 6c0 2 2 4 4 4s4-2 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    key: "GET ICONIC",
    name: "Iconic",
    desc: "Studio créatif & médias.",
    accent: "#EC5B4F",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="3" y="6" width="14" height="12" rx="1.5" />
        <path d="M17 10.5 21 8v8l-4-2.5" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    key: "GET CONNECTED",
    name: "Connected",
    desc: "Hub réseau & B2B.",
    accent: "#7C3AED",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M8 6h8M8 18h8M6 8v8M18 8v8" strokeLinecap="round" />
      </svg>
    )
  }
];

export function LegacySpaces() {
  return (
    <section id="espaces" className="bg-navy text-white">
      <div className="container-page py-20 lg:py-28">
        <div className="max-w-2xl">
          <p className="eyebrow-invert">
            <span className="h-px w-6 bg-white/40" /> ESPACES LEGACY
          </p>
          <h2 className="mt-5 font-display text-section-xl">
            4 univers, 4 expériences
          </h2>
          <p className="mt-4 text-[15px] text-white/70">
            Chaque espace est conçu pour une expérience unique.
          </p>
        </div>

        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {spaces.map((sp) => (
            <li key={sp.key}>
              <article className="group relative flex h-full flex-col overflow-hidden rounded-card bg-navy-card p-6 transition-colors hover:bg-navy-card-2">
                <span
                  className="inline-flex h-11 w-11 items-center justify-center rounded-btn"
                  style={{ backgroundColor: `${sp.accent}22`, color: sp.accent }}
                  aria-hidden
                >
                  <span className="block h-5 w-5">{sp.icon}</span>
                </span>
                <p
                  className="mt-8 text-[10px] font-bold uppercase tracking-[0.22em]"
                  style={{ color: sp.accent }}
                >
                  {sp.key}
                </p>
                <p className="mt-2 font-display text-2xl font-bold tracking-tight text-white">
                  {sp.name}
                </p>
                <p className="mt-2 text-[13px] text-white/60">{sp.desc}</p>
                <div
                  className="mt-6 h-[2px] w-10 rounded-full"
                  style={{ backgroundColor: sp.accent }}
                  aria-hidden
                />
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

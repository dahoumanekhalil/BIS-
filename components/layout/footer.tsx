import Link from "next/link";

const nav = [
  { href: "/programme", label: "Programme" },
  { href: "/intervenants", label: "Intervenants" },
  { href: "/espaces", label: "Espaces" },
  { href: "/inscription", label: "Inscription" }
];

const tiers = ["VIP", "VVIP", "Content Creator", "Impact Maker"];

export function Footer() {
  return (
    <footer className="bg-navy text-white">
      <div className="container-page grid gap-12 py-16 lg:grid-cols-12 lg:gap-8 lg:py-20">
        <div className="lg:col-span-4">
          <p className="font-display text-3xl font-extrabold tracking-tight">
            B.I.S<span className="text-lime">+</span>
          </p>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/60">
            Le sommet annuel de l'impact africain. Trois jours pour connecter,
            inspirer et accélérer le changement.
          </p>
        </div>

        <div className="lg:col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/50">
            Navigation
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            {nav.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  className="text-white/80 transition-colors hover:text-lime"
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="lg:col-span-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/50">
            Tiers
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            {tiers.map((t) => (
              <li key={t} className="text-white/80">
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div className="lg:col-span-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/50">
            Contact
          </p>
          <ul className="mt-4 space-y-2.5 text-sm text-white/80">
            <li>contact@bis-algeria.dz</li>
            <li>BIS Algeria</li>
            <li>15 Nov 2026 · CIC Alger</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="container-page flex flex-col items-start justify-between gap-3 py-6 text-xs text-white/50 sm:flex-row sm:items-center">
          <p>© 2026 BIS Algeria. Tous droits réservés.</p>
          <p>Alger · Algérie</p>
        </div>
      </div>
    </footer>
  );
}

import { PageHeader } from "@/components/page-header";
import { getSpaces } from "@/lib/queries";
import Link from "next/link";

export const metadata = {
  title: "Espaces",
  description: "Les quatre univers de GET+ SUMMIT 2026 — Impact Stage, Builders Lab, Creators Studio, Tech Frontier."
};

export const revalidate = 300;

export default async function EspacesPage() {
  const spaces = await getSpaces();

  return (
    <>
      <PageHeader
        eyebrow="Espaces"
        title="4 univers, 4 expériences."
        description="Le sommet est structuré autour de quatre univers thématiques. Chacun a sa scène, son ton, ses formats et sa communauté."
      />

      <section className="py-16 lg:py-24">
        <div className="container-wide">
          <ul className="space-y-6">
            {spaces.map((sp, i) => (
              <li
                key={sp.id}
                className="grid grid-cols-1 gap-8 rounded-[32px] border border-black/[0.08] p-8 sm:p-12 lg:grid-cols-12 lg:gap-16"
              >
                <div className="lg:col-span-4">
                  <div
                    className="aspect-square w-full rounded-3xl"
                    style={{
                      background: `linear-gradient(135deg, ${sp.color} 0%, #0A0A0A 100%)`
                    }}
                    aria-hidden
                  >
                    <div className="flex h-full flex-col justify-between p-6 text-white">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/70">
                        Univers 0{i + 1}
                      </p>
                      <p className="font-display text-6xl font-bold leading-none">
                        {sp.name.charAt(0)}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-8">
                  <h2 className="font-display text-display-md">{sp.name}</h2>
                  <p className="mt-3 text-xl italic text-brand-ink/70">
                    {sp.headline}
                  </p>
                  <p className="mt-6 max-w-2xl text-base leading-relaxed text-brand-ink/80">
                    {sp.description}
                  </p>
                  <div className="mt-8 flex items-center gap-3">
                    <Link href="/programme" className="btn-secondary">
                      Voir les sessions
                    </Link>
                    <span className="text-xs uppercase tracking-[0.2em] text-black/50">
                      {sp.slug}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

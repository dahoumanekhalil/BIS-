import type { Partner } from "@prisma/client";

const order: Array<{ tier: string; label: string }> = [
  { tier: "PLATINUM", label: "PLATINUM" },
  { tier: "GOLD", label: "GOLD" },
  { tier: "SILVER", label: "SILVER" }
];

export function Partners({ partners }: { partners: Partner[] }) {
  const byTier = new Map<string, Partner[]>();
  for (const p of partners) {
    if (!byTier.has(p.tier)) byTier.set(p.tier, []);
    byTier.get(p.tier)!.push(p);
  }

  return (
    <section className="bg-white">
      <div className="container-page py-20 lg:py-24 text-center">
        <p className="eyebrow mx-auto">
          <span className="h-px w-6 bg-ink/40" /> ILS NOUS FONT CONFIANCE
        </p>
        <h2 className="mt-5 font-display text-section-xl">Nos partenaires 2025</h2>

        <div className="mt-12 space-y-10">
          {order
            .filter((t) => (byTier.get(t.tier)?.length ?? 0) > 0)
            .map(({ tier, label }) => {
              const items = byTier.get(tier) ?? [];
              return (
                <div key={tier}>
                  <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-ink/45">
                    {label}
                  </p>
                  <ul className="mx-auto mt-4 flex max-w-4xl flex-wrap items-center justify-center gap-3">
                    {items.map((p) => (
                      <li key={p.id}>
                        <span className="inline-flex min-w-[140px] items-center justify-center rounded-btn border border-line bg-white px-6 py-3 font-display text-sm font-bold tracking-tight text-ink/75">
                          {p.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
        </div>
      </div>
    </section>
  );
}

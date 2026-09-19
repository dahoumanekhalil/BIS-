import Link from "next/link";
import type { Prisma } from "@prisma/client";

type SessionWithRelations = Prisma.SessionGetPayload<{
  include: { speakers: { include: { speaker: true } }; space: true };
}>;

const typeMeta: Record<string, { label: string; color: string }> = {
  KEYNOTE: { label: "TALK", color: "#2453E0" },
  PANEL: { label: "PANEL", color: "#B8E62E" },
  FIRESIDE: { label: "TALK", color: "#2453E0" },
  WORKSHOP: { label: "WORKSHOP", color: "#111827" },
  MASTERMIND: { label: "MASTERMIND", color: "#7C3AED" },
  MASTERCLASS: { label: "MASTERMIND", color: "#7C3AED" },
  PITCH: { label: "PITCH", color: "#B8E62E" },
  SHOWCASE: { label: "SHOWCASE", color: "#111827" }
};

export function FeaturedSessions({ sessions }: { sessions: SessionWithRelations[] }) {
  return (
    <section className="bg-white">
      <div className="container-page py-20 lg:py-24">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="eyebrow">
              <span className="h-px w-6 bg-ink/40" /> PROGRAMME
            </p>
            <h2 className="mt-5 font-display text-section-xl">
              Sessions à ne pas manquer
            </h2>
          </div>
          <Link
            href="/programme"
            className="text-[13px] font-semibold text-ink underline-offset-4 hover:underline"
          >
            Voir tout le programme →
          </Link>
        </div>

        <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {sessions.slice(0, 4).map((s) => {
            const meta = typeMeta[s.type] ?? { label: s.type, color: "#111827" };
            const time = new Intl.DateTimeFormat("fr-FR", {
              hour: "2-digit",
              minute: "2-digit"
            }).format(s.startsAt);
            const speaker = s.speakers[0]?.speaker;
            return (
              <li key={s.id} className="group">
                <article className="relative h-full overflow-hidden rounded-card border border-line bg-white transition-all hover:-translate-y-0.5 hover:border-ink/25">
                  <div
                    className="h-[3px] w-full"
                    style={{ backgroundColor: meta.color }}
                  />
                  <div className="flex h-full flex-col p-5">
                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.2em] text-ink/70">
                      <span style={{ color: meta.color }}>{meta.label}</span>
                      <span className="text-ink">{time}</span>
                    </div>
                    <h3 className="mt-4 min-h-[3.5rem] font-display text-[17px] font-bold leading-snug tracking-tight text-ink">
                      {s.title}
                    </h3>
                    <div className="mt-6 flex items-end justify-between border-t border-line pt-4">
                      <div className="text-[11px] text-ink/60">
                        <p className="font-medium text-ink">
                          {speaker?.fullName ?? "Intervenant TBA"}
                        </p>
                        <p className="mt-0.5">
                          {s.stage ?? s.space?.name ?? "Salle principale"}
                        </p>
                      </div>
                      <span className="text-[11px] text-ink/50">
                        {s.durationMin}min
                      </span>
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

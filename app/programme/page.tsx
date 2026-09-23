import Link from "next/link";
import { getAllSessions } from "@/lib/queries";
import { ProgrammeDayNav } from "@/components/programme-day-nav";
import { InteractiveProgramme } from "@/components/interactive-programme";

export const metadata = {
  title: "Programme",
  description:
    "Le programme complet de BIS 2027 — cartographié en quatre lignes, trois jours, plus de soixante arrêts."
};

export const revalidate = 300;

function fmtWeekday(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    timeZone: "UTC"
  }).format(d);
}
function fmtDayNum(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    timeZone: "UTC"
  }).format(d);
}

export default async function ProgrammePage() {
  const sessions = await getAllSessions();

  const grouped = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const key = s.startsAt.toISOString().slice(0, 10);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }
  const days = Array.from(grouped.entries()).map(([iso, items]) => ({
    iso,
    date: new Date(`${iso}T00:00:00Z`),
    items: items.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  }));

  const totalMinutes = sessions.reduce((acc, s) => acc + s.durationMin, 0);
  const totalHours = Math.round(totalMinutes / 60);
  const speakerCount = new Set(
    sessions.flatMap((s) => s.speakers.map((ss) => ss.speakerId))
  ).size;

  return (
    <>
      {/* HERO */}
      <section className="relative isolate overflow-hidden bg-navy text-white">
        <div className="pointer-events-none absolute inset-0 grid-lines-dark opacity-30" aria-hidden />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 top-0 h-[720px] w-[720px] rounded-full bg-cobalt/30 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 -left-20 h-[420px] w-[420px] rounded-full bg-lime/20 blur-3xl"
        />

        <div className="container-page relative pb-20 pt-16 lg:pb-28 lg:pt-24">
          <div className="grid gap-14 lg:grid-cols-12 lg:gap-10">
            <div className="lg:col-span-7">
              <div className="flex items-center gap-3">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-lime" />
                </span>
                <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-white/80">
                  Cartographie · Édition 2027
                </p>
              </div>

              <h1 className="mt-8 font-display text-[clamp(3rem,8vw,7rem)] font-black leading-[0.9] tracking-tighter text-white">
                Le sommet,
                <br />
                <span className="text-lime">cartographié.</span>
              </h1>

              <p className="mt-8 max-w-xl text-[17px] leading-relaxed text-white/70">
                Quatre lignes, une seule ville. Chaque univers de BIS 2027 devient une
                ligne, chaque session un arrêt. Cliquez sur un arrêt, filtrez le
                réseau, composez votre journée.
              </p>

              <div className="mt-10 flex flex-wrap items-center gap-3">
                <Link href="/inscription" className="btn-lime-lg">
                  Réserver mon billet
                  <span aria-hidden>→</span>
                </Link>
                <Link href="#carte" className="btn-outline-white">
                  Voir la carte
                </Link>
              </div>

              <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] uppercase tracking-[0.18em] text-white/50">
                <span className="inline-flex items-center gap-2">
                  <kbd className="rounded border border-white/25 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-white">
                    Clic
                  </kbd>
                  Ouvrir un arrêt
                </span>
                <span className="inline-flex items-center gap-2">
                  <kbd className="rounded border border-white/25 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-white">
                    ♥
                  </kbd>
                  Ajouter à ma journée
                </span>
                <span className="inline-flex items-center gap-2">
                  <kbd className="rounded border border-white/25 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-white">
                    Esc
                  </kbd>
                  Fermer
                </span>
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="relative rounded-[24px] border border-white/10 bg-white/[0.04] p-8 backdrop-blur">
                <p className="font-display text-[11px] font-bold uppercase tracking-[0.22em] text-white/60">
                  Réseau BIS 2027
                </p>
                <p className="mt-2 font-display text-3xl font-black tracking-tight text-white">
                  4 lignes · 3 jours
                </p>

                <ul className="mt-8 space-y-4">
                  {[
                    { name: "GET BEYOND", code: "L1", color: "#2453E0", desc: "Lab du futur & innovation" },
                    { name: "GET ROOTED", code: "L2", color: "#8FB61E", desc: "Héritage culturel & impact" },
                    { name: "GET ICONIC", code: "L3", color: "#EC5B4F", desc: "Studio créatif & médias" },
                    { name: "GET CONNECTED", code: "L4", color: "#7C3AED", desc: "Hub réseau & B2B" }
                  ].map((l) => (
                    <li key={l.name} className="flex items-center gap-3">
                      <span
                        className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] font-display text-[10px] font-black text-white"
                        style={{ backgroundColor: l.color }}
                      >
                        {l.code}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-display text-[12px] font-bold uppercase tracking-[0.16em] text-white">
                          {l.name}
                        </span>
                        <span className="block text-[12px] text-white/60">
                          {l.desc}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="mt-8 grid grid-cols-3 gap-3 border-t border-white/10 pt-6">
                  <div>
                    <p className="font-display text-2xl font-black tracking-tighter text-white">
                      {sessions.length}
                    </p>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
                      Arrêts
                    </p>
                  </div>
                  <div>
                    <p className="font-display text-2xl font-black tracking-tighter text-white">
                      {speakerCount}
                    </p>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
                      Conducteurs
                    </p>
                  </div>
                  <div>
                    <p className="font-display text-2xl font-black tracking-tighter text-white">
                      {totalHours}h
                    </p>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
                      Voyage
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Sticky day switcher */}
      <ProgrammeDayNav
        days={days.map((d, i) => ({
          index: i + 1,
          iso: d.iso,
          weekday: fmtWeekday(d.date),
          dayNum: fmtDayNum(d.date),
          count: d.items.length
        }))}
      />

      {/* Interactive maps section */}
      <section id="carte" className="bg-frost">
        <div className="container-page py-16 lg:py-24">
          <div className="mb-6">
            <p className="eyebrow">
              <span className="h-px w-6 bg-ink/40" /> Carte du réseau
            </p>
            <h2 className="mt-4 font-display text-[clamp(1.75rem,3.2vw,2.75rem)] font-black tracking-tight">
              Composez votre journée.
            </h2>
            <p className="mt-3 max-w-xl text-[15px] text-ink/65">
              Filtrez les lignes, cherchez un intervenant, cliquez sur un arrêt
              pour voir le détail — puis ajoutez-le à votre journée pour construire
              votre parcours.
            </p>
          </div>

          <InteractiveProgramme days={days} />
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="relative isolate overflow-hidden bg-navy text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-cobalt/30 blur-3xl"
        />
        <div className="container-page relative py-20 lg:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <p className="eyebrow-invert justify-center">
              <span className="h-px w-6 bg-white/40" /> Départ imminent
            </p>
            <h2 className="mt-6 font-display text-[clamp(2.25rem,5vw,4rem)] font-black leading-[0.95] tracking-tight">
              Embarquez.
              <br />
              Le sommet part sans vous.
            </h2>
            <p className="mx-auto mt-6 max-w-xl text-[15px] leading-relaxed text-white/70">
              Réservez votre badge et recevez votre pass digital pour naviguer sur
              les quatre lignes de BIS 2027, du 15 au 17 novembre.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link href="/inscription" className="btn-lime-lg">
                Prendre mon billet
                <span aria-hidden>→</span>
              </Link>
              <Link href="/intervenants" className="btn-outline-white">
                Voir les intervenants
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

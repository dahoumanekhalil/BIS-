import Link from "next/link";
import { notFound } from "next/navigation";
import { getSpeakerBySlug } from "@/lib/queries";

export const revalidate = 300;

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const speaker = await getSpeakerBySlug(slug);
  if (!speaker) return { title: "Intervenant introuvable" };
  return {
    title: speaker.fullName,
    description: `${speaker.fullName} — ${speaker.title}, ${speaker.organization}`
  };
}

export default async function SpeakerDetailPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const speaker = await getSpeakerBySlug(slug);
  if (!speaker) notFound();

  return (
    <>
      <section className="relative overflow-hidden bg-white pb-16 pt-12 lg:pb-24">
        <div className="container-wide">
          <Link
            href="/intervenants"
            className="inline-flex items-center gap-2 text-sm text-black/60 hover:text-black"
          >
            <span aria-hidden>←</span> Tous les intervenants
          </Link>

          <div className="mt-10 grid gap-12 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-5">
              <div className="relative aspect-[4/5] overflow-hidden rounded-[32px] bg-brand-fog">
                {speaker.photoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={speaker.photoUrl}
                    alt={speaker.fullName}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
            </div>

            <div className="lg:col-span-7">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-black/50">
                Intervenant · Édition 2026
              </p>
              <h1 className="mt-4 font-display text-display-lg text-balance">
                {speaker.fullName}
              </h1>
              <p className="mt-4 text-xl text-brand-ink/70">
                {speaker.title}
              </p>
              <p className="mt-1 text-lg text-brand-ink/50">
                {speaker.organization}
                {speaker.country && ` · ${speaker.country}`}
              </p>

              {speaker.bio && (
                <div className="mt-10 max-w-2xl border-t border-black/[0.08] pt-8">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-black/50">
                    Bio
                  </p>
                  <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-brand-ink/80">
                    {speaker.bio}
                  </p>
                </div>
              )}

              {speaker.sessions.length > 0 && (
                <div className="mt-10 max-w-2xl border-t border-black/[0.08] pt-8">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-black/50">
                    Sessions
                  </p>
                  <ul className="mt-4 space-y-3">
                    {speaker.sessions.map((ss) => (
                      <li
                        key={ss.sessionId}
                        className="rounded-2xl border border-black/[0.08] p-5"
                      >
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-blue">
                          {ss.session.space?.name ?? "Impact Stage"}
                        </p>
                        <p className="mt-1 font-display text-lg font-semibold">
                          {ss.session.title}
                        </p>
                        <p className="mt-1 text-sm text-black/60">
                          {new Intl.DateTimeFormat("fr-FR", {
                            weekday: "long",
                            day: "numeric",
                            month: "long",
                            hour: "2-digit",
                            minute: "2-digit"
                          }).format(ss.session.startsAt)}{" "}
                          · {ss.session.durationMin} min
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

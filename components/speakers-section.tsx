import Link from "next/link";
import type { Speaker } from "@prisma/client";

const tagPools = [
  ["Vision", "Impact"],
  ["Growth", "Tech"],
  ["Legacy", "Culture"],
  ["Impact", "Community"],
  ["Growth", "Brand"],
  ["Tech", "AI"]
];

const avatarPalette = ["#2453E0", "#111827", "#B8E62E", "#7C3AED", "#EC5B4F", "#F5A524"];

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

export function SpeakerGrid({ speakers }: { speakers: Speaker[] }) {
  return (
    <section className="bg-frost">
      <div className="container-page py-20 lg:py-24">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="eyebrow">
              <span className="h-px w-6 bg-ink/40" /> INTERVENANTS
            </p>
            <h2 className="mt-5 font-display text-section-xl">
              Des voix qui comptent
            </h2>
          </div>
          <Link
            href="/intervenants"
            className="text-[13px] font-semibold text-ink underline-offset-4 hover:underline"
          >
            Tous les intervenants →
          </Link>
        </div>

        <ul className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {speakers.slice(0, 10).map((s, i) => (
            <li key={s.id}>
              <SpeakerCard speaker={s} tags={tagPools[i % tagPools.length]} colorSeed={i} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SpeakerCard({
  speaker,
  tags,
  colorSeed
}: {
  speaker: Speaker;
  tags: string[];
  colorSeed: number;
}) {
  const bg = avatarPalette[colorSeed % avatarPalette.length];
  return (
    <Link
      href={`/intervenants/${speaker.slug}`}
      className="group block h-full rounded-card border border-line bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-ink/25"
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full font-display text-sm font-bold text-white"
          style={{ backgroundColor: bg }}
          aria-hidden
        >
          {initials(speaker.fullName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[14px] font-bold leading-tight text-ink">
            {speaker.fullName}
          </p>
          {speaker.country && (
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-ink/50">
              {speaker.country}
            </p>
          )}
        </div>
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <p className="text-[12px] font-medium text-ink/85 line-clamp-1">
          {speaker.title}
        </p>
        <p className="mt-0.5 text-[11px] text-ink/55 line-clamp-1">
          {speaker.organization}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="rounded-full border border-line px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-ink/60"
          >
            {t}
          </span>
        ))}
      </div>
    </Link>
  );
}

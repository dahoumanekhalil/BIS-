"use client";

type SessionInfo = {
  id: string;
  title: string;
  type: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  room: { name: string } | null;
};

type SpeakerData = {
  id: string;
  fullName: string;
  title: string;
  organization: string;
  country: string | null;
  bio: string | null;
  photoUrl: string | null;
  linkedin: string | null;
  twitter: string | null;
  website: string | null;
  sessions: { session: SessionInfo }[];
};

export function SpeakerDashboardClient({ speaker }: { speaker: SpeakerData }) {
  const upcomingSessions = speaker.sessions.filter(
    (s) => new Date(s.session.startsAt) > new Date()
  );
  const pastSessions = speaker.sessions.filter(
    (s) => new Date(s.session.startsAt) <= new Date()
  );

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      {/* Profile card */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-8 backdrop-blur-sm">
        <div className="flex flex-col gap-8 md:flex-row">
          {/* Avatar */}
          <div className="flex-shrink-0">
            {speaker.photoUrl ? (
              <img
                src={speaker.photoUrl}
                alt={speaker.fullName}
                className="h-32 w-32 rounded-2xl border border-white/10 object-cover shadow-lg shadow-black/20"
              />
            ) : (
              <div className="flex h-32 w-32 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-2xl font-black text-white/30">
                {speaker.fullName
                  .split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </div>
            )}
          </div>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400/80">
              Intervenant
            </p>
            <h1 className="mt-2 font-display text-[32px] font-black leading-tight tracking-tight">
              {speaker.fullName}
            </h1>
            <p className="mt-1 text-[15px] text-white/60">{speaker.title}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-white/45">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
                {speaker.organization}
              </span>
              {speaker.country && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {speaker.country}
                </span>
              )}
            </div>

            {/* Links */}
            {(speaker.linkedin || speaker.twitter || speaker.website) && (
              <div className="mt-4 flex items-center gap-2">
                {speaker.linkedin && (
                  <SocialLink href={speaker.linkedin} label="LinkedIn">
                    <path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z" />
                    <circle cx="4" cy="4" r="2" />
                  </SocialLink>
                )}
                {speaker.twitter && (
                  <SocialLink href={speaker.twitter} label="Twitter">
                    <path d="M23 3a10.9 10.9 0 01-3.14 1.53 4.48 4.48 0 00-7.86 3v1A10.66 10.66 0 013 4s-4 9 5 13a11.64 11.64 0 01-7 2c9 5 20 0 20-11.5a4.5 4.5 0 00-.08-.83A7.72 7.72 0 0023 3z" />
                  </SocialLink>
                )}
                {speaker.website && (
                  <SocialLink href={speaker.website} label="Site web">
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </SocialLink>
                )}
              </div>
            )}

            {/* Bio */}
            {speaker.bio && (
              <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/35">
                  Biographie
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-white/60 whitespace-pre-line">
                  {speaker.bio}
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Sessions */}
      <section className="space-y-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-[20px] font-black tracking-tight">
            Mes sessions
          </h2>
          <span className="text-[12px] tabular-nums text-white/35">
            {speaker.sessions.length} session{speaker.sessions.length !== 1 ? "s" : ""}
          </span>
        </div>

        {upcomingSessions.length > 0 && (
          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400/70">
              À venir
            </p>
            {upcomingSessions.map(({ session }) => (
              <SessionCard key={session.id} session={session} upcoming />
            ))}
          </div>
        )}

        {pastSessions.length > 0 && (
          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/30">
              Passées
            </p>
            {pastSessions.map(({ session }) => (
              <SessionCard key={session.id} session={session} />
            ))}
          </div>
        )}

        {speaker.sessions.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-12 text-center">
            <p className="text-[14px] text-white/35">
              Aucune session programmée pour le moment.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}

function SessionCard({
  session,
  upcoming,
}: {
  session: SessionInfo;
  upcoming?: boolean;
}) {
  const start = new Date(session.startsAt);
  const end = new Date(session.endsAt);

  const dateStr = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(start);

  const timeStr = `${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(start)} — ${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(end)}`;

  return (
    <div
      className={`rounded-xl border p-5 transition-colors ${
        upcoming
          ? "border-amber-400/20 bg-amber-400/[0.04]"
          : "border-white/[0.06] bg-white/[0.02] opacity-60"
      }`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/50">
              {session.type}
            </span>
            {upcoming && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                À venir
              </span>
            )}
          </div>
          <h3 className="mt-2 font-display text-[16px] font-bold leading-snug tracking-tight">
            {session.title}
          </h3>
          {session.description && (
            <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-white/45">
              {session.description}
            </p>
          )}
        </div>

        <div className="flex-shrink-0 text-right">
          <p className="text-[12px] font-semibold capitalize text-white/70">
            {dateStr}
          </p>
          <p className="mt-0.5 text-[12px] tabular-nums text-white/45">
            {timeStr}
          </p>
          {session.room && (
            <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-white/35">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {session.room.name}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SocialLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href.startsWith("http") ? href : `https://${href}`}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/40 transition-all hover:bg-white/[0.08] hover:text-white"
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </a>
  );
}
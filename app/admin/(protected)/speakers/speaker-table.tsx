"use client";

import { useState } from "react";
import { LinkAccountDialog } from "./link-account-dialog";

type AdminUserOption = {
  id: string;
  name: string;
  email: string;
};

type SpeakerRow = {
  id: string;
  fullName: string;
  title: string;
  organization: string;
  country: string | null;
  photoUrl: string | null;
  isHighlighted: boolean;
  order: number;
  linkedin: string | null;
  twitter: string | null;
  website: string | null;
  adminUserId: string | null;
  adminUser: { name: string; email: string } | null;
  _count: { sessions: number };
  sessions: { session: { title: string; type: string } }[];
};

export function SpeakerTable({
  speakers,
  users,
}: {
  speakers: SpeakerRow[];
  users: AdminUserOption[];
}) {
  const [search, setSearch] = useState("");

  const filtered = speakers.filter(
    (s) =>
      s.fullName.toLowerCase().includes(search.toLowerCase()) ||
      s.organization.toLowerCase().includes(search.toLowerCase()) ||
      (s.country && s.country.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <input
          type="text"
          placeholder="Rechercher par nom, organisation ou pays…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-line bg-white px-4 py-2.5 pl-10 text-[13px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
        />
        <svg
          className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/30"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-slate-50/80">
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Intervenant
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Organisation
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Pays
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px] text-center">
                Sessions
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px] text-center">
                Mis en avant
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Compte lié
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px] text-right">
                Liens
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/50">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-ink/40">
                  Aucun intervenant trouvé.
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr
                  key={s.id}
                  className="group transition-colors hover:bg-slate-50/50"
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <SpeakerAvatar name={s.fullName} photoUrl={s.photoUrl} />
                      <div className="min-w-0">
                        <p className="font-semibold text-ink">{s.fullName}</p>
                        <p className="truncate text-[11.5px] text-ink/50">
                          {s.title}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-ink/70">{s.organization}</td>
                  <td className="px-5 py-3.5 text-ink/50">
                    {s.country ?? "—"}
                  </td>
                  <td className="px-5 py-3.5 text-center tabular-nums text-ink/70">
                    {s._count.sessions}
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    {s.isHighlighted ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-lime/20 px-2 py-0.5 text-[10px] font-bold text-ink">
                        <span className="h-1.5 w-1.5 rounded-full bg-lime" />
                        Oui
                      </span>
                    ) : (
                      <span className="text-ink/30">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      {s.adminUser ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-lime/20 px-2.5 py-0.5 text-[11px] font-bold text-ink">
                          <span className="h-1.5 w-1.5 rounded-full bg-lime" />
                          {s.adminUser.name}
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink/30">Non lié</span>
                      )}
                      <LinkAccountDialog
                        speakerId={s.id}
                        speakerName={s.fullName}
                        currentUserId={s.adminUserId}
                        users={users}
                      />
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                      {s.linkedin && (
                        <ExternalLink href={s.linkedin} label="LinkedIn">
                          <path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z" />
                          <circle cx="4" cy="4" r="2" />
                        </ExternalLink>
                      )}
                      {s.twitter && (
                        <ExternalLink href={s.twitter} label="Twitter">
                          <path d="M23 3a10.9 10.9 0 01-3.14 1.53 4.48 4.48 0 00-7.86 3v1A10.66 10.66 0 013 4s-4 9 5 13a11.64 11.64 0 01-7 2c9 5 20 0 20-11.5a4.5 4.5 0 00-.08-.83A7.72 7.72 0 0023 3z" />
                        </ExternalLink>
                      )}
                      {s.website && (
                        <ExternalLink href={s.website} label="Site web">
                          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                        </ExternalLink>
                      )}
                      {!s.linkedin && !s.twitter && !s.website && (
                        <span className="text-[11px] text-ink/30">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-ink/40 tabular-nums">
        {filtered.length} intervenant{filtered.length !== 1 ? "s" : ""} affiché
        {filtered.length !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

function SpeakerAvatar({
  name,
  photoUrl,
}: {
  name: string;
  photoUrl: string | null;
}) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        className="h-9 w-9 flex-shrink-0 rounded-full border border-line object-cover"
      />
    );
  }

  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-ink/5 text-[10px] font-bold text-ink/50">
      {initials}
    </div>
  );
}

function ExternalLink({
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
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
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
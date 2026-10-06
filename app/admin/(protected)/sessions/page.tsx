import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { canWithOverrides } from "@/lib/admin/rbac";
import { AdminHeader } from "@/components/admin/header";
import { EmptyState } from "@/components/admin/ui";
import {
  PageBody,
  PageIntro,
  ButtonLink,
  Chip,
  type Tone
} from "@/components/admin/page-kit";
import { SESSION_TYPE_LABEL } from "@/lib/admin/session-labels";
import { prisma } from "@/lib/db";
import { DeleteSessionButton } from "./delete-session-button";

export const dynamic = "force-dynamic";

// Event times are shown in the event's own time zone so the agenda reads the
// same whatever the server's zone is.
const TZ = "Africa/Algiers";

const TYPE_TONE: Record<string, Tone> = {
  KEYNOTE: "info",
  PANEL: "info",
  WORKSHOP: "ok",
  MASTERCLASS: "ok",
  MASTERMIND: "ok",
  PITCH: "warn",
  SHOWCASE: "warn"
};

const dayKey = (d: Date) =>
  new Intl.DateTimeFormat("fr-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
const dayLabel = (d: Date) =>
  new Intl.DateTimeFormat("fr-FR", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(d);
const hm = (d: Date) =>
  new Intl.DateTimeFormat("fr-FR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);

export default async function AdminSessionsPage({
  searchParams
}: {
  searchParams: Promise<{ flash?: string }>;
}) {
  const { user } = await requirePermission("sessions.view");
  const canManage = await canWithOverrides(user.role, "sessions.manage");
  const sp = await searchParams;

  const sessions = await prisma.session.findMany({
    orderBy: [{ startsAt: "asc" }, { order: "asc" }],
    select: {
      id: true,
      title: true,
      summary: true,
      type: true,
      startsAt: true,
      durationMin: true,
      stage: true,
      isHighlighted: true,
      space: { select: { name: true } },
      speakers: { select: { speaker: { select: { fullName: true } } } }
    }
  });

  const days = new Map<string, { label: string; items: typeof sessions }>();
  for (const s of sessions) {
    const key = dayKey(s.startsAt);
    const day = days.get(key) ?? { label: dayLabel(s.startsAt), items: [] };
    day.items.push(s);
    days.set(key, day);
  }

  // Fixed texts keyed by an allow-listed code: nothing from the URL is echoed.
  const FLASH_TEXT: Record<string, string> = {
    created: "Session créée.",
    updated: "Session mise à jour.",
    deleted: "Session supprimée."
  };
  const flashText =
    sp.flash && Object.hasOwn(FLASH_TEXT, sp.flash)
      ? FLASH_TEXT[sp.flash]
      : null;
  const banner = flashText ? { text: flashText } : null;

  return (
    <>
      <AdminHeader user={user} title="Programme" subtitle="Sessions" />

      <PageBody>
        {banner && (
          <div
            role="status"
            className="rounded-card border border-lime-600/30 bg-lime/15 px-4 py-3 text-[14px] font-medium text-ink"
          >
            {banner.text}
          </div>
        )}

        <PageIntro
          title="Programme du sommet"
          description={
            sessions.length === 0
              ? "Aucune session pour le moment."
              : `${sessions.length} session${sessions.length > 1 ? "s" : ""} sur ${days.size} jour${days.size > 1 ? "s" : ""}. ${
                  canManage
                    ? "Les modifications apparaissent aussi sur le site public."
                    : "Consultation seule."
                }`
          }
          actions={
            canManage ? (
              <ButtonLink href="/admin/sessions/new" variant="primary">
                + Nouvelle session
              </ButtonLink>
            ) : undefined
          }
        />

        {sessions.length === 0 ? (
          <EmptyState
            title="Aucune session."
            hint={
              canManage
                ? "Ajoutez la première session du programme."
                : "Le programme n'a pas encore été renseigné."
            }
            action={
              canManage ? (
                <ButtonLink href="/admin/sessions/new" variant="primary">
                  + Nouvelle session
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          Array.from(days.entries()).map(([key, day]) => (
            <section key={key} aria-label={day.label}>
              <div className="mb-3 flex flex-wrap items-baseline gap-3">
                <h2 className="font-display text-[19px] font-bold capitalize tracking-tight text-ink">
                  {day.label}
                </h2>
                <span className="text-[14px] font-semibold text-ink/50">
                  {day.items.length} session{day.items.length > 1 ? "s" : ""}
                </span>
              </div>

              <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(15,25,60,0.05)]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left text-[14px]">
                    <thead className="border-b border-line bg-frost text-[12.5px] font-semibold text-ink/60">
                      <tr>
                        <th className="px-5 py-3">Heure</th>
                        <th className="px-5 py-3">Session</th>
                        <th className="px-5 py-3">Type</th>
                        <th className="px-5 py-3">Lieu</th>
                        <th className="px-5 py-3">Intervenants</th>
                        {canManage && (
                          <th className="px-5 py-3 text-right">Actions</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {day.items.map((s) => {
                        const end = new Date(
                          s.startsAt.getTime() + s.durationMin * 60_000
                        );
                        const names = s.speakers.map((x) => x.speaker.fullName);
                        return (
                          <tr
                            key={s.id}
                            className="align-top transition-colors hover:bg-frost"
                          >
                            <td className="whitespace-nowrap px-5 py-4">
                              <p className="font-semibold tabular-nums text-ink">
                                {hm(s.startsAt)}
                              </p>
                              <p className="text-[13px] tabular-nums text-ink/55">
                                → {hm(end)} · {s.durationMin} min
                              </p>
                            </td>
                            <td className="px-5 py-4">
                              <p className="font-semibold text-ink">
                                {s.title}
                                {s.isHighlighted && (
                                  <span className="ml-2 align-middle">
                                    <Chip tone="warn">À la une</Chip>
                                  </span>
                                )}
                              </p>
                              {s.summary && (
                                <p className="mt-0.5 line-clamp-1 text-[13px] text-ink/60">
                                  {s.summary}
                                </p>
                              )}
                            </td>
                            <td className="px-5 py-4">
                              <Chip tone={TYPE_TONE[s.type] ?? "neutral"}>
                                {SESSION_TYPE_LABEL[s.type] ?? s.type}
                              </Chip>
                            </td>
                            <td className="px-5 py-4 text-ink/75">
                              {s.space?.name ?? s.stage ?? "—"}
                            </td>
                            <td className="px-5 py-4 text-ink/75">
                              {names.length > 0 ? names.join(", ") : "—"}
                            </td>
                            {canManage && (
                              <td className="whitespace-nowrap px-5 py-4 text-right">
                                <div className="inline-flex items-center gap-1">
                                  <Link
                                    href={`/admin/sessions/${s.id}/edit`}
                                    className="rounded-btn bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-ink/85"
                                  >
                                    Modifier
                                  </Link>
                                  <DeleteSessionButton
                                    id={s.id}
                                    title={s.title}
                                  />
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          ))
        )}
      </PageBody>
    </>
  );
}

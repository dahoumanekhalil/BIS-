import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/auth";
import { prisma } from "@/lib/db";
import { SpeakerDashboardClient } from "./speaker-dashboard-client";

export const dynamic = "force-dynamic";

export default async function SpeakerDashboardPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/speaker/login");

  const speaker = await prisma.speaker.findFirst({
    where: { adminUserId: admin.user.id },
    include: {
      sessions: {
        include: {
          session: {
            select: {
              id: true,
              title: true,
              type: true,
              summary: true,
              startsAt: true,
              durationMin: true,
              space: { select: { name: true } },
            },
          },
        },
        orderBy: { session: { startsAt: "asc" } },
      },
    },
  });

  if (!speaker) redirect("/speaker/login");

  const speakerData = {
    ...speaker,
    sessions: speaker.sessions.map(({ session }) => ({
      session: {
        id: session.id,
        title: session.title,
        type: session.type,
        description: session.summary,
        startsAt: session.startsAt,
        endsAt: new Date(
          session.startsAt.getTime() + session.durationMin * 60_000
        ),
        room: session.space,
      },
    })),
  };

  return (
    <div className="min-h-screen bg-[#0a1628] text-white">
      {/* Top bar */}
      <header className="border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
              <span className="font-display text-sm font-black tracking-tighter text-amber-400">
                BIS
              </span>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/40">
                Espace Intervenant
              </p>
              <p className="text-[13px] font-semibold text-white">
                {speaker.fullName}
              </p>
            </div>
          </div>
          <form action="/api/speaker/logout" method="POST">
            <button
              type="submit"
              className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.15em] text-white/60 transition-all hover:bg-white/[0.08] hover:text-white"
            >
              Déconnexion
            </button>
          </form>
        </div>
      </header>

      <SpeakerDashboardClient speaker={speakerData} />
    </div>
  );
}
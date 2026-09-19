import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { prisma } from "@/lib/db";
import { SpeakerTable } from "./speaker-table";

export const dynamic = "force-dynamic";

export default async function AdminSpeakersPage() {
  const { user } = await requirePermission("speakers.view");

  const [speakers, users] = await Promise.all([
    prisma.speaker.findMany({
      orderBy: [{ isHighlighted: "desc" }, { order: "asc" }, { fullName: "asc" }],
      include: {
        _count: { select: { sessions: true } },
        adminUser: { select: { name: true, email: true } },
        sessions: {
          include: { session: { select: { title: true, type: true } } },
          take: 3,
        },
      },
    }),
    prisma.adminUser.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true },
    }),
  ]);

  const stats = {
    total: speakers.length,
    highlighted: speakers.filter((s) => s.isHighlighted).length,
    withSessions: speakers.filter((s) => s._count.sessions > 0).length,
    countries: new Set(speakers.map((s) => s.country).filter(Boolean)).size,
  };

  return (
    <>
      <AdminHeader user={user} title="Intervenants" subtitle="Event" />
      <div className="space-y-6 p-6">
        {/* Stats row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label="Total intervenants" value={stats.total} tone="ink" />
          <StatCard label="Mis en avant" value={stats.highlighted} tone="lime" />
          <StatCard label="Avec sessions" value={stats.withSessions} tone="blue" />
          <StatCard label="Pays représentés" value={stats.countries} tone="gold" />
        </div>

        {/* Speakers table */}
        <SpeakerTable speakers={speakers} users={users} />
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ink" | "lime" | "blue" | "gold";
}) {
  const colors = {
    ink: "bg-white border-line text-ink",
    lime: "bg-lime/10 border-lime/30 text-ink",
    blue: "bg-blue-50 border-blue-200 text-blue-800",
    gold: "bg-amber-50 border-amber-200 text-amber-800",
  };

  return (
    <div className={`rounded-card border px-5 py-4 ${colors[tone]}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
        {label}
      </p>
      <p className="mt-1 font-display text-[28px] font-black leading-none tabular-nums">
        {value}
      </p>
    </div>
  );
}
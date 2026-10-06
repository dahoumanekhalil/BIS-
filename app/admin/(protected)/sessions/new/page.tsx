import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { prisma } from "@/lib/db";
import { AdminHeader } from "@/components/admin/header";
import { PageBody } from "@/components/admin/page-kit";
import { SessionForm } from "../session-form";

export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  const { user } = await requirePermission("sessions.manage");

  const [event, spaces, speakers] = await Promise.all([
    prisma.event.findFirst({
      orderBy: { startsAt: "asc" },
      select: { id: true }
    }),
    prisma.space.findMany({
      orderBy: { order: "asc" },
      select: { id: true, name: true }
    }),
    prisma.speaker.findMany({
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true, organization: true }
    })
  ]);

  return (
    <>
      <AdminHeader user={user} title="Nouvelle session" subtitle="Programme" />
      <PageBody>
        <Link
          href="/admin/sessions"
          className="inline-flex items-center gap-1 text-[14px] font-semibold text-ink/65 hover:text-ink"
        >
          ← Retour au programme
        </Link>

        {!event ? (
          <div
            role="alert"
            className="rounded-card border border-amber-300 bg-amber-50 px-4 py-3 text-[14px] text-amber-900"
          >
            Aucun événement n&apos;est configuré dans la base de données :
            impossible d&apos;ajouter une session pour le moment.
          </div>
        ) : (
          <SessionForm mode="create" spaces={spaces} speakers={speakers} />
        )}
      </PageBody>
    </>
  );
}

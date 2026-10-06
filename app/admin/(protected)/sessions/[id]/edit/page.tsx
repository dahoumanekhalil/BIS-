import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { prisma } from "@/lib/db";
import { toEventLocalInput } from "@/lib/admin/session-input";
import { AdminHeader } from "@/components/admin/header";
import { Card, PageBody } from "@/components/admin/page-kit";
import { SessionForm } from "../../session-form";
import { DeleteSessionButton } from "../../delete-session-button";

export const dynamic = "force-dynamic";

export default async function EditSessionPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePermission("sessions.manage");
  const { id } = await params;

  const [session, spaces, speakers] = await Promise.all([
    prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        summary: true,
        type: true,
        category: true,
        startsAt: true,
        durationMin: true,
        stage: true,
        spaceId: true,
        isHighlighted: true,
        order: true,
        speakers: { select: { speakerId: true } }
      }
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
  if (!session) notFound();

  return (
    <>
      <AdminHeader user={user} title="Modifier la session" subtitle="Programme" />
      <PageBody>
        <Link
          href="/admin/sessions"
          className="inline-flex items-center gap-1 text-[14px] font-semibold text-ink/65 hover:text-ink"
        >
          ← Retour au programme
        </Link>

        <SessionForm
          mode="edit"
          id={session.id}
          spaces={spaces}
          speakers={speakers}
          initial={{
            title: session.title,
            summary: session.summary ?? "",
            type: session.type,
            category: session.category,
            startsAt: toEventLocalInput(session.startsAt),
            durationMin: session.durationMin,
            stage: session.stage ?? "",
            spaceId: session.spaceId ?? "",
            isHighlighted: session.isHighlighted,
            order: session.order,
            speakerIds: session.speakers.map((s) => s.speakerId)
          }}
        />

        <Card
          title="Zone sensible"
          description="La suppression retire la session du programme et du site public."
        >
          <DeleteSessionButton
            id={session.id}
            title={session.title}
            variant="solid"
          />
        </Card>
      </PageBody>
    </>
  );
}

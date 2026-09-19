import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { getRegistrant } from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { EmailComposer } from "./composer";
import { EMAIL_TEMPLATES } from "@/lib/admin/email-templates";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function EmailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePermission("registrants.email");
  const { id } = await params;
  const r = await getRegistrant(id);
  if (!r) notFound();

  const historyRaw = await prisma.emailMessage.findMany({
    where: { participantId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      subject: true,
      templateKey: true,
      status: true,
      createdAt: true,
      sentAt: true,
      body: true,
      html: true,
      toEmail: true,
      sentByUserId: true
    }
  });

  const senderIds = Array.from(
    new Set(historyRaw.map((h) => h.sentByUserId).filter(Boolean))
  ) as string[];
  const senders =
    senderIds.length > 0
      ? await prisma.adminUser.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, name: true, email: true }
        })
      : [];
  const senderMap = new Map(senders.map((s) => [s.id, s]));

  const history = historyRaw.map((h) => ({
    id: h.id,
    subject: h.subject,
    templateKey: h.templateKey,
    status: h.status,
    createdAt: h.createdAt,
    sentAt: h.sentAt,
    body: h.body,
    html: h.html,
    toEmail: h.toEmail,
    sender: h.sentByUserId ? senderMap.get(h.sentByUserId) ?? null : null
  }));

  return (
    <>
      <AdminHeader
        user={user}
        title={`Écrire à ${r.firstName} ${r.lastName}`}
        subtitle="Email"
      />
      <div className="space-y-5 p-6">
        <Link
          href={`/admin/registrants/${id}`}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          ← Retour à la fiche
        </Link>

        <EmailComposer
          participant={{
            id: r.id,
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
            tier: r.tier,
            gate: r.gate,
            ticketCode: r.ticketCode,
            paymentAmount: r.paymentAmount,
            paymentRef: r.paymentRef
          }}
          templates={EMAIL_TEMPLATES}
          history={history}
        />
      </div>
    </>
  );
}

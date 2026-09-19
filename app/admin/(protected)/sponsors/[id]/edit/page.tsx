import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { prisma } from "@/lib/db";
import { AdminHeader } from "@/components/admin/header";
import { SponsorForm } from "../../sponsor-form";

export const dynamic = "force-dynamic";

export default async function EditSponsorPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePermission("sponsors.manage");
  const { id } = await params;
  const sponsor = await prisma.partner.findUnique({ where: { id } });
  if (!sponsor) notFound();

  return (
    <>
      <AdminHeader
        user={user}
        title={`Modifier · ${sponsor.name}`}
        subtitle="Business · Sponsors"
      />
      <div className="space-y-5 p-6">
        <Link
          href="/admin/sponsors"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          ← Retour à la liste
        </Link>
        <SponsorForm
          mode="edit"
          id={id}
          initial={{
            name: sponsor.name,
            tier: sponsor.tier,
            order: sponsor.order,
            website: sponsor.website ?? "",
            logoUrl: sponsor.logoUrl ?? ""
          }}
        />
      </div>
    </>
  );
}

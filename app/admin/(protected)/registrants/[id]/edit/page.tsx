import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { getRegistrant } from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { EditRegistrantForm } from "./edit-form";

export const dynamic = "force-dynamic";

export default async function EditRegistrantPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePermission("registrants.edit");
  const { id } = await params;
  const r = await getRegistrant(id);
  if (!r) notFound();

  return (
    <>
      <AdminHeader
        user={user}
        title={`Modifier · ${r.firstName} ${r.lastName}`}
        subtitle="Registrant"
      />
      <div className="space-y-5 p-6">
        <Link
          href={`/admin/registrants/${id}`}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          ← Retour à la fiche
        </Link>

        <EditRegistrantForm
          id={id}
          initial={{
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
            phone: r.phone ?? "",
            organization: r.organization ?? "",
            jobTitle: r.jobTitle ?? "",
            country: r.country,
            tier: r.tier ?? "",
            gate: r.gate ?? "",
            status: r.status,
            ticketCode: r.ticketCode ?? "",
            registrationType: r.registrationType
          }}
        />
      </div>
    </>
  );
}

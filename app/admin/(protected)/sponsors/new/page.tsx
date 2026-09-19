import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { SponsorForm } from "../sponsor-form";

export default async function NewSponsorPage() {
  const { user } = await requirePermission("sponsors.manage");
  return (
    <>
      <AdminHeader
        user={user}
        title="Nouveau sponsor"
        subtitle="Business · Sponsors"
      />
      <div className="space-y-5 p-6">
        <Link
          href="/admin/sponsors"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          ← Retour à la liste
        </Link>
        <SponsorForm mode="create" />
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { getCurrentAccount } from "@/lib/account/auth";
import { prisma } from "@/lib/db";
import { ensureParticipantForAccount } from "@/lib/register/participant";
import { RoleAuthGate } from "@/components/register/role-auth-gate";
import { OnboardingConflictScreen } from "@/components/forms/onboarding-conflict-screen";
import {
  RolePageShell,
  AlreadyAppliedPanel
} from "@/components/register/role-page-shell";
import { SponsorApplicationForm } from "@/components/register/sponsor-form";

export const metadata: Metadata = {
  title: "Postuler · Sponsor",
  description:
    "Explorez une opportunité de sponsoring avec le Algeria Brand Impact Summit 2027."
};

export const dynamic = "force-dynamic";

export default async function RegisterSponsorPage() {
  const account = await getCurrentAccount();
  if (!account) {
    return (
      <RoleAuthGate
        role="sponsor"
        next="/register/sponsor"
        blurb="Associer votre marque à l'écosystème BIS et à l'ambition Algérie 2027."
      />
    );
  }

  const ensured = await ensureParticipantForAccount(account);
  if (ensured.kind === "no-event") {
    return (
      <section className="relative overflow-hidden bg-white py-16 lg:py-24">
        <div className="container-page max-w-2xl text-center">
          <h1 className="font-display text-3xl font-black text-ink">
            L&apos;événement n&apos;est pas encore configuré
          </h1>
          <p className="mt-4 text-[15px] text-ink/70">
            Contactez l&apos;organisation.
          </p>
        </div>
      </section>
    );
  }
  if (ensured.kind === "conflict") {
    return (
      <section className="relative overflow-hidden bg-white py-16 lg:py-24">
        <div className="container-page">
          <OnboardingConflictScreen />
        </div>
      </section>
    );
  }
  const participant = ensured.participant;

  const existing = await prisma.application.findFirst({
    where: { participantId: participant.id, type: "SPONSOR" },
    select: { id: true }
  });
  if (existing) {
    return <AlreadyAppliedPanel roleLabel="Sponsor" />;
  }

  return (
    <RolePageShell
      eyebrow="Étape finale · Sponsor"
      title="Explorez une opportunité de sponsoring."
      intro="L'équipe partenariats étudiera votre candidature et vous répondra sous 48 heures."
      accountEmail={account.email}
    >
      <SponsorApplicationForm
        initial={{
          phone: participant.phone ?? "",
          country: participant.country ?? "Algérie",
          organization: participant.organization ?? "",
          industry: participant.companyIndustry ?? "",
          website: participant.companyWebsite ?? "",
          position: participant.jobTitle ?? ""
        }}
        needsPhone={!participant.phone}
      />
    </RolePageShell>
  );
}

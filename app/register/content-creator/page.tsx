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
import { ContentCreatorApplicationForm } from "@/components/register/content-creator-form";

export const metadata: Metadata = {
  title: "Postuler · Créateur de contenu",
  description:
    "Rejoignez la communauté des créateurs autour du Algeria Brand Impact Summit 2027."
};

export const dynamic = "force-dynamic";

export default async function RegisterContentCreatorPage() {
  const account = await getCurrentAccount();
  if (!account) {
    return (
      <RoleAuthGate
        role="créateur de contenu"
        next="/register/content-creator"
        blurb="Amplifier les idées, histoires et impact du sommet auprès de votre audience."
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
    where: { participantId: participant.id, type: "CONTENT_CREATOR" },
    select: { id: true }
  });
  if (existing) {
    return <AlreadyAppliedPanel roleLabel="Créateur de contenu" />;
  }

  return (
    <RolePageShell
      eyebrow="Étape finale · Créateur de contenu"
      title="Proposez votre couverture éditoriale."
      intro="L'équipe éditoriale étudiera votre proposition. Aucune accréditation n'est automatique."
      accountEmail={account.email}
    >
      <ContentCreatorApplicationForm
        initial={{
          phone: participant.phone ?? "",
          country: participant.country ?? "Algérie",
          organization: participant.organization ?? "",
          website: participant.companyWebsite ?? ""
        }}
        needsPhone={!participant.phone}
      />
    </RolePageShell>
  );
}

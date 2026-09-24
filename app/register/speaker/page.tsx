import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentAccount } from "@/lib/account/auth";
import { prisma } from "@/lib/db";
import { ensureParticipantForAccount } from "@/lib/register/participant";
import { RoleAuthGate } from "@/components/register/role-auth-gate";
import { OnboardingConflictScreen } from "@/components/forms/onboarding-conflict-screen";
import { SpeakerApplicationForm } from "@/components/register/speaker-form";

export const metadata: Metadata = {
  title: "Postuler · Intervenant",
  description:
    "Proposez votre intervention au comité éditorial du Algeria Brand Impact Summit 2027."
};

export const dynamic = "force-dynamic";

export default async function RegisterSpeakerPage() {
  const account = await getCurrentAccount();
  if (!account) {
    return (
      <RoleAuthGate
        role="intervenant"
        next="/register/speaker"
        blurb="Proposer une intervention, un keynote ou une masterclass au comité éditorial BIS."
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

  // If the participant already submitted a speaker application, bounce them
  // to /compte where they can see the status. We deliberately do NOT open
  // a fresh form — the unique constraint would reject anyway, and doing
  // so keeps the UX honest.
  const existing = await prisma.application.findFirst({
    where: { participantId: participant.id, type: "SPEAKER" },
    select: { id: true, status: true }
  });
  if (existing) {
    return (
      <section className="relative overflow-hidden bg-white py-16 lg:py-24">
        <div className="container-page mx-auto max-w-2xl text-center">
          <p className="eyebrow justify-center">
            <span className="h-px w-6 bg-ink/40" /> Intervenant
          </p>
          <h1 className="mt-4 font-display text-[clamp(1.9rem,3.2vw,2.5rem)] font-black leading-tight tracking-tight">
            Votre candidature a déjà été enregistrée.
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-ink/70">
            Le comité éditorial l&apos;étudiera et reviendra vers vous. Vous
            pouvez suivre son statut depuis votre espace personnel.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/compte/demandes" className="btn-lime">
              Voir mes candidatures
            </Link>
            <Link href="/compte" className="btn-ghost">
              Mon espace
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page mx-auto max-w-3xl">
        <header>
          <p className="eyebrow">
            <span className="h-px w-6 bg-ink/40" /> Étape finale · Intervenant
          </p>
          <h1 className="mt-4 font-display text-[clamp(1.9rem,3.2vw,2.75rem)] font-black leading-tight tracking-tight">
            Proposez votre intervention.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink/70">
            Compte connecté : <strong>{account.email}</strong>. Le comité
            éditorial étudie chaque proposition ; cette soumission n&apos;implique
            pas une sélection automatique.
          </p>
        </header>

        <div className="mt-10">
          <SpeakerApplicationForm
            initial={{
              phone: participant.phone ?? "",
              country: participant.country ?? "Algérie",
              organization: participant.organization ?? ""
            }}
            needsPhone={!participant.phone}
          />
        </div>
      </div>
    </section>
  );
}

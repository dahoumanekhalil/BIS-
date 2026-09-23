import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import { getOnboardingStatus } from "@/lib/onboarding";
import { OnboardingConflictScreen } from "@/components/forms/onboarding-conflict-screen";
import {
  participationFromSlug,
  PARTICIPATION_LABEL,
  type ParticipationChoiceKey
} from "@/lib/applications";
import { FormShell } from "@/components/forms/form-shell";
import { FormProgress } from "@/components/forms/form-progress";
import { VisitorConfirm } from "./visitor-confirm";
import { RoleDetailsForm } from "./role-details-form";
import { ApplicationType } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const choice = participationFromSlug(slug);
  if (!choice) return { title: "Participation" };
  return {
    title: `Participer · ${PARTICIPATION_LABEL[choice]}`,
    description: "Étape 3 de l'inscription BIS 2027."
  };
}

const INTRO_BY_CHOICE: Record<
  ParticipationChoiceKey,
  { title: string; intro: string; steps: { n: string; title: string; body: string }[] }
> = {
  VISITOR: {
    title: "Confirmez votre inscription au BIS 2027.",
    intro:
      "Aucune information supplémentaire n'est requise. Confirmez pour finaliser votre inscription.",
    steps: [
      { n: "01", title: "Inscription", body: "Enregistrée." },
      { n: "02", title: "Choix", body: "Participant / Visiteur." },
      { n: "03", title: "Confirmation", body: "Un clic suffit." }
    ]
  },
  SPONSOR: {
    title: "Complétez votre candidature sponsor.",
    intro:
      "Ces informations aident notre équipe partenariats à préparer notre échange. Cette candidature ne vaut pas engagement.",
    steps: [
      { n: "01", title: "Votre organisation", body: "Nom, secteur, site." },
      { n: "02", title: "Vos intentions", body: "Type de partenariat, domaines." },
      { n: "03", title: "Revue et envoi", body: "Vérifiez puis validez." }
    ]
  },
  PARTNER: {
    title: "Complétez votre candidature partenaire.",
    intro:
      "Décrivez votre organisation et la nature de la collaboration envisagée.",
    steps: [
      { n: "01", title: "Votre organisation", body: "Contexte et rôle." },
      { n: "02", title: "Votre proposition", body: "Type et intention de la collaboration." },
      { n: "03", title: "Revue et envoi", body: "Vérifiez puis validez." }
    ]
  },
  SPEAKER: {
    title: "Complétez votre proposition d'intervention.",
    intro:
      "Le comité éditorial étudiera votre proposition. Cette soumission n'implique pas une sélection automatique.",
    steps: [
      { n: "01", title: "Votre profil", body: "Bio, expertise, présence en ligne." },
      { n: "02", title: "Votre sujet", body: "Angle, format, promesse." },
      { n: "03", title: "Revue et envoi", body: "Vérifiez puis validez." }
    ]
  },
  CONTENT_CREATOR: {
    title: "Complétez votre candidature créateur.",
    intro:
      "Aidez-nous à comprendre votre univers et la façon dont vous couvririez BIS 2027.",
    steps: [
      { n: "01", title: "Votre univers", body: "Plateforme, audience, contenu." },
      { n: "02", title: "Votre proposition", body: "Ce que vous produiriez." },
      { n: "03", title: "Revue et envoi", body: "Vérifiez puis validez." }
    ]
  }
};

export default async function RegisterStep3Page({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const choice = participationFromSlug(slug);
  if (!choice) notFound();

  const status = await getOnboardingStatus();
  if (status.kind === "none") {
    // If the wizard state is missing and the user isn't logged in either,
    // restart from Step 1 while preserving the preselected participation.
    redirect(`/register?participation=${slug}`);
  }
  if (status.kind === "conflict") {
    return (
      <section className="relative overflow-hidden bg-white py-16 lg:py-24">
        <div className="container-page">
          <OnboardingConflictScreen />
        </div>
      </section>
    );
  }
  const participant = status.participant;

  const meta = INTRO_BY_CHOICE[choice];

  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page">
        <FormShell
          eyebrow={`S'inscrire · Étape 3 / 4 · ${PARTICIPATION_LABEL[choice]}`}
          backHref="/register/participation"
          backLabel="Changer de rôle"
          title={meta.title}
          intro={meta.intro}
          steps={meta.steps}
        >
          <FormProgress current={3} />
          {choice === "VISITOR" ? (
            <VisitorConfirm participant={participant} />
          ) : (
            <RoleDetailsForm
              type={choice as unknown as ApplicationType}
              participant={participant}
            />
          )}
        </FormShell>
      </div>
    </section>
  );
}

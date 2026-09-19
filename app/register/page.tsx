import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BasicRegistrationForm } from "@/components/forms/basic-registration-form";
import { FormShell } from "@/components/forms/form-shell";
import { FormProgress } from "@/components/forms/form-progress";
import { getOnboardingStatus } from "@/lib/onboarding";
import { OnboardingConflictScreen } from "@/components/forms/onboarding-conflict-screen";
import {
  participationFromSlug,
  PARTICIPATION_LABEL,
  PARTICIPATION_SLUG
} from "@/lib/applications";

export const metadata: Metadata = {
  title: "S'inscrire",
  description:
    "Rejoignez le Algeria Brand Impact Summit 2026 — une inscription, plusieurs façons de participer."
};

export const dynamic = "force-dynamic";

export default async function RegisterStep1Page({
  searchParams
}: {
  searchParams: Promise<{ participation?: string }>;
}) {
  const sp = await searchParams;
  const participation = participationFromSlug(sp.participation);

  // If a wizard session is already open OR the user is authenticated via
  // AccountUser, skip Step 1 and go straight to participation selection.
  // This is what makes the "S'inscrire via /auth → /register/participation"
  // flow work: /register itself is inert for logged-in users.
  const status = await getOnboardingStatus();
  if (status.kind === "wizard" || status.kind === "linked") {
    if (participation) {
      redirect(`/register/${PARTICIPATION_SLUG[participation]}`);
    }
    redirect("/register/participation");
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

  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page">
        <FormShell
          eyebrow="S'inscrire · Étape 1 / 4"
          title="Prenez votre place au BIS 2026."
          intro={
            participation ? (
              <>
                <p>
                  Vous souhaitez participer en tant que{" "}
                  <strong>
                    {PARTICIPATION_LABEL[participation].toLowerCase()}
                  </strong>
                  .
                </p>
                <p className="mt-2 text-[15px] text-ink/60">
                  Commencez par renseigner vos informations d'inscription. Le
                  détail de votre candidature suivra.
                </p>
              </>
            ) : (
              <>
                <p>
                  Cela prend moins de 2 minutes. Vous choisirez ensuite votre
                  façon de participer.
                </p>
                <p className="mt-4 text-[15px] text-ink/60">
                  Vous représentez une organisation ? Cochez la case au bas du
                  formulaire pour ajouter ses informations.
                </p>
              </>
            )
          }
          steps={[
            {
              n: "01",
              title: "Vos informations",
              body: "Contact et profil professionnel."
            },
            {
              n: "02",
              title: "Votre participation",
              body: "Visiteur, sponsor, partenaire, intervenant ou créateur."
            },
            {
              n: "03",
              title: "Vos détails",
              body: "Uniquement pour les rôles professionnels."
            },
            {
              n: "04",
              title: "Confirmation",
              body: "Un récapitulatif et un email de confirmation."
            }
          ]}
          aside={
            <div className="mt-8 border-t border-black/[0.08] pt-6 text-[13px] text-ink/60">
              <p>
                Envie de comprendre les rôles professionnels avant de
                commencer ?{" "}
                <Link
                  href="/be-a-part"
                  className="font-semibold text-cobalt underline-offset-4 hover:underline"
                >
                  Découvrir les façons de participer
                </Link>
                .
              </p>
            </div>
          }
        >
          <FormProgress current={1} />
          <BasicRegistrationForm
            participation={
              participation ? PARTICIPATION_SLUG[participation] : null
            }
          />
        </FormShell>
      </div>
    </section>
  );
}

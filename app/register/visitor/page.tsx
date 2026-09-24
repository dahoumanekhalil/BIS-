import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentAccount } from "@/lib/account/auth";
import { ensureParticipantForAccount } from "@/lib/register/participant";
import { RoleAuthGate } from "@/components/register/role-auth-gate";
import { OnboardingConflictScreen } from "@/components/forms/onboarding-conflict-screen";
import { VisitorRegistrationForm } from "@/components/register/visitor-form";

// /register/visitor — the visitor role flow.
//
//   • Not logged in → invite the user to log in or create an account.
//     After auth the `?next=` param brings them right back here.
//   • Logged in + no anonymous Participant conflict → render the small
//     completion form (phone, country, optional org / job title).
//   • Logged in + anonymous Participant conflict → render the conflict
//     screen (the legacy-claim flow handles binding once the user
//     verifies email ownership).

export const metadata: Metadata = {
  title: "S'inscrire · Visiteur",
  description: "Finalisez votre inscription visiteur au Algeria Brand Impact Summit 2027."
};

export const dynamic = "force-dynamic";

export default async function RegisterVisitorPage() {
  const account = await getCurrentAccount();
  if (!account) {
    return (
      <RoleAuthGate
        role="visiteur"
        next="/register/visitor"
        blurb="Assister au sommet et recevoir votre badge digital."
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

  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page mx-auto max-w-3xl">
        <header>
          <p className="eyebrow">
            <span className="h-px w-6 bg-ink/40" /> Étape finale · Visiteur
          </p>
          <h1 className="mt-4 font-display text-[clamp(1.9rem,3.2vw,2.75rem)] font-black leading-tight tracking-tight">
            Confirmez votre participation.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink/70">
            Compte connecté : <strong>{account.email}</strong>. Quelques
            informations pour finaliser votre inscription.
          </p>
        </header>

        <div className="mt-10">
          <VisitorRegistrationForm
            initial={{
              phone: participant.phone ?? "",
              country: participant.country ?? "Algérie",
              organization: participant.organization ?? "",
              jobTitle: participant.jobTitle ?? ""
            }}
          />
        </div>

        <p className="mt-10 text-[12.5px] text-ink/55">
          Vous voulez postuler comme intervenant ?{" "}
          <Link
            href="/register/speaker"
            className="font-semibold text-cobalt underline-offset-4 hover:underline"
          >
            Rejoindre le parcours intervenant
          </Link>
          . Une seule inscription vous permet de suivre plusieurs candidatures.
        </p>
      </div>
    </section>
  );
}

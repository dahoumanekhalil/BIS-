import type { Metadata } from "next";
import { FormShell } from "@/components/forms/form-shell";
import { FormProgress } from "@/components/forms/form-progress";
import { SuccessScreen } from "@/components/forms/submission-state";
import {
  participationFromSlug,
  PARTICIPATION_LABEL
} from "@/lib/applications";

export const metadata: Metadata = {
  title: "Inscription complétée",
  description: "Votre inscription au BIS 2026 est enregistrée."
};

export const dynamic = "force-dynamic";

export default async function CompletePage({
  searchParams
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const sp = await searchParams;
  const choice = participationFromSlug(sp.type);

  const isVisitor = choice === "VISITOR";
  const isApplication =
    choice !== null && choice !== "VISITOR";

  const eyebrow = isVisitor
    ? "Inscription confirmée"
    : isApplication
      ? "Candidature reçue"
      : "Étape terminée";

  const title = isVisitor
    ? "Votre inscription est enregistrée."
    : isApplication
      ? "Votre demande a bien été reçue."
      : "Merci.";

  const message = isVisitor ? (
    <>
      <p>
        Bienvenue au BIS 2026. Votre inscription a bien été prise en compte.
      </p>
      <p className="mt-1 text-ink/60">
        Un email de confirmation vous a été envoyé.
      </p>
    </>
  ) : isApplication ? (
    <>
      <p>
        Votre candidature en tant que{" "}
        <strong>{PARTICIPATION_LABEL[choice].toLowerCase()}</strong> a bien
        été transmise à nos équipes.
      </p>
      <p className="mt-1 text-ink/60">
        Vous recevrez un accusé de réception par email. Cette confirmation ne
        vaut pas engagement — notre équipe reviendra vers vous après examen
        du dossier.
      </p>
    </>
  ) : (
    <p>Merci d'avoir pris le temps de vous inscrire.</p>
  );

  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page">
        <FormShell
          eyebrow="S'inscrire · Étape 4 / 4"
          title="C'est enregistré."
          intro={
            isApplication
              ? "Merci pour votre candidature. Voici la suite."
              : "Merci — votre place au BIS 2026 est prise."
          }
        >
          <FormProgress current={4} />

          <SuccessScreen
            variant={isVisitor ? "registration" : "application"}
            eyebrow={eyebrow}
            title={title}
            message={message}
            primaryCta={{ href: "/", label: "Retour à l'accueil" }}
            secondaryCta={{
              href: "/programme",
              label: "Voir le programme"
            }}
          />
        </FormShell>
      </div>
    </section>
  );
}

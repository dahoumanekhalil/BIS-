import Link from "next/link";
import { FormShell } from "./form-shell";

/**
 * Rendered when the current AccountUser's email collides with an anonymous
 * Participant record on the event. We refuse to auto-link (see the security
 * note in `lib/onboarding.ts`) — the user needs support intervention.
 */
export function OnboardingConflictScreen() {
  return (
    <FormShell
      eyebrow="Inscription · Conflit"
      title="Nous avons besoin d'un coup de main."
      intro={
        <>
          <p>
            Une inscription au BIS 2026 existe déjà avec cette adresse email.
            Pour votre sécurité, nous ne pouvons pas la rattacher
            automatiquement à votre compte.
          </p>
          <p className="mt-4 text-[15px] text-ink/60">
            Écrivez-nous — nous rapprocherons manuellement votre inscription
            et votre compte. Vous n'avez rien perdu.
          </p>
        </>
      }
    >
      <div className="space-y-6 text-[14.5px] leading-relaxed text-ink/80">
        <p>
          Cela peut arriver lorsqu'une inscription anonyme a déjà été
          effectuée avec la même adresse email.
        </p>
        <div className="rounded-2xl border border-black/[0.08] bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Contact
          </p>
          <p className="mt-2">
            <a
              href="mailto:hello@bis-algeria.dz"
              className="font-semibold text-cobalt underline-offset-4 hover:underline"
            >
              hello@bis-algeria.dz
            </a>
          </p>
          <p className="mt-4 text-[13px] text-ink/60">
            Précisez votre nom, votre adresse email, et une brève description
            de la situation. Nous vous répondons sous 48 heures ouvrées.
          </p>
        </div>
        <div>
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.18em] text-ink/60 hover:text-ink"
          >
            <span aria-hidden>←</span> Retour à l'accueil
          </Link>
        </div>
      </div>
    </FormShell>
  );
}

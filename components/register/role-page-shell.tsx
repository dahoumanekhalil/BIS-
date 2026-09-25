import type { ReactNode } from "react";
import Link from "next/link";

// Shared shell for the /register/<role> pages. Every role passes:
//   • its eyebrow / title / intro copy
//   • the AccountUser email to display in the header
//   • the form component (client) as children
//
// Deliberately server-rendered — no client state, no interactivity.

export function RolePageShell({
  eyebrow,
  title,
  intro,
  accountEmail,
  children
}: {
  eyebrow: string;
  title: ReactNode;
  intro: ReactNode;
  accountEmail: string;
  children: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page mx-auto max-w-3xl">
        <header>
          <p className="eyebrow">
            <span className="h-px w-6 bg-ink/40" /> {eyebrow}
          </p>
          <h1 className="mt-4 font-display text-[clamp(1.9rem,3.2vw,2.75rem)] font-black leading-tight tracking-tight">
            {title}
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink/70">
            Compte connecté : <strong>{accountEmail}</strong>. {intro}
          </p>
        </header>

        <div className="mt-10">{children}</div>

        <p className="mt-10 text-[12.5px] text-ink/55">
          Vous voulez ajouter une autre façon de participer ?{" "}
          <Link
            href="/register"
            className="font-semibold text-cobalt underline-offset-4 hover:underline"
          >
            Retour au choix
          </Link>
          . Une seule inscription vous permet de suivre plusieurs candidatures.
        </p>
      </div>
    </section>
  );
}

// Rendered when a user already submitted an application of this role and
// hits /register/<role> again. Shows a friendly "you already applied"
// state instead of a duplicate form.
export function AlreadyAppliedPanel({
  roleLabel
}: {
  roleLabel: string;
}) {
  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page mx-auto max-w-2xl text-center">
        <p className="eyebrow justify-center">
          <span className="h-px w-6 bg-ink/40" /> {roleLabel}
        </p>
        <h1 className="mt-4 font-display text-[clamp(1.9rem,3.2vw,2.5rem)] font-black leading-tight tracking-tight">
          Votre candidature a déjà été enregistrée.
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-ink/70">
          L&apos;équipe BIS l&apos;étudiera et reviendra vers vous. Vous pouvez
          suivre son statut depuis votre espace personnel.
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

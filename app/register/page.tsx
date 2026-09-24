import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAccount } from "@/lib/account/auth";
import { participationFromSlug } from "@/lib/applications";
import { RoleSelector } from "@/components/register/role-selector";

// Role selector — the single public entry point for BIS 2027 registration.
// Every role flow branches from here. This page never creates a Participant
// or an AccountUser directly; those are the responsibility of the per-role
// flows and (for account creation) `/auth?mode=register`.
//
// Backward compat: an inbound `?participation=<slug>` shortcut still works
// so external "Be a Part" landing pages can deep-link straight into a role
// flow. Only known slugs are honoured; anything else falls through to the
// selector.

export const metadata: Metadata = {
  title: "S'inscrire",
  description:
    "Rejoignez le Algeria Brand Impact Summit 2027 — choisissez votre façon de participer."
};

export const dynamic = "force-dynamic";

export default async function RegisterRoleSelectorPage({
  searchParams
}: {
  searchParams: Promise<{ participation?: string }>;
}) {
  const sp = await searchParams;
  const preselect = participationFromSlug(sp.participation);

  // If the URL preselects an already-implemented role, jump straight there.
  // The role page handles authentication, so we can safely delegate.
  if (preselect === "VISITOR") redirect("/register/visitor");
  if (preselect === "SPEAKER") redirect("/register/speaker");

  const account = await getCurrentAccount();

  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page">
        <header className="mx-auto max-w-3xl text-center">
          <p className="eyebrow justify-center">
            <span className="h-px w-6 bg-ink/40" /> Rejoindre BIS 2027
          </p>
          <h1 className="mt-4 font-display text-[clamp(2rem,3.6vw,3rem)] font-black leading-tight tracking-tight">
            Comment souhaitez-vous <span className="text-cobalt">participer</span> ?
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-ink/70">
            Choisissez votre façon de participer. Chaque parcours crée ou réutilise
            votre compte BIS, votre inscription à l&apos;événement et votre badge
            digital.
          </p>
        </header>

        <div className="mx-auto mt-12 max-w-6xl">
          <RoleSelector isAuthenticated={account !== null} />
        </div>

        <p className="mx-auto mt-12 max-w-2xl text-center text-[13px] text-ink/55">
          Déjà inscrit(e) ?{" "}
          <Link
            href="/auth?mode=login"
            className="font-semibold text-cobalt underline-offset-4 hover:underline"
          >
            Se connecter
          </Link>{" "}
          pour retrouver votre badge et vos candidatures.
        </p>
      </div>
    </section>
  );
}

import Link from "next/link";

// Rendered by every role page when the visitor is not yet authenticated.
// Presents "Create account" + "Log in" links, both preserving the `next`
// param so the AuthExperience returns the user to the role flow after
// signup or login.
//
// Deliberately server-rendered — no state, no client JS. The role's own
// blurb is passed in so each flow can tailor the copy while sharing the
// visual shell.

export function RoleAuthGate({
  role,
  next,
  blurb
}: {
  role: string;
  next: string;
  blurb: string;
}) {
  const registerHref = `/auth?mode=register&next=${encodeURIComponent(next)}`;
  const loginHref = `/auth?mode=login&next=${encodeURIComponent(next)}`;

  return (
    <section className="relative overflow-hidden bg-white py-16 lg:py-24">
      <div className="container-page mx-auto max-w-2xl">
        <header className="text-center">
          <p className="eyebrow justify-center">
            <span className="h-px w-6 bg-ink/40" /> Étape 1 · Votre compte BIS
          </p>
          <h1 className="mt-4 font-display text-[clamp(1.9rem,3.2vw,2.5rem)] font-black leading-tight tracking-tight">
            Créez un compte pour continuer comme <span className="text-cobalt">{role}</span>.
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-ink/70">
            {blurb} Votre compte BIS sert à toutes vos candidatures et à
            l&apos;accès à votre badge digital.
          </p>
        </header>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <Link
            href={registerHref}
            className="group inline-flex flex-col justify-between rounded-[20px] border border-lime bg-lime/10 p-6 text-left transition-colors hover:bg-lime/20"
          >
            <div>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
                Nouveau
              </p>
              <h2 className="mt-2 font-display text-xl font-black text-ink">
                Créer un compte
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed text-ink/70">
                Signup rapide — nom, email, mot de passe. Vous revenez ici après
                pour finaliser votre inscription {role}.
              </p>
            </div>
            <span className="mt-5 inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.18em] text-ink">
              Continuer <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
            </span>
          </Link>

          <Link
            href={loginHref}
            className="group inline-flex flex-col justify-between rounded-[20px] border border-black/[0.08] bg-white p-6 text-left transition-colors hover:border-black/25"
          >
            <div>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
                Déjà inscrit(e) ?
              </p>
              <h2 className="mt-2 font-display text-xl font-black text-ink">
                Se connecter
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed text-ink/70">
                Retrouvez votre badge et vos candidatures existantes. Vous
                reviendrez ensuite au parcours {role}.
              </p>
            </div>
            <span className="mt-5 inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.18em] text-cobalt">
              Continuer <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}

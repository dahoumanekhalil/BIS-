import Link from "next/link";
import { validatePasswordResetToken } from "@/lib/account/password-reset";
import { ResetForm } from "./reset-form";

export const metadata = {
  title: "Réinitialisation du mot de passe",
  description: "Définissez un nouveau mot de passe pour votre compte BIS 2026."
};

export default async function MotDePasseResetPage({
  searchParams
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const rawToken = (sp?.token ?? "").trim();

  // Server-side pre-check so an obviously invalid / expired / used token
  // renders the "expired link" state without ever showing the form. The
  // authoritative single-use enforcement lives inside the action.
  const state = rawToken
    ? await validatePasswordResetToken(rawToken)
    : ({ ok: false, reason: "invalid" } as const);

  return (
    <section className="container-page py-16">
      <div className="mx-auto max-w-md rounded-[20px] border border-line bg-white p-8">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
          Sécurité du compte
        </p>
        <h1 className="mt-2 font-display text-2xl font-black tracking-tight text-ink">
          Nouveau mot de passe
        </h1>

        {state.ok ? (
          <>
            <p className="mt-3 text-[14px] leading-relaxed text-ink/65">
              Choisissez un nouveau mot de passe. Vos autres sessions actives
              seront déconnectées.
            </p>
            <ResetForm token={rawToken} />
          </>
        ) : (
          <>
            <p className="mt-3 text-[14px] leading-relaxed text-ink/65">
              Ce lien de réinitialisation n'est plus valide. Faites une
              nouvelle demande depuis la page « Mot de passe oublié ».
            </p>
            <div className="mt-6 flex gap-3">
              <Link
                href="/auth/mot-de-passe-oublie"
                className="rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime"
              >
                Nouvelle demande
              </Link>
              <Link
                href="/auth?mode=login"
                className="rounded-btn border border-line px-4 py-2 text-[13px] font-semibold text-ink"
              >
                Connexion
              </Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

import Link from "next/link";
import { requireAccount } from "@/lib/account/auth";
import { logoutAccount } from "@/app/actions/account";
import { CompteCard, CompteRow } from "@/components/compte/card";

export const metadata = { title: "Sécurité" };

export default async function CompteSecuritePage() {
  const account = await requireAccount();

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <CompteCard eyebrow="Compte" title="Session active">
        <dl>
          <CompteRow label="Email de connexion" value={account.email} />
          <CompteRow
            label="Nom du compte"
            value={`${account.firstName} ${account.lastName}`}
          />
        </dl>
        <div className="mt-6 border-t border-line/70 pt-5">
          <form action={logoutAccount}>
            <button type="submit" className="btn-ghost w-full justify-center">
              Se déconnecter de ce navigateur
            </button>
          </form>
        </div>
      </CompteCard>

      <CompteCard eyebrow="Sécurité" title="Mot de passe">
        <p className="text-[13.5px] leading-relaxed text-ink/70">
          La modification du mot de passe depuis votre espace personnel sera
          disponible dans une prochaine mise à jour.
        </p>
        <div className="mt-6 space-y-3">
          <button
            type="button"
            disabled
            className="btn-ghost w-full cursor-not-allowed justify-center opacity-60"
            aria-disabled="true"
          >
            Changer mon mot de passe · Bientôt disponible
          </button>
          <p className="text-[11.5px] leading-relaxed text-ink/50">
            En cas de perte d&apos;accès, contactez l&apos;équipe BIS via la
            page{" "}
            <Link
              href="/contact"
              className="font-semibold text-cobalt hover:text-cobalt-700"
            >
              Contact
            </Link>
            .
          </p>
        </div>
      </CompteCard>
    </div>
  );
}

import Link from "next/link";
import { requireAccount } from "@/lib/account/auth";
import { getCompteContext } from "@/lib/account/participant";
import { CompteCard, CompteRow } from "@/components/compte/card";

export const metadata = { title: "Mon profil" };

// URL-scheme allowlist. React 18 renders `href="javascript:..."` verbatim,
// which turns any user-supplied URL into a self-XSS gadget (and worse, a
// stored XSS if the same value is ever shown to admins). Accept only http
// and https absolute URLs; anything else falls back to plain text.
function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export default async function CompteProfilPage() {
  const account = await requireAccount();
  const { participant } = await getCompteContext(account);

  const isCompany = participant?.profile === "COMPANY";

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <CompteCard eyebrow="Identité" title="Informations personnelles">
        <dl>
          <CompteRow
            label="Prénom"
            value={participant?.firstName ?? account.firstName}
          />
          <CompteRow
            label="Nom"
            value={participant?.lastName ?? account.lastName}
          />
          <CompteRow label="Email" value={account.email} />
          <CompteRow label="Téléphone" value={participant?.phone} />
          <CompteRow label="Pays" value={participant?.country} />
        </dl>
        <div className="mt-6 border-t border-line/70 pt-5">
          <button
            type="button"
            disabled
            className="btn-ghost w-full cursor-not-allowed justify-center opacity-60"
            aria-disabled="true"
          >
            Modifier mon profil · Bientôt disponible
          </button>
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink/50">
            Pour toute modification urgente, contactez l&apos;équipe BIS via
            la page{" "}
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

      {participant && (
        <CompteCard
          eyebrow={isCompany ? "Organisation" : "Professionnel"}
          title={isCompany ? "Votre entreprise" : "Votre poste"}
        >
          <dl>
            <CompteRow label="Organisation" value={participant.organization} />
            <CompteRow label="Fonction" value={participant.jobTitle} />
            {isCompany && (
              <>
                <CompteRow label="Secteur" value={participant.companyIndustry} />
                <CompteRow
                  label="Site web"
                  value={(() => {
                    const raw = participant.companyWebsite;
                    if (!raw) return null;
                    const safe = safeExternalUrl(raw);
                    // Unsafe / non-http scheme → render as plain text so
                    // we still show what the participant entered, but the
                    // browser cannot execute it as a link.
                    if (!safe) return <span>{raw}</span>;
                    return (
                      <a
                        href={safe}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="font-medium text-cobalt hover:text-cobalt-700"
                      >
                        {safe}
                      </a>
                    );
                  })()}
                />
                <CompteRow label="Taille" value={participant.companySize} />
              </>
            )}
          </dl>
        </CompteCard>
      )}
    </div>
  );
}

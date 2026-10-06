import { requireAccount } from "@/lib/account/auth";
import { getCompteContext } from "@/lib/account/participant";
import { CompteHeader } from "@/components/compte/header";
import { CompteTabs } from "@/components/compte/tabs";
import { VerifyEmailBanner } from "@/components/compte/verify-email-banner";
import { isAccountEmailVerified } from "@/lib/account/email-verification";

export const metadata = {
  title: "Espace personnel",
  description: "Votre espace BIS 2027 : badge, accès, inscription et demandes."
};

// Guards every /compte/* route with the existing AccountUser session and
// preloads the participant context so downstream pages hit React's cache
// instead of the DB. Child pages MUST still call getCompteContext(account)
// themselves — layouts and pages do not share props in App Router.
export default async function ComptePageLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const account = await requireAccount();
  const { participant } = await getCompteContext(account);
  const emailVerified = await isAccountEmailVerified(account.id);

  return (
    <section className="min-h-[calc(100vh-var(--ticker-height)-var(--nav-height))] bg-frost">
      {!emailVerified && <VerifyEmailBanner email={account.email} />}
      <CompteHeader firstName={account.firstName} participant={participant} />
      <CompteTabs />
      <div className="container-page py-10 sm:py-14">{children}</div>
    </section>
  );
}

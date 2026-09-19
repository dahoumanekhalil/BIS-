import { Suspense } from "react";
import { AuthExperience } from "@/components/auth/auth-experience";

export const metadata = {
  title: "Connexion",
  description:
    "Créez votre compte ou connectez-vous pour construire votre parcours BIS 2026."
};

export default async function AuthPage({
  searchParams
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const sp = await searchParams;
  const initialMode = sp?.mode === "register" ? "register" : "login";
  return (
    <Suspense fallback={null}>
      <AuthExperience initialMode={initialMode} />
    </Suspense>
  );
}

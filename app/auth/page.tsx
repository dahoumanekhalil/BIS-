import { Suspense } from "react";
import { AuthExperience } from "@/components/auth/auth-experience";

export const metadata = {
  title: "Connexion",
  description:
    "Créez votre compte ou connectez-vous pour construire votre parcours BIS 2027."
};

// Whitelist for the `next` query param — never trust an arbitrary URL as
// a post-auth redirect target (open-redirect risk). Only accept
// same-origin paths that start with a known safe prefix.
//
// Rejects any path traversal segment (`/..`, `\`) or encoded variant so a
// prefix like `/register/../admin` cannot silently bounce to `/admin`.
function safeNext(input: string | undefined): string | null {
  if (!input) return null;
  if (!input.startsWith("/")) return null;
  // Prevent protocol-relative //evil.example bypass.
  if (input.startsWith("//")) return null;
  // Reject traversal segments (raw + percent-encoded) and backslashes.
  const lower = input.toLowerCase();
  if (
    lower.includes("/../") ||
    lower.endsWith("/..") ||
    lower.includes("/..%2f") ||
    lower.includes("/..%5c") ||
    lower.includes("\\")
  ) {
    return null;
  }
  const allowedPrefixes = ["/register", "/compte"];
  return allowedPrefixes.some((p) => input === p || input.startsWith(`${p}/`))
    ? input
    : null;
}

export default async function AuthPage({
  searchParams
}: {
  searchParams: Promise<{ mode?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const initialMode = sp?.mode === "register" ? "register" : "login";
  const next = safeNext(sp?.next);
  return (
    <Suspense fallback={null}>
      <AuthExperience initialMode={initialMode} next={next} />
    </Suspense>
  );
}

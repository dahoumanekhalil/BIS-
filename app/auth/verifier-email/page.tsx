import Link from "next/link";
import { cookies } from "next/headers";
import { reportUnexpectedSignup } from "./actions";

export const metadata = {
  title: "Vérification de l'email",
  description: "Confirmation de la vérification de votre adresse email BIS 2027."
};

const MESSAGES: Record<string, { title: string; body: string; tone: "ok" | "warn" | "err" }> = {
  ok: {
    title: "Adresse email confirmée.",
    body: "Votre compte est vérifié. Vous pouvez continuer votre inscription au BIS 2027.",
    tone: "ok"
  },
  expired: {
    title: "Ce lien a expiré.",
    body:
      "Reconnectez-vous à votre compte puis demandez un nouveau lien de vérification.",
    tone: "warn"
  },
  invalid: {
    title: "Lien invalide.",
    body:
      "Ce lien n'est plus valable. Reconnectez-vous à votre compte puis demandez un nouveau lien de vérification.",
    tone: "err"
  },
  secured: {
    title: "Compte sécurisé.",
    body:
      "Nous avons déconnecté toutes les sessions, rendu le mot de passe inutilisable et retiré le badge lié à ce compte. Si l'adresse est bien la vôtre, utilisez « Mot de passe oublié » pour reprendre le contrôle du compte ; l'équipe BIS pourra vous réémettre un badge.",
    tone: "ok"
  },
  throttled: {
    title: "Trop de tentatives.",
    body:
      "Trop de tentatives de vérification depuis votre connexion. Réessayez dans quelques minutes.",
    tone: "warn"
  }
};

export default async function VerifierEmailPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const key = (sp?.status ?? "invalid").toLowerCase();
  const msg = MESSAGES[key] ?? MESSAGES.invalid;
  // After a successful verification, offer "this wasn't me" while the
  // short-lived cookie set by the verification endpoint is still present.
  const jar = await cookies();
  const canReport = key === "ok" && Boolean(jar.get("bis_notme")?.value);

  const cls =
    msg.tone === "ok"
      ? "border-lime bg-lime/10"
      : msg.tone === "warn"
        ? "border-amber-300 bg-amber-50"
        : "border-red-200 bg-red-50";

  return (
    <section className="container-page py-16">
      <div className={`mx-auto max-w-lg rounded-[20px] border ${cls} p-8`}>
        <h1 className="font-display text-2xl font-black tracking-tight text-ink">
          {msg.title}
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-ink/70">{msg.body}</p>
        {canReport && (
          <form action={reportUnexpectedSignup} className="mt-5 rounded-lg border border-line bg-white p-4">
            <p className="text-[13px] leading-relaxed text-ink/70">
              Vous n&apos;avez pas créé de compte avec cette adresse ?
            </p>
            <button
              type="submit"
              className="mt-3 rounded-btn border border-red-300 bg-red-50 px-4 py-2 text-[13px] font-bold text-red-800 hover:bg-red-100"
            >
              Ce n&apos;est pas moi — sécuriser
            </button>
          </form>
        )}
        <div className="mt-6 flex gap-3">
          <Link
            href="/auth?mode=login"
            className="rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime"
          >
            Aller à la connexion
          </Link>
          <Link
            href="/"
            className="rounded-btn border border-line px-4 py-2 text-[13px] font-semibold text-ink"
          >
            Retour à l'accueil
          </Link>
        </div>
      </div>
    </section>
  );
}

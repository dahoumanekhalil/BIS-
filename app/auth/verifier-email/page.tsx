import Link from "next/link";

export const metadata = {
  title: "Vérification de l'email",
  description: "Confirmation de la vérification de votre adresse email BIS 2026."
};

const MESSAGES: Record<string, { title: string; body: string; tone: "ok" | "warn" | "err" }> = {
  ok: {
    title: "Adresse email confirmée.",
    body: "Votre compte est vérifié. Vous pouvez continuer votre inscription au BIS 2026.",
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

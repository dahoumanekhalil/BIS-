import Link from "next/link";

export default function NotFound() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div className="container-wide flex min-h-[60vh] flex-col items-center justify-center py-24 text-center">
        <p className="eyebrow">Erreur 404</p>
        <h1 className="mt-6 font-display text-display-xl">Page introuvable.</h1>
        <p className="mt-6 max-w-md text-brand-ink/70">
          La page que vous cherchez n'existe pas ou a été déplacée.
        </p>
        <Link href="/" className="btn-primary mt-10">
          Retour à l'accueil
        </Link>
      </div>
    </section>
  );
}

import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/auth";
import { LoginForm } from "./login-form";

export const metadata = {
  title: "BIS 2027 · Connexion Admin"
};

export default async function AdminLoginPage({
  searchParams
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const existing = await getCurrentAdmin();
  if (existing) {
    redirect(sp?.from && sp.from.startsWith("/admin") ? sp.from : "/admin/dashboard");
  }
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0a1628] p-6 text-white">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-lime/5 blur-[120px]" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-blue-500/5 blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-[420px]">
        {/* Header */}
        <div className="mb-10 text-center">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-sm">
            <span className="font-display text-xl font-black tracking-tighter text-lime">
              BIS
            </span>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-white/40">
            Business & Innovation Summit
          </p>
          <h1 className="mt-3 font-display text-[28px] font-black leading-tight tracking-tight">
            Espace Administrateur
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/45">
            Connectez-vous pour accéder au tableau de bord opérationnel du sommet BIS 2027.
          </p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-7 shadow-2xl shadow-black/20 backdrop-blur-xl">
          <LoginForm redirectTo={sp?.from} initialError={sp?.error} />
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-[12px] text-white/35">
          Pas encore de compte ?{" "}
          <a
            href="/admin/register"
            className="font-bold text-lime/80 transition-colors hover:text-lime"
          >
            Créer un compte administrateur
          </a>
        </p>
        <div className="mt-4 flex items-center justify-center gap-6 text-[10px] uppercase tracking-[0.2em] text-white/25">
          <span className="flex items-center gap-1.5">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Connexion sécurisée
          </span>
          <span className="flex items-center gap-1.5">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Session 12h
          </span>
        </div>
      </div>
    </div>
  );
}
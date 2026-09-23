import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/auth";
import { RegisterForm } from "./register-form";

export const metadata = {
  title: "BIS 2027 · Inscription Admin"
};

export default async function AdminRegisterPage() {
  const existing = await getCurrentAdmin();
  if (existing) redirect("/admin/dashboard");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0a1628] p-6 text-white">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-lime/5 blur-[120px]" />
        <div className="absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-blue-500/5 blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-[440px]">
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
            Créer un compte administrateur
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/45">
            Inscrivez-vous pour accéder à la plateforme d'administration du sommet BIS 2027.
          </p>
        </div>

        {/* Register card */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-7 shadow-2xl shadow-black/20 backdrop-blur-xl">
          <RegisterForm />
        </div>

        {/* Footer link */}
        <p className="mt-8 text-center text-[12px] text-white/35">
          Vous avez déjà un compte ?{" "}
          <a
            href="/admin/login"
            className="font-bold text-lime/80 transition-colors hover:text-lime"
          >
            Se connecter
          </a>
        </p>
      </div>
    </div>
  );
}
import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/auth";
import { prisma } from "@/lib/db";
import { SpeakerLoginForm } from "./speaker-login-form";

export const metadata = {
  title: "BIS 2027 · Espace Intervenant"
};

export default async function SpeakerLoginPage() {
  const existing = await getCurrentAdmin();
  if (existing) {
    // Check if linked to a speaker
    const speaker = await prisma.speaker.findFirst({
      where: { adminUserId: existing.user.id },
      select: { id: true }
    });
    if (speaker) redirect("/speaker/dashboard");
    redirect("/admin/dashboard");
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0a1628] p-6 text-white">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-amber-500/5 blur-[120px]" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-lime/5 blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-[420px]">
        {/* Header */}
        <div className="mb-10 text-center">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-sm">
            <span className="font-display text-xl font-black tracking-tighter text-red-500">
              BIS
            </span>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-white/40">
            Business & Innovation Summit
          </p>
          <h1 className="mt-3 font-display text-[28px] font-black leading-tight tracking-tight">
            Espace Intervenant
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/45">
            Connectez-vous pour accéder à votre profil, vos sessions et votre planning personnalisé.
          </p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-7 shadow-2xl shadow-black/20 backdrop-blur-xl">
          <SpeakerLoginForm />
        </div>

        {/* Footer */}
        <div className="mt-8 flex items-center justify-center gap-6 text-[10px] uppercase tracking-[0.2em] text-white/25">
          <span className="flex items-center gap-1.5">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Connexion sécurisée
          </span>
          <a href="/admin/login" className="transition-colors hover:text-white/50">
            Admin ?
          </a>
        </div>
      </div>
    </div>
  );
}
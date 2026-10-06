"use client";

import { useState, useTransition } from "react";
import { resendVerificationEmail } from "@/app/actions/account";

// Top-of-page notice for accounts whose email is not verified yet. The QR
// badge is issued automatically as soon as the email is confirmed, so this
// is the user's way to (re)receive the confirmation link.
export function VerifyEmailBanner({ email }: { email: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

  const resend = () => {
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await resendVerificationEmail());
      } catch {
        setResult({
          ok: false,
          message: "Envoi impossible pour le moment. Réessayez plus tard."
        });
      }
    });
  };

  return (
    <div
      role="status"
      className="border-b border-amber-300/70 bg-amber-50 text-amber-950"
    >
      <div className="container-page flex flex-wrap items-center justify-between gap-3 py-3">
        <p className="text-[13px] leading-relaxed">
          <strong className="font-bold">Confirmez votre adresse email</strong>{" "}
          ({email}) pour recevoir automatiquement votre QR code d&apos;accès.
          {result && (
            <span
              className={
                result.ok
                  ? "ml-2 font-semibold text-emerald-800"
                  : "ml-2 font-semibold text-red-800"
              }
            >
              {result.message}
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={resend}
          disabled={pending}
          className="inline-flex items-center rounded-btn bg-ink px-4 py-2 text-[12.5px] font-bold text-lime transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Envoi…" : "Renvoyer le lien de confirmation"}
        </button>
      </div>
    </div>
  );
}

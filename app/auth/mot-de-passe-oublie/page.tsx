"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  requestPasswordResetAction,
  type ForgotState
} from "./actions";

const initial: ForgotState = { status: "idle" };

export default function MotDePasseOubliePage() {
  const [state, action, pending] = useActionState(
    requestPasswordResetAction,
    initial
  );

  return (
    <section className="container-page py-16">
      <div className="mx-auto max-w-md rounded-[20px] border border-line bg-white p-8">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
          Sécurité du compte
        </p>
        <h1 className="mt-2 font-display text-2xl font-black tracking-tight text-ink">
          Mot de passe oublié
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-ink/65">
          Saisissez l'adresse email associée à votre compte. Si elle est
          reconnue, vous recevrez un lien pour définir un nouveau mot de passe.
        </p>

        <form action={action} className="mt-6 space-y-4">
          <label className="block text-[12px] font-semibold text-ink/70">
            Adresse email
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
            />
          </label>
          {state.status === "error" && state.fieldErrors?.email && (
            <p className="text-[11.5px] font-semibold text-red-700">
              {state.fieldErrors.email}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime disabled:opacity-60"
          >
            {pending ? "Envoi…" : "Envoyer le lien"}
          </button>
          {state.status === "success" && (
            <p className="rounded-btn bg-lime/20 px-3 py-2 text-[12.5px] font-semibold text-ink">
              {state.message}
            </p>
          )}
          {state.status === "error" && !state.fieldErrors?.email && (
            <p className="rounded-btn bg-red-100 px-3 py-2 text-[12.5px] font-semibold text-red-800">
              {state.message}
            </p>
          )}
        </form>

        <p className="mt-4 text-[12px] text-ink/55">
          <Link
            href="/auth?mode=login"
            className="font-semibold text-cobalt hover:underline"
          >
            ← Retour à la connexion
          </Link>
        </p>
      </div>
    </section>
  );
}

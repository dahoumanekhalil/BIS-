"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { adminLogin, type LoginState } from "./actions";
import { cn } from "@/lib/utils";

const initial: LoginState = { status: "idle" };

export function LoginForm({
  redirectTo,
  initialError
}: {
  redirectTo?: string;
  initialError?: string;
}) {
  const [state, action] = useActionState(adminLogin, initial);
  const error =
    state.status === "error"
      ? state.message
      : initialError === "unauthorized"
        ? "Vous devez vous connecter."
        : null;

  return (
    <form action={action} className="space-y-5">
      {redirectTo && <input type="hidden" name="from" value={redirectTo} />}

      <Field
        label="Adresse email"
        name="email"
        type="email"
        autoComplete="username"
        required
        placeholder="admin@admin.com"
      />
      <Field
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        placeholder="••••••••"
      />

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-[12.5px] font-medium text-red-300"
        >
          {error}
        </div>
      )}

      <Submit />

      <p className="pt-3 text-center text-[10.5px] text-white/30">
        Accès réservé aux administrateurs autorisés du sommet BIS 2027.
      </p>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-lime px-5 py-3.5 text-[13px] font-bold uppercase tracking-[0.18em] text-ink transition-all",
        "hover:bg-lime/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      {pending ? (
        <>
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-ink/60 border-t-transparent"
          />
          Connexion…
        </>
      ) : (
        <>
          Se connecter
          <span aria-hidden>→</span>
        </>
      )}
    </button>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  required,
  placeholder
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-[10px] font-bold uppercase tracking-[0.22em] text-white/50"
      >
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        placeholder={placeholder}
        className={cn(
          "mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-[14px] text-white outline-none transition-all",
          "placeholder:text-white/25 focus:border-lime/50 focus:bg-white/[0.06] focus:ring-2 focus:ring-lime/20"
        )}
      />
    </div>
  );
}
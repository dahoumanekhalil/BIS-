"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  submitPasswordResetAction,
  type ResetState
} from "./actions";

const initial: ResetState = { status: "idle" };

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(
    submitPasswordResetAction,
    initial
  );

  if (state.status === "success") {
    return (
      <div className="mt-4 space-y-4">
        <p className="rounded-btn bg-lime/20 px-3 py-2 text-[12.5px] font-semibold text-ink">
          {state.message}
        </p>
        <Link
          href="/auth?mode=login"
          className="inline-flex rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime"
        >
          Aller à la connexion
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="mt-4 space-y-4">
      <input type="hidden" name="token" value={token} />
      <label className="block text-[12px] font-semibold text-ink/70">
        Nouveau mot de passe
        <input
          type="password"
          name="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
        />
      </label>
      {state.status === "error" && state.fieldErrors?.password && (
        <p className="text-[11.5px] font-semibold text-red-700">
          {state.fieldErrors.password}
        </p>
      )}
      <label className="block text-[12px] font-semibold text-ink/70">
        Confirmation
        <input
          type="password"
          name="confirm"
          required
          minLength={8}
          autoComplete="new-password"
          className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
        />
      </label>
      {state.status === "error" && state.fieldErrors?.confirm && (
        <p className="text-[11.5px] font-semibold text-red-700">
          {state.fieldErrors.confirm}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime disabled:opacity-60"
      >
        {pending ? "Mise à jour…" : "Mettre à jour le mot de passe"}
      </button>
      {state.status === "error" && !state.fieldErrors && (
        <p className="rounded-btn bg-red-100 px-3 py-2 text-[12.5px] font-semibold text-red-800">
          {state.message}
        </p>
      )}
    </form>
  );
}

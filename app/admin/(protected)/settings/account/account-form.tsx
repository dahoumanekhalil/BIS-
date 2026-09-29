"use client";

import { useState, useTransition } from "react";

import {
  changePasswordAction,
  updateProfileAction,
  type AccountActionState
} from "./actions";

const IDLE: AccountActionState = { status: "idle" };

export type AccountFormInitial = {
  name: string;
  email: string;
};

// Two independent forms:
//  1) Profile (name + email)   → updateProfileAction
//  2) Password change          → changePasswordAction
//
// Each form owns its own local `state` so a success on one doesn't wipe an
// error banner on the other. The browser never receives the passwordHash;
// the server-side action is the only place it is read/written.
export function AccountForm({ initial }: { initial: AccountFormInitial }) {
  return (
    <div className="grid gap-6">
      <ProfileForm initial={initial} />
      <PasswordForm />
    </div>
  );
}

function ProfileForm({ initial }: { initial: AccountFormInitial }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<AccountActionState>(IDLE);

  return (
    <form
      action={(fd) =>
        startTransition(async () => {
          const res = await updateProfileAction(IDLE, fd);
          setState(res);
        })
      }
      className="rounded-[16px] border border-line bg-white p-6"
    >
      <Legend title="Profil" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Nom"
          name="name"
          defaultValue={initial.name}
          required
          autoComplete="name"
          error={fieldError(state, "name")}
        />
        <Field
          label="Adresse email"
          name="email"
          type="email"
          defaultValue={initial.email}
          required
          autoComplete="email"
          error={fieldError(state, "email")}
        />
      </div>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Enregistrer le profil"}
        </button>
        <StatusPill state={state} />
      </div>
      <p className="mt-3 text-[11.5px] text-ink/55">
        Modifier le rôle ou le statut de votre compte n’est pas possible ici —
        contactez un autre administrateur disposant de la permission{" "}
        <code className="rounded bg-ink/10 px-1.5 py-0.5 font-mono text-[11px]">
          users.manage
        </code>
        .
      </p>
    </form>
  );
}

function PasswordForm() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<AccountActionState>(IDLE);
  const [formKey, setFormKey] = useState(0);

  return (
    <form
      key={formKey}
      action={(fd) =>
        startTransition(async () => {
          const res = await changePasswordAction(IDLE, fd);
          setState(res);
          if (res.status === "success") {
            // Reset the uncontrolled password fields on success so the
            // plaintext values don't linger in the DOM.
            setFormKey((k) => k + 1);
          }
        })
      }
      className="rounded-[16px] border border-line bg-white p-6"
    >
      <Legend title="Mot de passe" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Mot de passe actuel"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          error={fieldError(state, "currentPassword")}
        />
        <div className="hidden sm:block" />
        <Field
          label="Nouveau mot de passe"
          name="newPassword"
          type="password"
          required
          autoComplete="new-password"
          error={fieldError(state, "newPassword")}
        />
        <Field
          label="Confirmer le nouveau mot de passe"
          name="confirmPassword"
          type="password"
          required
          autoComplete="new-password"
          error={fieldError(state, "confirmPassword")}
        />
      </div>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Changer le mot de passe"}
        </button>
        <StatusPill state={state} />
      </div>
      <p className="mt-3 text-[11.5px] text-ink/55">
        Le mot de passe actuel est requis. Le nouveau mot de passe doit
        contenir au moins 6 caractères et être différent de l’ancien.
      </p>
    </form>
  );
}

function fieldError(state: AccountActionState, key: string): string | undefined {
  if (state.status !== "error") return undefined;
  return state.fieldErrors?.[key];
}

function Legend({ title }: { title: string }) {
  return (
    <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
      {title}
    </p>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  defaultValue,
  autoComplete,
  error
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  autoComplete?: string;
  error?: string;
}) {
  return (
    <label className="text-[12px] font-semibold text-ink/70">
      {label}
      <input
        type={type}
        name={name}
        required={required}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        className={
          "mt-1 w-full rounded-btn border bg-white px-3 py-2 text-[13px] text-ink " +
          (error ? "border-red-400" : "border-line")
        }
      />
      {error && (
        <span className="mt-1 block text-[11px] font-normal text-red-700">
          {error}
        </span>
      )}
    </label>
  );
}

function StatusPill({ state }: { state: AccountActionState }) {
  if (state.status === "idle") return null;
  const tone = state.status === "success" ? "success" : "error";
  return (
    <p
      className={
        tone === "success"
          ? "rounded-btn bg-lime/20 px-3 py-2 text-[12.5px] font-semibold text-ink"
          : "rounded-btn bg-red-100 px-3 py-2 text-[12.5px] font-semibold text-red-800"
      }
    >
      {state.message}
    </p>
  );
}

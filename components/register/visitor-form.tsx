"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import {
  completeVisitorRegistration,
  type VisitorRegisterState
} from "@/app/actions/register-visitor";

const initial: VisitorRegisterState = { status: "idle" };

export function VisitorRegistrationForm({
  initial: init
}: {
  initial: {
    phone: string;
    country: string;
    organization: string;
    jobTitle: string;
  };
}) {
  const [state, formAction] = useActionState(
    completeVisitorRegistration,
    initial
  );

  return (
    <form action={formAction} className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Téléphone"
          name="phone"
          type="tel"
          autoComplete="tel"
          defaultValue={init.phone}
          error={state.status === "error" ? state.fieldErrors?.phone : undefined}
          required
        />
        <Field
          label="Pays"
          name="country"
          autoComplete="country-name"
          defaultValue={init.country}
          error={state.status === "error" ? state.fieldErrors?.country : undefined}
          required
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Organisation"
          name="organization"
          autoComplete="organization"
          defaultValue={init.organization}
          error={state.status === "error" ? state.fieldErrors?.organization : undefined}
          hint="Optionnel"
        />
        <Field
          label="Fonction"
          name="jobTitle"
          autoComplete="organization-title"
          defaultValue={init.jobTitle}
          error={state.status === "error" ? state.fieldErrors?.jobTitle : undefined}
          hint="Optionnel"
        />
      </div>

      {state.status === "error" && state.message && (
        <div
          role="alert"
          className="rounded-btn border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
        >
          {state.message}
        </div>
      )}

      <SubmitButton />

      <p className="text-[12px] text-ink/55">
        En confirmant, vous acceptez les conditions générales du sommet BIS 2027
        et la politique de confidentialité.
      </p>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "inline-flex w-full items-center justify-center gap-2 rounded-btn bg-lime px-6 py-3.5 text-sm font-bold text-ink transition-all duration-200 sm:w-auto",
        "hover:bg-lime-600 disabled:cursor-not-allowed disabled:opacity-70"
      )}
    >
      {pending ? "Enregistrement…" : "Finaliser mon inscription"}
      <span aria-hidden>→</span>
    </button>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  defaultValue,
  error,
  hint,
  required
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  defaultValue?: string;
  error?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
        {label}
        {required && <span className="text-cobalt"> *</span>}
        {hint && !required && (
          <span className="ml-1 font-normal normal-case tracking-normal text-ink/40">
            · {hint}
          </span>
        )}
      </span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className={cn(
          "mt-1.5 w-full rounded-btn border bg-white px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition-colors",
          "border-line placeholder:text-ink/35",
          "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
          error && "border-red-400 focus:border-red-500 focus:ring-red-500/15"
        )}
      />
      {error && (
        <p id={`${name}-error`} className="mt-1 text-[11px] text-red-600">
          {error}
        </p>
      )}
    </label>
  );
}

"use client";

// Shared field primitives for every role-specific registration form
// (Speaker / Sponsor / Partner / Content Creator). Kept intentionally
// minimal — the design system already has richer primitives in
// components/forms/*, but those were built for the legacy multi-step
// wizard and pull in unrelated context. The role flows only need a
// stateless labelled input, textarea and submit button.
//
// New in Commit 2: extracted from components/register/speaker-form.tsx
// so the three new professional forms share the same visual + a11y
// behaviour as the speaker form.

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

export function Field({
  label,
  name,
  type = "text",
  autoComplete,
  defaultValue,
  error,
  hint,
  required,
  placeholder
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  defaultValue?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
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
        placeholder={placeholder}
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

export function TextArea({
  label,
  name,
  defaultValue,
  error,
  hint,
  required,
  rows = 4,
  minLength,
  maxLength,
  placeholder
}: {
  label: string;
  name: string;
  defaultValue?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  rows?: number;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
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
      <textarea
        name={name}
        rows={rows}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        defaultValue={defaultValue}
        placeholder={placeholder}
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

export function SubmitButton({
  idleLabel,
  pendingLabel
}: {
  idleLabel: string;
  pendingLabel: string;
}) {
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
      {pending ? pendingLabel : idleLabel}
      <span aria-hidden>→</span>
    </button>
  );
}

export function ContactFieldset({
  init,
  errors
}: {
  init: { phone: string; country: string };
  errors: Record<string, string>;
}) {
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Coordonnées</legend>
      <Field
        label="Téléphone"
        name="phone"
        type="tel"
        autoComplete="tel"
        defaultValue={init.phone}
        error={errors.phone}
        required
      />
      <Field
        label="Pays"
        name="country"
        autoComplete="country-name"
        defaultValue={init.country}
        error={errors.country}
        required
      />
    </fieldset>
  );
}

export function ErrorBanner({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-btn border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
    >
      {message}
    </div>
  );
}

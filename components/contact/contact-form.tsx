"use client";

import { useFormStatus } from "react-dom";
import { useActionState, useEffect, useState } from "react";
import { sendContactMessage, type ContactState } from "@/app/actions/contact";
import { CONTACT_REASONS } from "@/lib/validations";
import { cn } from "@/lib/utils";

const REASON_LABELS: Record<(typeof CONTACT_REASONS)[number], string> = {
  general: "Question générale",
  partnership: "Partenariat",
  sponsorship: "Sponsoring",
  media: "Presse & médias",
  speaker: "Proposition d'intervention",
  other: "Autre"
};

const initialState: ContactState = { status: "idle" };

export function ContactForm() {
  const [state, formAction] = useActionState(sendContactMessage, initialState);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (state.status === "success") {
      // Small delay so the fade-out finishes before the success card mounts.
      const t = setTimeout(() => setShowSuccess(true), 250);
      return () => clearTimeout(t);
    }
    if (showSuccess) {
      setShowSuccess(false);
    }
  }, [state.status, showSuccess]);

  const isSuccess = state.status === "success";
  const err =
    state.status === "error" ? state.fieldErrors ?? {} : ({} as Record<string, string>);

  return (
    <div id="form" className="relative">
      {/* Success card */}
      <div
        aria-live="polite"
        className={cn(
          "pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-[opacity,transform] duration-500 ease-out",
          showSuccess
            ? "translate-y-0 opacity-100 pointer-events-auto"
            : "translate-y-3 opacity-0"
        )}
      >
        <div className="w-full rounded-card border border-lime/40 bg-white p-8 text-center shadow-[0_20px_60px_-30px_rgba(15,25,60,0.2)]">
          <span
            aria-hidden
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-lime/20 ring-1 ring-inset ring-lime"
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 26 26"
              fill="none"
              aria-hidden
            >
              <path
                d="M6 13l4.5 4.5L20 8"
                stroke="#111827"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="animate-[contact-check_600ms_ease-out_forwards]"
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1}
              />
            </svg>
          </span>
          <p className="mt-5 font-display text-2xl font-black tracking-tight text-ink">
            Message envoyé.
          </p>
          <p className="mx-auto mt-3 max-w-md text-[14px] text-ink/65">
            {state.status === "success"
              ? state.message
              : "Merci pour votre message. Notre équipe reviendra vers vous prochainement."}
          </p>
        </div>
      </div>

      {/* Form */}
      <form
        action={formAction}
        noValidate
        className={cn(
          "space-y-4 transition-[opacity,transform,filter] duration-500 ease-out",
          isSuccess
            ? "-translate-y-2 opacity-0 blur-[2px] pointer-events-none"
            : "translate-y-0 opacity-100 blur-0"
        )}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="name"
            label="Nom"
            autoComplete="name"
            required
            error={err.name}
          />
          <Field
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            required
            error={err.email}
          />
        </div>

        <Field
          name="organization"
          label="Organisation"
          autoComplete="organization"
          hint="Facultatif"
          error={err.organization}
        />

        <div>
          <label
            htmlFor="reason"
            className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55"
          >
            Motif de contact
          </label>
          <div className="relative mt-1.5">
            <select
              id="reason"
              name="reason"
              defaultValue="general"
              className={cn(
                "peer w-full appearance-none rounded-btn border border-line bg-white px-3.5 py-3 pr-10 text-[14px] text-ink outline-none transition-colors",
                "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15"
              )}
            >
              {CONTACT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABELS[r]}
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-ink/45 peer-focus:text-cobalt"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden
            >
              <path
                d="M2 4l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          {err.reason && (
            <p className="mt-1 text-[11px] text-red-600">{err.reason}</p>
          )}
        </div>

        <Field
          name="subject"
          label="Sujet"
          required
          error={err.subject}
        />

        <TextareaField
          name="message"
          label="Message"
          required
          error={err.message}
        />

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-btn border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
          >
            {state.message}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <p className="text-[11.5px] text-ink/50">
            Vos données sont utilisées uniquement pour vous répondre.
          </p>
          <SubmitButton />
        </div>
      </form>
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "group/submit inline-flex items-center justify-center gap-2 rounded-btn bg-lime px-6 py-3 text-[13.5px] font-bold text-ink transition-all duration-200",
        "hover:-translate-y-0.5 hover:bg-lime-600 hover:shadow-[0_18px_36px_-18px_rgba(184,230,46,0.6)]",
        "disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
      )}
    >
      {pending ? (
        <>
          <span
            aria-hidden
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/60 border-t-transparent"
          />
          Envoi en cours…
        </>
      ) : (
        <>
          Envoyer le message
          <span
            aria-hidden
            className="inline-block transition-transform duration-200 group-hover/submit:translate-x-1"
          >
            →
          </span>
        </>
      )}
    </button>
  );
}

function Field({
  name,
  label,
  type = "text",
  autoComplete,
  required,
  error,
  hint
}: {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="flex items-center justify-between text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55"
      >
        <span>
          {label}
          {required && <span className="text-cobalt"> *</span>}
        </span>
        {hint && (
          <span className="font-medium normal-case tracking-normal text-ink/40">
            {hint}
          </span>
        )}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error ? true : undefined}
        className={cn(
          "mt-1.5 h-12 w-full rounded-btn border bg-white px-3.5 text-[14px] text-ink outline-none transition-colors",
          "border-line placeholder:text-ink/35",
          "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
          error && "border-red-400 focus:border-red-500 focus:ring-red-500/15"
        )}
      />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

function TextareaField({
  name,
  label,
  required,
  error
}: {
  name: string;
  label: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55"
      >
        {label}
        {required && <span className="text-cobalt"> *</span>}
      </label>
      <textarea
        id={name}
        name={name}
        required={required}
        rows={7}
        aria-invalid={error ? true : undefined}
        className={cn(
          "mt-1.5 w-full resize-y rounded-btn border bg-white px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none transition-colors",
          "border-line placeholder:text-ink/35",
          "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
          error && "border-red-400 focus:border-red-500 focus:ring-red-500/15"
        )}
      />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

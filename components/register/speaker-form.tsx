"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import {
  submitSpeakerApplication,
  type SpeakerRegisterState
} from "@/app/actions/register-speaker";

const initial: SpeakerRegisterState = { status: "idle" };

type Init = {
  phone: string;
  country: string;
  organization: string;
};

export function SpeakerApplicationForm({
  initial: init,
  needsPhone
}: {
  initial: Init;
  needsPhone: boolean;
}) {
  const [state, formAction] = useActionState(
    submitSpeakerApplication,
    initial
  );

  const err = state.status === "error" ? state.fieldErrors ?? {} : {};

  return (
    <form action={formAction} className="grid gap-6">
      {needsPhone && (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">Coordonnées</legend>
          <Field
            label="Téléphone"
            name="phone"
            type="tel"
            autoComplete="tel"
            defaultValue={init.phone}
            error={err.phone}
            required
          />
          <Field
            label="Pays"
            name="country"
            autoComplete="country-name"
            defaultValue={init.country}
            error={err.country}
            required
          />
        </fieldset>
      )}

      <fieldset className="grid gap-4">
        <legend className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
          Votre profil
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Organisation"
            name="organization"
            autoComplete="organization"
            defaultValue={init.organization}
            error={err.organization}
            hint="Optionnel"
          />
          <Field
            label="Titre professionnel"
            name="professionalTitle"
            error={err.professionalTitle}
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="LinkedIn"
            name="linkedin"
            type="url"
            error={err.linkedin}
            hint="https://…"
          />
          <Field
            label="Site web"
            name="website"
            type="url"
            error={err.website}
            hint="https://…"
          />
        </div>
        <Field
          label="Photo (URL)"
          name="photoUrl"
          type="url"
          error={err.photoUrl}
          hint="Lien vers une photo professionnelle"
        />
        <TextArea
          label="Bio"
          name="bio"
          error={err.bio}
          rows={4}
          minLength={20}
          maxLength={2000}
          required
        />
        <Field
          label="Expertise clé"
          name="expertise"
          error={err.expertise}
          hint="Optionnel — vos domaines d'expertise"
        />
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
          Votre intervention
        </legend>
        <Field
          label="Sujet proposé"
          name="proposedTopic"
          error={err.proposedTopic}
          required
        />
        <TextArea
          label="Proposition détaillée"
          name="proposal"
          error={err.proposal}
          rows={6}
          minLength={20}
          maxLength={3000}
          required
        />
        <TextArea
          label="Message au comité"
          name="message"
          error={err.message}
          rows={3}
          maxLength={4000}
          hint="Optionnel"
        />
      </fieldset>

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
        En soumettant, vous acceptez que le comité éditorial BIS étudie votre
        proposition. Aucune sélection n&apos;est automatique.
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
      {pending ? "Envoi de la candidature…" : "Envoyer ma candidature"}
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

function TextArea({
  label,
  name,
  error,
  hint,
  required,
  rows = 4,
  minLength,
  maxLength
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  required?: boolean;
  rows?: number;
  minLength?: number;
  maxLength?: number;
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

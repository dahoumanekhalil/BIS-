"use client";

import { useActionState } from "react";
import {
  submitContentCreatorApplication,
  type ContentCreatorRegisterState
} from "@/app/actions/register-content-creator";
import {
  ContactFieldset,
  ErrorBanner,
  Field,
  SubmitButton,
  TextArea
} from "@/components/register/form-primitives";

const initial: ContentCreatorRegisterState = { status: "idle" };

type Init = {
  phone: string;
  country: string;
  organization: string;
  website: string;
};

export function ContentCreatorApplicationForm({
  initial: init,
  needsPhone
}: {
  initial: Init;
  needsPhone: boolean;
}) {
  const [state, formAction] = useActionState(
    submitContentCreatorApplication,
    initial
  );
  const err = state.status === "error" ? state.fieldErrors ?? {} : {};

  return (
    <form action={formAction} className="grid gap-6">
      {needsPhone && (
        <ContactFieldset
          init={{ phone: init.phone, country: init.country }}
          errors={err}
        />
      )}

      <fieldset className="grid gap-4">
        <legend className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
          Votre univers
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Plateforme principale"
            name="platform"
            error={err.platform}
            required
            hint="Instagram, TikTok, YouTube, LinkedIn, podcast…"
          />
          <Field
            label="Taille d'audience"
            name="audienceSize"
            error={err.audienceSize}
            hint="Optionnel — approximative"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Type de contenu"
            name="contentType"
            error={err.contentType}
            hint="Vidéo courte, long format, reportage, podcast… (optionnel)"
          />
          <Field
            label="Marque / pseudo créateur"
            name="organization"
            defaultValue={init.organization}
            error={err.organization}
            hint="Optionnel"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Site / lien principal"
            name="website"
            type="url"
            defaultValue={init.website}
            error={err.website}
            hint="https://…"
          />
          <Field
            label="LinkedIn / autre profil"
            name="linkedin"
            type="url"
            error={err.linkedin}
            hint="https://…"
          />
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
          Votre proposition
        </legend>
        <TextArea
          label="Proposition"
          name="proposal"
          error={err.proposal}
          rows={6}
          minLength={20}
          maxLength={3000}
          required
          placeholder="Comment souhaitez-vous couvrir ou amplifier BIS 2027 ?"
        />
        <TextArea
          label="Message à l'équipe éditoriale"
          name="message"
          error={err.message}
          rows={3}
          maxLength={4000}
          hint="Optionnel"
        />
      </fieldset>

      <ErrorBanner message={state.status === "error" ? state.message : undefined} />

      <SubmitButton
        idleLabel="Envoyer ma candidature"
        pendingLabel="Envoi de la candidature…"
      />

      <p className="text-[12px] text-ink/55">
        En soumettant, vous acceptez d&apos;être contacté(e) par l&apos;équipe
        éditoriale BIS. Aucune accréditation n&apos;est automatique.
      </p>
    </form>
  );
}

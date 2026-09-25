"use client";

import { useActionState } from "react";
import {
  submitSponsorApplication,
  type SponsorRegisterState
} from "@/app/actions/register-sponsor";
import {
  ContactFieldset,
  ErrorBanner,
  Field,
  SubmitButton,
  TextArea
} from "@/components/register/form-primitives";

const initial: SponsorRegisterState = { status: "idle" };

type Init = {
  phone: string;
  country: string;
  organization: string;
  industry: string;
  website: string;
  position: string;
};

export function SponsorApplicationForm({
  initial: init,
  needsPhone
}: {
  initial: Init;
  needsPhone: boolean;
}) {
  const [state, formAction] = useActionState(submitSponsorApplication, initial);
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
          Votre organisation
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Organisation"
            name="organization"
            autoComplete="organization"
            defaultValue={init.organization}
            error={err.organization}
            required
          />
          <Field
            label="Secteur d'activité"
            name="industry"
            defaultValue={init.industry}
            error={err.industry}
            hint="Optionnel"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Site web"
            name="website"
            type="url"
            defaultValue={init.website}
            error={err.website}
            hint="https://…"
          />
          <Field
            label="Votre fonction"
            name="position"
            defaultValue={init.position}
            error={err.position}
            hint="Optionnel"
          />
        </div>
        <Field
          label="Logo (URL)"
          name="logoUrl"
          type="url"
          error={err.logoUrl}
          hint="Lien vers un logo hébergé — optionnel"
        />
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
          Vos intentions sponsor
        </legend>
        <Field
          label="Type d'intérêt"
          name="interest"
          error={err.interest}
          hint="Presenting, Platinum, Gold, Média, Écosystème… (optionnel)"
        />
        <TextArea
          label="Domaines d'intérêt"
          name="focusAreas"
          error={err.focusAreas}
          rows={4}
          maxLength={600}
          hint="Optionnel — Innovation, technologie, entrepreneuriat, impact…"
        />
        <TextArea
          label="Message à l'équipe partenariats"
          name="message"
          error={err.message}
          rows={4}
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
        partenariats BIS. Aucune sélection n&apos;est automatique.
      </p>
    </form>
  );
}

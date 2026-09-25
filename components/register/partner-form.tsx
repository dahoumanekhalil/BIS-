"use client";

import { useActionState } from "react";
import {
  submitPartnerApplication,
  type PartnerRegisterState
} from "@/app/actions/register-partner";
import {
  ContactFieldset,
  ErrorBanner,
  Field,
  SubmitButton,
  TextArea
} from "@/components/register/form-primitives";

const initial: PartnerRegisterState = { status: "idle" };

type Init = {
  phone: string;
  country: string;
  organization: string;
  industry: string;
  website: string;
  position: string;
};

export function PartnerApplicationForm({
  initial: init,
  needsPhone
}: {
  initial: Init;
  needsPhone: boolean;
}) {
  const [state, formAction] = useActionState(submitPartnerApplication, initial);
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
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/55">
          Votre proposition
        </legend>
        <Field
          label="Type de partenariat"
          name="partnershipType"
          error={err.partnershipType}
          hint="Institutionnel, académique, écosystème, média… (optionnel)"
        />
        <TextArea
          label="Proposition"
          name="proposal"
          error={err.proposal}
          rows={5}
          maxLength={2000}
          placeholder="Comment souhaitez-vous collaborer avec BIS 2027 ?"
          hint="Optionnel"
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

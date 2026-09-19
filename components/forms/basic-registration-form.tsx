"use client";

import { useActionState, useState } from "react";
import {
  startRegistration,
  type StartRegistrationState
} from "@/app/actions/onboarding";
import {
  FormField,
  FormSection,
  TextInput,
  Select,
  Checkbox,
  SubmitButton
} from "./primitives";
import { FormErrorBanner } from "./submission-state";

const initialState: StartRegistrationState = { status: "idle" };

const PROFILE_OPTIONS = [
  { value: "ATTENDEE", label: "Participant" },
  { value: "STARTUP", label: "Startup" },
  { value: "INVESTOR", label: "Investisseur" },
  { value: "MEDIA", label: "Média" },
  { value: "PARTNER", label: "Partenaire" }
];

const SIZE_OPTIONS = [
  { value: "", label: "—" },
  { value: "1-10", label: "1 – 10 collaborateurs" },
  { value: "11-50", label: "11 – 50 collaborateurs" },
  { value: "51-200", label: "51 – 200 collaborateurs" },
  { value: "201-500", label: "201 – 500 collaborateurs" },
  { value: "500+", label: "500+" }
];

/**
 * Step 1 of the unified /register journey. Preserves the preselected
 * participation (if any) into a hidden field so the server action can
 * redirect straight to Step 3 after creating the Participant.
 */
export function BasicRegistrationForm({
  participation
}: {
  participation: string | null;
}) {
  const [state, formAction] = useActionState(startRegistration, initialState);
  const [showCompany, setShowCompany] = useState(false);

  const errs = state.status === "error" ? state.fieldErrors ?? {} : {};

  return (
    <form action={formAction} className="space-y-10">
      {participation && (
        <input type="hidden" name="participation" value={participation} />
      )}

      <FormSection
        eyebrow="Vos informations"
        title="Qui participe ?"
        description="Ces informations préparent votre accès au sommet."
      >
        <FormField name="firstName" label="Prénom" required error={errs.firstName}>
          <TextInput
            id="firstName"
            name="firstName"
            required
            autoComplete="given-name"
            invalid={!!errs.firstName}
          />
        </FormField>
        <FormField name="lastName" label="Nom" required error={errs.lastName}>
          <TextInput
            id="lastName"
            name="lastName"
            required
            autoComplete="family-name"
            invalid={!!errs.lastName}
          />
        </FormField>
        <FormField name="email" label="Email professionnel" required error={errs.email}>
          <TextInput
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            invalid={!!errs.email}
          />
        </FormField>
        <FormField name="phone" label="Téléphone" required error={errs.phone}>
          <TextInput
            id="phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            invalid={!!errs.phone}
          />
        </FormField>
        <FormField name="jobTitle" label="Fonction" error={errs.jobTitle}>
          <TextInput
            id="jobTitle"
            name="jobTitle"
            autoComplete="organization-title"
            invalid={!!errs.jobTitle}
          />
        </FormField>
        <FormField name="country" label="Pays">
          <TextInput
            id="country"
            name="country"
            defaultValue="Algérie"
            autoComplete="country-name"
          />
        </FormField>
        <FormField
          name="registrationType"
          label="Profil"
          className="md:col-span-2"
          hint="Comment vous décririez-vous parmi ces profils ?"
        >
          <Select
            id="registrationType"
            name="registrationType"
            defaultValue="ATTENDEE"
            options={PROFILE_OPTIONS}
          />
        </FormField>
      </FormSection>

      <div className="rounded-2xl border border-black/[0.06] bg-white p-5 sm:p-6">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={showCompany}
            onChange={(e) => setShowCompany(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-black/20 accent-cobalt"
          />
          <span>
            <span className="block font-display text-[15px] font-semibold text-ink">
              Je m'inscris au nom d'une organisation
            </span>
            <span className="mt-0.5 block text-[12.5px] text-ink/60">
              Complétez les informations de votre société ou institution.
            </span>
          </span>
        </label>

        <div
          className={
            showCompany
              ? "mt-6 grid gap-6 md:grid-cols-2"
              : "hidden"
          }
        >
          <FormField
            name="organization"
            label="Nom de la société"
            error={errs.organization}
          >
            <TextInput
              id="organization"
              name="organization"
              autoComplete="organization"
              invalid={!!errs.organization}
            />
          </FormField>
          <FormField
            name="companyIndustry"
            label="Secteur d'activité"
            error={errs.companyIndustry}
          >
            <TextInput
              id="companyIndustry"
              name="companyIndustry"
              invalid={!!errs.companyIndustry}
            />
          </FormField>
          <FormField
            name="companyWebsite"
            label="Site web"
            hint="https://…"
            error={errs.companyWebsite}
          >
            <TextInput
              id="companyWebsite"
              name="companyWebsite"
              type="url"
              inputMode="url"
              placeholder="https://"
              invalid={!!errs.companyWebsite}
            />
          </FormField>
          <FormField name="companySize" label="Taille" error={errs.companySize}>
            <Select
              id="companySize"
              name="companySize"
              defaultValue=""
              options={SIZE_OPTIONS}
            />
          </FormField>
        </div>
      </div>

      <div className="space-y-4 border-t border-black/[0.08] pt-6">
        <Checkbox
          name="consent"
          label={
            <span>
              J'accepte que mes données soient utilisées dans le cadre de mon
              inscription au BIS 2026.
            </span>
          }
          error={errs.consent}
        />

        {state.status === "error" && (
          <FormErrorBanner message={state.message} />
        )}

        <SubmitButton pendingLabel="Inscription en cours…">
          Continuer
        </SubmitButton>
      </div>
    </form>
  );
}

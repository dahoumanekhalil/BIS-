"use client";

import { useActionState, useMemo, useState } from "react";
import type { Participant } from "@prisma/client";
import { ApplicationType } from "@prisma/client";
import {
  submitParticipation,
  type ApplicationSubmitState
} from "@/app/actions/onboarding";
import {
  FormField,
  FormSection,
  TextInput,
  TextArea,
  Checkbox,
  SubmitButton,
  FileUpload
} from "@/components/forms/primitives";
import { FormErrorBanner } from "@/components/forms/submission-state";
import { APPLICATION_TYPE_LABEL } from "@/lib/applications";

const initialState: ApplicationSubmitState = { status: "idle" };

type ApplicationTypeKey = keyof typeof APPLICATION_TYPE_LABEL;

/**
 * Role-specific Step 3 form with inline review.
 *
 * Flow:
 *   phase="edit"    → user fills the role-specific fields
 *   phase="review"  → user sees a read-only summary; can go back or confirm
 *   → server action `submitParticipation` on final confirm
 */
export function RoleDetailsForm({
  type,
  participant
}: {
  type: ApplicationType;
  participant: Participant;
}) {
  const [phase, setPhase] = useState<"edit" | "review">("edit");
  const [values, setValues] = useState<Record<string, string>>({});

  const [state, formAction] = useActionState(
    submitParticipation.bind(null, type),
    initialState
  );

  const errs = state.status === "error" ? state.fieldErrors ?? {} : {};
  const typeKey = type as unknown as ApplicationTypeKey;

  function readForm(form: HTMLFormElement) {
    const fd = new FormData(form);
    const out: Record<string, string> = {};
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function onPreview(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setValues(readForm(e.currentTarget));
    setPhase("review");
  }

  if (phase === "review") {
    return (
      <ReviewPanel
        typeKey={typeKey}
        participant={participant}
        values={values}
        errorState={state.status === "error" ? state.message : null}
        onEdit={() => setPhase("edit")}
        formAction={formAction}
      />
    );
  }

  const needsContact = !participant.phone;

  return (
    <form onSubmit={onPreview} className="space-y-10">
      {/* Read-only reminder of who is applying — no re-entry needed. */}
      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 text-[12.5px] text-ink/70">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span>
            En tant que{" "}
            <strong className="text-ink">
              {participant.firstName} {participant.lastName}
            </strong>{" "}
            · {participant.email}
          </span>
          <a
            href="/register/participation"
            className="text-[11.5px] font-semibold uppercase tracking-[0.18em] text-cobalt hover:underline"
          >
            Changer
          </a>
        </div>
      </div>

      {needsContact && (
        <FormSection
          eyebrow="Contact"
          title="Finalisez votre profil"
          description="Ces informations sont nécessaires pour votre inscription et pour vous joindre."
        >
          <FormField
            name="contactPhone"
            label="Téléphone"
            required
            error={errs["contact.phone"]}
          >
            <TextInput
              id="contactPhone"
              name="contactPhone"
              type="tel"
              required
              autoComplete="tel"
              defaultValue={values.contactPhone ?? ""}
              invalid={!!errs["contact.phone"]}
            />
          </FormField>
          <FormField
            name="contactCountry"
            label="Pays"
            error={errs["contact.country"]}
          >
            <TextInput
              id="contactCountry"
              name="contactCountry"
              autoComplete="country-name"
              defaultValue={values.contactCountry ?? participant.country ?? "Algérie"}
              invalid={!!errs["contact.country"]}
            />
          </FormField>
        </FormSection>
      )}

      {(type === "SPONSOR" || type === "PARTNER") && (
        <>
          <FormSection
            eyebrow="Étape 1"
            title="Votre organisation"
            description="Informations de la société ou institution que vous représentez."
          >
            <FormField
              name="organization"
              label="Organisation"
              required
              error={errs.organization}
            >
              <TextInput
                id="organization"
                name="organization"
                required
                defaultValue={values.organization ?? participant.organization ?? ""}
                autoComplete="organization"
                invalid={!!errs.organization}
              />
            </FormField>
            <FormField name="industry" label="Secteur d'activité" error={errs.industry}>
              <TextInput
                id="industry"
                name="industry"
                defaultValue={values.industry ?? participant.companyIndustry ?? ""}
                invalid={!!errs.industry}
              />
            </FormField>
            <FormField
              name="website"
              label="Site web"
              hint="https://…"
              error={errs.website}
            >
              <TextInput
                id="website"
                name="website"
                type="url"
                inputMode="url"
                placeholder="https://"
                defaultValue={values.website ?? participant.companyWebsite ?? ""}
                invalid={!!errs.website}
              />
            </FormField>
            <FormField name="position" label="Votre fonction" error={errs.position}>
              <TextInput
                id="position"
                name="position"
                defaultValue={values.position ?? participant.jobTitle ?? ""}
                invalid={!!errs.position}
              />
            </FormField>
            {type === "SPONSOR" && (
              <FileUpload
                name="logoUrl"
                label="Logo de la marque"
                defaultValue={values.logoUrl ?? ""}
                error={errs.logoUrl}
                hint="Lien vers un logo hébergé (facultatif)."
              />
            )}
          </FormSection>

          {type === "SPONSOR" && (
            <FormSection
              eyebrow="Étape 2"
              title="Vos intentions"
              description="Quel type de partenariat sponsor recherchez-vous ?"
            >
              <FormField
                name="interest"
                label="Type d'intérêt"
                hint="Presenting, Platinum, Gold, Média, Écosystème…"
                error={errs.interest}
              >
                <TextInput
                  id="interest"
                  name="interest"
                  defaultValue={values.interest ?? ""}
                  invalid={!!errs.interest}
                />
              </FormField>
              <FormField
                name="focusAreas"
                label="Domaines d'intérêt"
                error={errs.focusAreas}
                className="md:col-span-2"
              >
                <TextArea
                  id="focusAreas"
                  name="focusAreas"
                  rows={3}
                  defaultValue={values.focusAreas ?? ""}
                  placeholder="Innovation, technologie, entrepreneuriat, impact…"
                  invalid={!!errs.focusAreas}
                />
              </FormField>
            </FormSection>
          )}

          {type === "PARTNER" && (
            <FormSection
              eyebrow="Étape 2"
              title="Votre proposition"
              description="Décrivez la nature de la collaboration envisagée."
            >
              <FormField
                name="partnershipType"
                label="Type de partenariat"
                hint="Institutionnel, académique, écosystème, média…"
                error={errs.partnershipType}
              >
                <TextInput
                  id="partnershipType"
                  name="partnershipType"
                  defaultValue={values.partnershipType ?? ""}
                  invalid={!!errs.partnershipType}
                />
              </FormField>
              <FormField
                name="proposal"
                label="Proposition"
                error={errs.proposal}
                className="md:col-span-2"
              >
                <TextArea
                  id="proposal"
                  name="proposal"
                  rows={5}
                  defaultValue={values.proposal ?? ""}
                  placeholder="Comment souhaitez-vous collaborer avec BIS 2026 ?"
                  invalid={!!errs.proposal}
                />
              </FormField>
            </FormSection>
          )}
        </>
      )}

      {type === "SPEAKER" && (
        <>
          <FormSection
            eyebrow="Étape 1"
            title="Votre présence professionnelle"
            description="Aidez-nous à mieux vous connaître."
          >
            <FormField
              name="professionalTitle"
              label="Titre professionnel"
              required
              error={errs.professionalTitle}
            >
              <TextInput
                id="professionalTitle"
                name="professionalTitle"
                required
                defaultValue={values.professionalTitle ?? participant.jobTitle ?? ""}
                invalid={!!errs.professionalTitle}
              />
            </FormField>
            <FormField
              name="organization"
              label="Organisation"
              error={errs.organization}
            >
              <TextInput
                id="organization"
                name="organization"
                defaultValue={values.organization ?? participant.organization ?? ""}
                invalid={!!errs.organization}
              />
            </FormField>
            <FormField
              name="website"
              label="Site web"
              hint="https://…"
              error={errs.website}
            >
              <TextInput
                id="website"
                name="website"
                type="url"
                inputMode="url"
                placeholder="https://"
                defaultValue={values.website ?? ""}
                invalid={!!errs.website}
              />
            </FormField>
            <FormField
              name="linkedin"
              label="LinkedIn"
              hint="https://linkedin.com/in/…"
              error={errs.linkedin}
            >
              <TextInput
                id="linkedin"
                name="linkedin"
                type="url"
                inputMode="url"
                placeholder="https://"
                defaultValue={values.linkedin ?? ""}
                invalid={!!errs.linkedin}
              />
            </FormField>
            <FileUpload
              name="photoUrl"
              label="Portrait"
              defaultValue={values.photoUrl ?? ""}
              error={errs.photoUrl}
              hint="Lien vers votre portrait (facultatif)."
            />
            <FormField
              name="expertise"
              label="Domaines d'expertise"
              error={errs.expertise}
            >
              <TextInput
                id="expertise"
                name="expertise"
                placeholder="Innovation, marque, tech, culture…"
                defaultValue={values.expertise ?? ""}
                invalid={!!errs.expertise}
              />
            </FormField>
          </FormSection>

          <FormSection
            eyebrow="Étape 2"
            title="Votre intervention"
            description="Le comité éditorial étudiera votre proposition. Elle ne vaut pas confirmation."
          >
            <FormField
              name="proposedTopic"
              label="Sujet proposé"
              required
              error={errs.proposedTopic}
              className="md:col-span-2"
            >
              <TextInput
                id="proposedTopic"
                name="proposedTopic"
                required
                defaultValue={values.proposedTopic ?? ""}
                invalid={!!errs.proposedTopic}
              />
            </FormField>
            <FormField
              name="bio"
              label="Bio courte"
              required
              error={errs.bio}
              hint="2 à 3 phrases décrivant votre parcours."
              className="md:col-span-2"
            >
              <TextArea
                id="bio"
                name="bio"
                rows={4}
                required
                defaultValue={values.bio ?? ""}
                invalid={!!errs.bio}
              />
            </FormField>
            <FormField
              name="proposal"
              label="Proposition détaillée"
              required
              error={errs.proposal}
              className="md:col-span-2"
            >
              <TextArea
                id="proposal"
                name="proposal"
                rows={6}
                required
                defaultValue={values.proposal ?? ""}
                placeholder="Angle, format (keynote / panel / masterclass), messages clés…"
                invalid={!!errs.proposal}
              />
            </FormField>
          </FormSection>
        </>
      )}

      {type === "CONTENT_CREATOR" && (
        <>
          <FormSection
            eyebrow="Étape 1"
            title="Votre univers"
            description="Comprendre votre plateforme et votre audience."
          >
            <FormField
              name="platform"
              label="Plateforme principale"
              required
              hint="Instagram, TikTok, YouTube, LinkedIn, podcast…"
              error={errs.platform}
            >
              <TextInput
                id="platform"
                name="platform"
                required
                defaultValue={values.platform ?? ""}
                invalid={!!errs.platform}
              />
            </FormField>
            <FormField
              name="audienceSize"
              label="Taille d'audience"
              hint="Approximative"
              error={errs.audienceSize}
            >
              <TextInput
                id="audienceSize"
                name="audienceSize"
                defaultValue={values.audienceSize ?? ""}
                invalid={!!errs.audienceSize}
              />
            </FormField>
            <FormField
              name="contentType"
              label="Type de contenu"
              error={errs.contentType}
            >
              <TextInput
                id="contentType"
                name="contentType"
                placeholder="Vidéo courte, long format, reportage, podcast…"
                defaultValue={values.contentType ?? ""}
                invalid={!!errs.contentType}
              />
            </FormField>
            <FormField
              name="organization"
              label="Marque / pseudo créateur"
              error={errs.organization}
            >
              <TextInput
                id="organization"
                name="organization"
                defaultValue={values.organization ?? participant.organization ?? ""}
                invalid={!!errs.organization}
              />
            </FormField>
            <FormField
              name="website"
              label="Site / lien principal"
              hint="https://…"
              error={errs.website}
            >
              <TextInput
                id="website"
                name="website"
                type="url"
                inputMode="url"
                placeholder="https://"
                defaultValue={values.website ?? ""}
                invalid={!!errs.website}
              />
            </FormField>
            <FormField
              name="linkedin"
              label="LinkedIn / autre profil"
              hint="https://…"
              error={errs.linkedin}
            >
              <TextInput
                id="linkedin"
                name="linkedin"
                type="url"
                inputMode="url"
                placeholder="https://"
                defaultValue={values.linkedin ?? ""}
                invalid={!!errs.linkedin}
              />
            </FormField>
          </FormSection>

          <FormSection
            eyebrow="Étape 2"
            title="Votre proposition"
            description="Ce que vous imaginez produire autour de BIS."
          >
            <FormField
              name="proposal"
              label="Proposition"
              required
              error={errs.proposal}
              className="md:col-span-2"
            >
              <TextArea
                id="proposal"
                name="proposal"
                rows={6}
                required
                defaultValue={values.proposal ?? ""}
                placeholder="Comment souhaitez-vous couvrir ou amplifier BIS 2026 ?"
                invalid={!!errs.proposal}
              />
            </FormField>
          </FormSection>
        </>
      )}

      <FormSection
        eyebrow="Étape 3"
        title="Message"
        description="Un mot pour compléter votre candidature — facultatif."
      >
        <FormField name="message" label="Message" error={errs.message} className="md:col-span-2">
          <TextArea
            id="message"
            name="message"
            rows={4}
            defaultValue={values.message ?? ""}
            placeholder="Un élément supplémentaire à porter à notre attention…"
            invalid={!!errs.message}
          />
        </FormField>
      </FormSection>

      <div className="space-y-4 border-t border-black/[0.08] pt-6">
        {state.status === "error" && (
          <FormErrorBanner message={state.message} />
        )}

        <button
          type="submit"
          className="inline-flex items-center justify-center gap-2 rounded-btn bg-ink px-6 py-3.5 text-sm font-semibold text-white transition-all duration-200 hover:bg-navy"
        >
          Prévisualiser ma candidature <span aria-hidden>→</span>
        </button>
      </div>
    </form>
  );
}

/* ------------------------------ REVIEW ------------------------------ */

function ReviewPanel({
  typeKey,
  participant,
  values,
  errorState,
  onEdit,
  formAction
}: {
  typeKey: ApplicationTypeKey;
  participant: Participant;
  values: Record<string, string>;
  errorState: string | null;
  onEdit: () => void;
  formAction: (formData: FormData) => void;
}) {
  const rows = useMemo(() => buildReview(typeKey, participant, values), [
    typeKey,
    participant,
    values
  ]);

  return (
    <div className="space-y-8">
      <div className="rounded-2xl border border-cobalt/20 bg-cobalt/5 p-5">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-cobalt">
          Revue
        </p>
        <p className="mt-2 text-[14.5px] text-ink">
          Vérifiez les informations ci-dessous. En confirmant, votre
          candidature{" "}
          <strong>{APPLICATION_TYPE_LABEL[typeKey].toLowerCase()}</strong> sera
          envoyée à notre équipe.
        </p>
      </div>

      <dl className="rounded-2xl border border-black/[0.06] bg-white">
        {rows.map((row, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(120px,180px)_1fr] gap-4 border-b border-line/70 px-5 py-3 text-sm last:border-b-0"
          >
            <dt className="text-[11px] font-bold uppercase tracking-[0.18em] text-ink/50">
              {row.label}
            </dt>
            <dd className="whitespace-pre-wrap break-words text-ink">
              {row.value || <span className="text-ink/40">—</span>}
            </dd>
          </div>
        ))}
      </dl>

      <form action={formAction} className="space-y-4">
        {/* Re-submit all fields (they were captured in the edit phase). */}
        {Object.entries(values).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <Checkbox
          name="consent"
          label={
            <span>
              Je confirme l'exactitude des informations ci-dessus et j'accepte
              qu'elles soient utilisées pour l'étude de ma candidature.
            </span>
          }
        />

        {errorState && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {errorState}
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center justify-center gap-2 rounded-btn border border-line bg-white px-5 py-2.5 text-[13px] font-semibold text-ink hover:border-ink/30"
          >
            <span aria-hidden>←</span> Modifier
          </button>
          <SubmitButton pendingLabel="Envoi de la candidature…">
            Confirmer et envoyer
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}

function buildReview(
  typeKey: ApplicationTypeKey,
  participant: Participant,
  v: Record<string, string>
): { label: string; value: string }[] {
  const phoneLine = participant.phone ?? v.contactPhone ?? "—";
  const contact = [
    {
      label: "Contact",
      value: `${participant.firstName} ${participant.lastName}\n${participant.email}\n${phoneLine}`
    }
  ];

  switch (typeKey) {
    case "SPONSOR":
      return [
        ...contact,
        { label: "Organisation", value: v.organization ?? "" },
        { label: "Secteur", value: v.industry ?? "" },
        { label: "Site", value: v.website ?? "" },
        { label: "Logo (URL)", value: v.logoUrl ?? "" },
        { label: "Fonction", value: v.position ?? "" },
        { label: "Type d'intérêt", value: v.interest ?? "" },
        { label: "Domaines", value: v.focusAreas ?? "" },
        { label: "Message", value: v.message ?? "" }
      ];
    case "PARTNER":
      return [
        ...contact,
        { label: "Organisation", value: v.organization ?? "" },
        { label: "Secteur", value: v.industry ?? "" },
        { label: "Site", value: v.website ?? "" },
        { label: "Fonction", value: v.position ?? "" },
        { label: "Type de partenariat", value: v.partnershipType ?? "" },
        { label: "Proposition", value: v.proposal ?? "" },
        { label: "Message", value: v.message ?? "" }
      ];
    case "SPEAKER":
      return [
        ...contact,
        { label: "Titre professionnel", value: v.professionalTitle ?? "" },
        { label: "Organisation", value: v.organization ?? "" },
        { label: "Site", value: v.website ?? "" },
        { label: "LinkedIn", value: v.linkedin ?? "" },
        { label: "Portrait (URL)", value: v.photoUrl ?? "" },
        { label: "Expertise", value: v.expertise ?? "" },
        { label: "Sujet proposé", value: v.proposedTopic ?? "" },
        { label: "Bio", value: v.bio ?? "" },
        { label: "Proposition", value: v.proposal ?? "" },
        { label: "Message", value: v.message ?? "" }
      ];
    case "CONTENT_CREATOR":
      return [
        ...contact,
        { label: "Plateforme", value: v.platform ?? "" },
        { label: "Audience", value: v.audienceSize ?? "" },
        { label: "Type de contenu", value: v.contentType ?? "" },
        { label: "Marque / pseudo", value: v.organization ?? "" },
        { label: "Site", value: v.website ?? "" },
        { label: "LinkedIn", value: v.linkedin ?? "" },
        { label: "Proposition", value: v.proposal ?? "" },
        { label: "Message", value: v.message ?? "" }
      ];
  }
}

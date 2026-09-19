"use client";

import type { Participant } from "@prisma/client";
import { useActionState } from "react";
import {
  confirmVisitorParticipation,
  type ApplicationSubmitState
} from "@/app/actions/onboarding";
import {
  FormField,
  FormSection,
  TextInput,
  SubmitButton
} from "@/components/forms/primitives";
import { FormErrorBanner } from "@/components/forms/submission-state";

const initialState: ApplicationSubmitState = { status: "idle" };

/**
 * Step 3 for the Visitor path.
 *
 * If the Participant already has the required contact info (phone), we show
 * a compact confirmation. Otherwise — typical for the AccountUser-bootstrap
 * path — we show a small completion form to collect phone / country / org.
 */
export function VisitorConfirm({ participant }: { participant: Participant }) {
  const needsCompletion = !participant.phone;
  const [state, formAction] = useActionState(
    confirmVisitorParticipation,
    initialState
  );

  const errs = state.status === "error" ? state.fieldErrors ?? {} : {};

  return (
    <form action={formAction} className="space-y-8">
      <dl className="rounded-2xl border border-black/[0.06] bg-white p-6 text-sm">
        <Row
          label="Nom"
          value={`${participant.firstName} ${participant.lastName}`}
        />
        <Row label="Email" value={participant.email} />
        {participant.phone && <Row label="Téléphone" value={participant.phone} />}
        <Row label="Pays" value={participant.country} />
        {participant.organization && (
          <Row label="Organisation" value={participant.organization} />
        )}
        {participant.jobTitle && (
          <Row label="Fonction" value={participant.jobTitle} />
        )}
        <Row label="Rôle" value="Participant / Visiteur" highlight />
      </dl>

      {needsCompletion && (
        <FormSection
          eyebrow="Finalisation"
          title="Quelques informations supplémentaires"
          description="Nécessaires pour votre inscription au sommet."
        >
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
          <FormField name="country" label="Pays" error={errs.country}>
            <TextInput
              id="country"
              name="country"
              defaultValue={participant.country || "Algérie"}
              autoComplete="country-name"
              invalid={!!errs.country}
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
              defaultValue={participant.organization ?? ""}
              autoComplete="organization"
              invalid={!!errs.organization}
            />
          </FormField>
          <FormField name="jobTitle" label="Fonction" error={errs.jobTitle}>
            <TextInput
              id="jobTitle"
              name="jobTitle"
              defaultValue={participant.jobTitle ?? ""}
              autoComplete="organization-title"
              invalid={!!errs.jobTitle}
            />
          </FormField>
        </FormSection>
      )}

      <p className="text-[13px] text-ink/60">
        En confirmant, vous finalisez votre inscription au BIS 2026. Vous
        recevrez un email de récapitulatif si ce n'est pas déjà le cas.
      </p>

      {state.status === "error" && <FormErrorBanner message={state.message} />}

      <SubmitButton pendingLabel="Confirmation en cours…">
        Confirmer mon inscription
      </SubmitButton>
    </form>
  );
}

function Row({
  label,
  value,
  highlight
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/70 py-2 last:border-b-0">
      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </dt>
      <dd
        className={
          highlight
            ? "text-right font-semibold text-cobalt"
            : "text-right font-medium text-ink"
        }
      >
        {value}
      </dd>
    </div>
  );
}

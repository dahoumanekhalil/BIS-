"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { ApplicationType, type Prisma } from "@prisma/client";
import {
  basicRegistrationSchema,
  sponsorDetailsSchema,
  partnerDetailsSchema,
  speakerDetailsSchema,
  creatorDetailsSchema,
  PARTICIPATION_SLUG,
  participationFromSlug,
  type ParticipationChoiceKey
} from "@/lib/applications";
import {
  createOnboardingSession,
  resumeOrBootstrapOnboarding,
  endOnboardingSession
} from "@/lib/onboarding";
import { queueTemplatedEmail, EVENT_VARS } from "@/lib/email/queue";

/* ------------------------------ TYPES ------------------------------ */

export type StartRegistrationState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

export type ApplicationSubmitState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

/* ------------------------------ COMPLETION SCHEMAS ------------------------------ */

// Fields collected at Step 3 only when a Participant is missing them —
// typical for users bootstrapped from an /auth?mode=register signup.

const phoneField = z
  .string()
  .trim()
  .min(6, "Téléphone invalide")
  .max(24)
  .regex(/^[+0-9\s().\-]+$/, "Téléphone invalide");

const visitorCompletionSchema = z.object({
  phone: phoneField,
  country: z.string().trim().max(80).default("Algérie"),
  organization: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
  jobTitle: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined))
});

const contactCompletionSchema = z.object({
  phone: phoneField,
  country: z.string().trim().max(80).default("Algérie")
});

/* ------------------------------ STEP 1 — START REGISTRATION ------------------------------ */

/**
 * Step 1 server action. Creates the Participant (basic BIS registration),
 * sends the visitor-confirmation email, opens an OnboardingSession, and
 * redirects the user to either the participation selector or a preselected
 * role's Step 3 form (when ?participation=<slug> was passed on Step 1).
 */
export async function startRegistration(
  _prev: StartRegistrationState,
  formData: FormData
): Promise<StartRegistrationState> {
  const raw = {
    firstName: formData.get("firstName") ?? "",
    lastName: formData.get("lastName") ?? "",
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? "",
    country: formData.get("country") ?? "Algérie",
    jobTitle: formData.get("jobTitle") ?? "",
    registrationType: formData.get("registrationType") ?? "ATTENDEE",
    organization: formData.get("organization") ?? "",
    companyIndustry: formData.get("companyIndustry") ?? "",
    companyWebsite: formData.get("companyWebsite") ?? "",
    companySize: formData.get("companySize") ?? "",
    consent: formData.get("consent") === "on"
  };

  const parsed = basicRegistrationSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors
    };
  }
  const data = parsed.data;

  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (!event) {
    return {
      status: "error",
      message:
        "L'événement n'est pas encore configuré. Contactez l'organisation."
    };
  }

  // Duplicate email guard — the (eventId, email) uniqueness is enforced by
  // Prisma too, but we surface a friendly message.
  const existing = await prisma.participant.findUnique({
    where: { eventId_email: { eventId: event.id, email: data.email } },
    select: { id: true }
  });
  if (existing) {
    return {
      status: "error",
      message:
        "Cette adresse email est déjà enregistrée. Contactez-nous si nécessaire."
    };
  }

  const hasCompanyInfo =
    !!data.organization || !!data.companyIndustry || !!data.companyWebsite;

  const participant = await prisma.participant.create({
    data: {
      eventId: event.id,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      country: data.country,
      jobTitle: data.jobTitle || null,
      registrationType: data.registrationType,
      profile: hasCompanyInfo ? "COMPANY" : "VISITOR",
      organization: data.organization || null,
      companyIndustry: data.companyIndustry || null,
      companyWebsite: data.companyWebsite || null,
      companySize: data.companySize || null,
      status: "PENDING"
    }
  });

  await queueTemplatedEmail({
    templateKey: hasCompanyInfo
      ? "registration-company-received"
      : "registration-visitor-received",
    to: participant.email,
    toName: `${participant.firstName} ${participant.lastName}`,
    vars: {
      firstName: participant.firstName,
      lastName: participant.lastName,
      fullName: `${participant.firstName} ${participant.lastName}`,
      email: participant.email,
      ...EVENT_VARS
    },
    participantId: participant.id
  });

  await createOnboardingSession(participant.id);

  // Preserve the preselected participation intent (if any) into Step 3.
  const preselect = participationFromSlug(
    String(formData.get("participation") ?? "")
  );
  if (preselect) {
    redirect(`/register/${PARTICIPATION_SLUG[preselect]}`);
  }
  redirect(`/register/participation`);
}

/* ------------------------------ STEP 2 — VISITOR PATH ------------------------------ */

/**
 * Visitor Step 2 confirmation. Accepts optional phone/country/organization
 * from the completion form — the fields are only shown when the Participant
 * is missing them (typical for the AccountUser-bootstrap path).
 *
 * Idempotency guard: refuses to overwrite a participationChoice that is
 * already set (e.g. SPONSOR wiped to VISITOR by a stale form re-submit).
 */
export async function confirmVisitorParticipation(
  _prev: ApplicationSubmitState,
  formData: FormData
): Promise<ApplicationSubmitState> {
  const participant = await resumeOrBootstrapOnboarding();
  if (!participant) redirect("/register");

  if (
    participant.participationChoice &&
    participant.participationChoice !== "VISITOR"
  ) {
    await endOnboardingSession();
    redirect(
      `/register/complete?type=${slugFor(participant.participationChoice as ApplicationType)}`
    );
  }

  // Collect the completion fields — required only when the Participant is
  // still missing them.
  const completionParse = visitorCompletionSchema.safeParse({
    phone: get(formData, "phone"),
    country: get(formData, "country") || "Algérie",
    organization: get(formData, "organization"),
    jobTitle: get(formData, "jobTitle")
  });

  if (!participant.phone && !completionParse.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of completionParse.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de compléter vos informations d'inscription.",
      fieldErrors
    };
  }

  const completion = completionParse.success ? completionParse.data : null;

  // Stamp the participation choice + always-safe fields.
  await prisma.participant.update({
    where: { id: participant.id },
    data: {
      participationChoice: "VISITOR",
      ...(completion?.country ? { country: completion.country } : {})
    }
  });

  // Race-safe backfills — each updateMany writes only when the target column
  // is still NULL, so two concurrent submits can't overwrite each other.
  if (completion?.phone && !participant.phone) {
    await prisma.participant.updateMany({
      where: { id: participant.id, phone: null },
      data: { phone: completion.phone }
    });
  }
  if (completion?.organization && !participant.organization) {
    await prisma.participant.updateMany({
      where: { id: participant.id, organization: null },
      data: { organization: completion.organization }
    });
  }
  if (completion?.jobTitle && !participant.jobTitle) {
    await prisma.participant.updateMany({
      where: { id: participant.id, jobTitle: null },
      data: { jobTitle: completion.jobTitle }
    });
  }

  await endOnboardingSession();

  redirect(`/register/complete?type=visitor`);
}

/* ------------------------------ STEP 3 — APPLICATION SUBMIT ------------------------------ */

const paramsSchema = z.object({
  type: z.nativeEnum(ApplicationType)
});

/**
 * Step 3 for professional roles. Validates the role-specific fields against
 * the appropriate schema, creates an Application linked to the Participant,
 * stamps Participant.participationChoice, sends the application-received
 * email, and ends the onboarding session.
 */
export async function submitParticipation(
  type: ApplicationType,
  _prev: ApplicationSubmitState,
  formData: FormData
): Promise<ApplicationSubmitState> {
  const typeParse = paramsSchema.safeParse({ type });
  if (!typeParse.success) {
    return { status: "error", message: "Type de participation invalide." };
  }

  const participant = await resumeOrBootstrapOnboarding();
  if (!participant) {
    redirect("/register");
  }

  const parsed = validateFor(typeParse.data.type, formData);
  if (!parsed.ok) {
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: parsed.fieldErrors
    };
  }

  // Also parse the optional participant-completion fields (phone / country)
  // — required only when they're missing from the Participant.
  const completionParse = contactCompletionSchema.safeParse({
    phone: get(formData, "contactPhone"),
    country: get(formData, "contactCountry") || participant.country || "Algérie"
  });

  if (!participant.phone && !completionParse.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of completionParse.error.issues) {
      fieldErrors[`contact.${issue.path.join(".")}`] = issue.message;
    }
    return {
      status: "error",
      message:
        "Merci de renseigner un numéro de téléphone pour finaliser votre candidature.",
      fieldErrors
    };
  }

  const completion = completionParse.success ? completionParse.data : null;
  const d = parsed.data;

  // Resolve the final phone that will land on the Application row.
  // Business-required — refuse the write rather than silently persisting "".
  const finalPhone = participant.phone || completion?.phone || "";
  if (!finalPhone) {
    return {
      status: "error",
      message:
        "Merci de renseigner un numéro de téléphone pour finaliser votre candidature.",
      fieldErrors: { "contact.phone": "Téléphone requis" }
    };
  }
  const finalCountry = completion?.country || participant.country;

  // Guard against a Participant that already ran through an application for
  // this same role. Defence-in-depth: the DB @@unique([participantId, type])
  // is the actual authority (see P2002 catch below).
  const existingApp = await prisma.application.findFirst({
    where: {
      participantId: participant.id,
      type: typeParse.data.type
    },
    select: { id: true }
  });
  if (existingApp) {
    return {
      status: "error",
      message:
        "Une candidature de ce type existe déjà pour votre inscription."
    };
  }

  try {
  await prisma.$transaction(async (tx) => {
    await tx.application.create({
      data: {
        eventId: participant.eventId,
        participantId: participant.id,
        type: typeParse.data.type,
        status: "RECEIVED",
        // Snapshot the contact fields onto the Application row too, so admin
        // views don't have to join. Kept in sync with Participant only at
        // creation time — an admin editing the Participant does not retro-
        // actively rewrite historic Application rows.
        firstName: participant.firstName,
        lastName: participant.lastName,
        email: participant.email,
        phone: finalPhone,
        country: finalCountry,
        position: d.position ?? null,
        organization: d.organization ?? participant.organization ?? null,
        website: d.website ?? null,
        industry: d.industry ?? null,
        photoUrl: d.photoUrl ?? null,
        logoUrl: d.logoUrl ?? null,
        linkedin: d.linkedin ?? null,
        message: d.message ?? null,
        details: d.details as Prisma.InputJsonValue
      }
    });

    // Always safe: stamp the participation choice.
    await tx.participant.update({
      where: { id: participant.id },
      data: {
        participationChoice: APP_TYPE_TO_PARTICIPATION[typeParse.data.type],
        ...(completion?.country ? { country: completion.country } : {})
      }
    });

    // Phone backfill — race-safe: only writes when the row is still NULL,
    // so two concurrent submits can't fight over the value.
    if (completion?.phone && !participant.phone) {
      await tx.participant.updateMany({
        where: { id: participant.id, phone: null },
        data: { phone: completion.phone }
      });
    }
  });
  } catch (err) {
    // Racing double-submit landed on the (participantId, type) unique — treat
    // as success, the first write already fired the confirmation email.
    if (isUniqueConstraint(err)) {
      await endOnboardingSession();
      redirect(
        `/register/complete?type=${slugFor(typeParse.data.type as ApplicationType)}`
      );
    }
    throw err;
  }

  await queueTemplatedEmail({
    templateKey: TEMPLATE_KEYS[typeParse.data.type],
    to: participant.email,
    toName: `${participant.firstName} ${participant.lastName}`,
    vars: {
      firstName: participant.firstName,
      lastName: participant.lastName,
      fullName: `${participant.firstName} ${participant.lastName}`,
      email: participant.email,
      ...EVENT_VARS
    },
    participantId: participant.id
  });

  await endOnboardingSession();

  redirect(
    `/register/complete?type=${slugFor(typeParse.data.type as ApplicationType)}`
  );
}

/* ------------------------------ CANCEL / ABANDON ------------------------------ */

export async function abandonOnboarding(): Promise<void> {
  await endOnboardingSession();
  redirect("/register");
}

/* ------------------------------ HELPERS ------------------------------ */

const TEMPLATE_KEYS: Record<ApplicationType, string> = {
  SPONSOR: "application-sponsor-received",
  PARTNER: "application-partner-received",
  SPEAKER: "application-speaker-received",
  CONTENT_CREATOR: "application-creator-received"
};

// Explicit map from ApplicationType (4 values) to ParticipationChoice (5).
// If a future ApplicationType is added, TypeScript will force adding it here
// too — no silent runtime enum mismatch.
const APP_TYPE_TO_PARTICIPATION: Record<
  ApplicationType,
  ParticipationChoiceKey
> = {
  SPONSOR: "SPONSOR",
  PARTNER: "PARTNER",
  SPEAKER: "SPEAKER",
  CONTENT_CREATOR: "CONTENT_CREATOR"
};

function isUniqueConstraint(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

function slugFor(type: ApplicationType): string {
  switch (type) {
    case "SPONSOR":
      return "sponsor";
    case "PARTNER":
      return "partner";
    case "SPEAKER":
      return "speaker";
    case "CONTENT_CREATOR":
      return "content-creator";
  }
}

function get(fd: FormData, key: string, dflt = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : dflt;
}

type NormalizedDetails = {
  position?: string;
  organization?: string;
  website?: string;
  industry?: string;
  photoUrl?: string;
  logoUrl?: string;
  linkedin?: string;
  message?: string;
  details: Record<string, unknown>;
};

function validateFor(
  type: ApplicationType,
  fd: FormData
):
  | { ok: true; data: NormalizedDetails }
  | { ok: false; fieldErrors: Record<string, string> } {
  if (type === "SPONSOR") {
    const raw = {
      organization: get(fd, "organization"),
      industry: get(fd, "industry"),
      website: get(fd, "website"),
      logoUrl: get(fd, "logoUrl"),
      position: get(fd, "position"),
      interest: get(fd, "interest"),
      focusAreas: get(fd, "focusAreas"),
      message: get(fd, "message")
    };
    const p = sponsorDetailsSchema.safeParse(raw);
    if (!p.success) return { ok: false, fieldErrors: zerrors(p.error) };
    return {
      ok: true,
      data: {
        organization: p.data.organization,
        industry: p.data.industry || undefined,
        website: p.data.website,
        logoUrl: p.data.logoUrl,
        position: p.data.position || undefined,
        message: p.data.message || undefined,
        details: {
          interest: p.data.interest || "",
          focusAreas: p.data.focusAreas || ""
        }
      }
    };
  }

  if (type === "PARTNER") {
    const raw = {
      organization: get(fd, "organization"),
      industry: get(fd, "industry"),
      website: get(fd, "website"),
      position: get(fd, "position"),
      partnershipType: get(fd, "partnershipType"),
      proposal: get(fd, "proposal"),
      message: get(fd, "message")
    };
    const p = partnerDetailsSchema.safeParse(raw);
    if (!p.success) return { ok: false, fieldErrors: zerrors(p.error) };
    return {
      ok: true,
      data: {
        organization: p.data.organization,
        industry: p.data.industry || undefined,
        website: p.data.website,
        position: p.data.position || undefined,
        message: p.data.message || undefined,
        details: {
          partnershipType: p.data.partnershipType || "",
          proposal: p.data.proposal || ""
        }
      }
    };
  }

  if (type === "SPEAKER") {
    const raw = {
      organization: get(fd, "organization"),
      website: get(fd, "website"),
      linkedin: get(fd, "linkedin"),
      photoUrl: get(fd, "photoUrl"),
      professionalTitle: get(fd, "professionalTitle"),
      expertise: get(fd, "expertise"),
      proposedTopic: get(fd, "proposedTopic"),
      bio: get(fd, "bio"),
      proposal: get(fd, "proposal"),
      message: get(fd, "message")
    };
    const p = speakerDetailsSchema.safeParse(raw);
    if (!p.success) return { ok: false, fieldErrors: zerrors(p.error) };
    return {
      ok: true,
      data: {
        organization: p.data.organization || undefined,
        website: p.data.website,
        linkedin: p.data.linkedin,
        photoUrl: p.data.photoUrl,
        message: p.data.message || undefined,
        details: {
          professionalTitle: p.data.professionalTitle,
          expertise: p.data.expertise || "",
          proposedTopic: p.data.proposedTopic,
          bio: p.data.bio,
          proposal: p.data.proposal
        }
      }
    };
  }

  // CONTENT_CREATOR
  const raw = {
    organization: get(fd, "organization"),
    website: get(fd, "website"),
    linkedin: get(fd, "linkedin"),
    platform: get(fd, "platform"),
    audienceSize: get(fd, "audienceSize"),
    contentType: get(fd, "contentType"),
    proposal: get(fd, "proposal"),
    message: get(fd, "message")
  };
  const p = creatorDetailsSchema.safeParse(raw);
  if (!p.success) return { ok: false, fieldErrors: zerrors(p.error) };
  return {
    ok: true,
    data: {
      organization: p.data.organization || undefined,
      website: p.data.website,
      linkedin: p.data.linkedin,
      message: p.data.message || undefined,
      details: {
        platform: p.data.platform,
        audienceSize: p.data.audienceSize || "",
        contentType: p.data.contentType || "",
        proposal: p.data.proposal
      }
    }
  };
}

function zerrors(e: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of e.issues) {
    out[issue.path.join(".")] = issue.message;
  }
  return out;
}

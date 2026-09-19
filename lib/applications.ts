import { z } from "zod";

/**
 * Shared Zod schemas + labels for the unified /register journey.
 *
 * ARCHITECTURE:
 *   Step 1 (basic registration)    → basicRegistrationSchema     → Participant
 *   Step 2 (participation choice)  → participationChoiceSchema   → Participant.participationChoice
 *   Step 3 (role-specific details) → <role>DetailsSchema         → Application
 *
 * Contact fields (firstName, lastName, email, phone, country) live on the
 * Participant record from Step 1. Role details schemas therefore contain
 * ONLY the role-specific extras — no contact duplication.
 */

/* ------------------------------ SHARED ATOMS ------------------------------ */

const trimmed = z.string().trim();
const optionalTrimmed = trimmed.max(200).optional().or(z.literal(""));

const firstName = trimmed.min(2, "Prénom trop court").max(80);
const lastName = trimmed.min(2, "Nom trop court").max(80);
const email = trimmed.toLowerCase().email("Email invalide").max(200);
const phone = trimmed
  .min(6, "Téléphone invalide")
  .max(24)
  .regex(/^[+0-9\s().\-]+$/, "Téléphone invalide");
const country = trimmed.max(80).default("Algérie");

// URL that is either empty or a valid http(s) URL. Empty string collapses to
// undefined so it can be stored as NULL in the database.
//
// SECURITY: validation runs before the transform so future refactors that
// remove the null check don't silently accept `javascript:` / `data:` URLs.
// Never `fetch()` these URLs server-side without SSRF protection.
const urlOptional = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === "" || /^https?:\/\//i.test(v),
    "URL invalide — commencez par https://"
  )
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : undefined));

const consent = z.literal(true, {
  errorMap: () => ({ message: "Vous devez accepter les conditions" })
});

/* ------------------------------ STEP 1 — BASIC REGISTRATION ------------------------------ */

// Unified basic registration. Company info is captured optionally when the
// user toggles "je représente une organisation" on the client — those fields
// are all optional at the schema level.
export const basicRegistrationSchema = z.object({
  firstName,
  lastName,
  email,
  phone,
  country,
  jobTitle: optionalTrimmed,
  registrationType: z
    .enum(["ATTENDEE", "STARTUP", "INVESTOR", "MEDIA", "PARTNER"])
    .default("ATTENDEE"),

  // Optional company block — presence promotes profile to COMPANY.
  organization: optionalTrimmed,
  companyIndustry: optionalTrimmed,
  companyWebsite: urlOptional,
  companySize: optionalTrimmed,

  consent
});
export type BasicRegistrationInput = z.infer<typeof basicRegistrationSchema>;

/* ------------------------------ STEP 2 — PARTICIPATION CHOICE ------------------------------ */

export const PARTICIPATION_CHOICES = [
  "VISITOR",
  "SPONSOR",
  "PARTNER",
  "SPEAKER",
  "CONTENT_CREATOR"
] as const;
export type ParticipationChoiceKey = (typeof PARTICIPATION_CHOICES)[number];

export const PARTICIPATION_LABEL: Record<ParticipationChoiceKey, string> = {
  VISITOR: "Participant / Visiteur",
  SPONSOR: "Sponsor",
  PARTNER: "Partenaire",
  SPEAKER: "Intervenant",
  CONTENT_CREATOR: "Créateur de contenu"
};

export const PARTICIPATION_DESCRIPTION: Record<ParticipationChoiceKey, string> =
  {
    VISITOR:
      "Rejoindre le sommet en tant que participant individuel — aucune information supplémentaire requise.",
    SPONSOR:
      "Associer votre marque à l'écosystème BIS et à l'ambition Algérie 2026.",
    PARTNER:
      "Institution, université, ONG ou média — construire une collaboration stratégique.",
    SPEAKER:
      "Proposer une intervention, un keynote ou une masterclass au comité éditorial.",
    CONTENT_CREATOR:
      "Amplifier les idées, histoires et impact qui émergent du sommet."
  };

// Public URL-friendly aliases used in query params and dynamic routes.
export const PARTICIPATION_SLUG: Record<ParticipationChoiceKey, string> = {
  VISITOR: "visitor",
  SPONSOR: "sponsor",
  PARTNER: "partner",
  SPEAKER: "speaker",
  CONTENT_CREATOR: "content-creator"
};

export function participationFromSlug(
  slug: string | null | undefined
): ParticipationChoiceKey | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  for (const key of PARTICIPATION_CHOICES) {
    if (PARTICIPATION_SLUG[key] === s) return key;
  }
  return null;
}

export const participationChoiceSchema = z.object({
  choice: z.enum(PARTICIPATION_CHOICES)
});

/* ------------------------------ STEP 3 — ROLE DETAILS ------------------------------ */

// Each role-specific schema captures ONLY the extras beyond the Participant's
// contact fields. Applications also inherit organisation info from the
// Participant record when appropriate.

export const sponsorDetailsSchema = z.object({
  organization: trimmed.min(2, "Nom d'organisation requis").max(160),
  industry: optionalTrimmed,
  website: urlOptional,
  logoUrl: urlOptional,
  position: optionalTrimmed,
  interest: optionalTrimmed,
  focusAreas: trimmed.max(600).optional().or(z.literal("")),
  message: trimmed.max(4000).optional().or(z.literal(""))
});
export type SponsorDetailsInput = z.infer<typeof sponsorDetailsSchema>;

export const partnerDetailsSchema = z.object({
  organization: trimmed.min(2, "Nom d'organisation requis").max(160),
  industry: optionalTrimmed,
  website: urlOptional,
  position: optionalTrimmed,
  partnershipType: optionalTrimmed,
  proposal: trimmed.max(2000).optional().or(z.literal("")),
  message: trimmed.max(4000).optional().or(z.literal(""))
});
export type PartnerDetailsInput = z.infer<typeof partnerDetailsSchema>;

export const speakerDetailsSchema = z.object({
  organization: optionalTrimmed,
  website: urlOptional,
  linkedin: urlOptional,
  photoUrl: urlOptional,
  professionalTitle: trimmed.min(2, "Titre professionnel requis").max(160),
  expertise: trimmed.max(400).optional().or(z.literal("")),
  proposedTopic: trimmed.min(4, "Sujet proposé requis").max(200),
  bio: trimmed.min(20, "Bio trop courte").max(2000),
  proposal: trimmed.min(20, "Proposition trop courte").max(3000),
  message: trimmed.max(4000).optional().or(z.literal(""))
});
export type SpeakerDetailsInput = z.infer<typeof speakerDetailsSchema>;

export const creatorDetailsSchema = z.object({
  organization: optionalTrimmed, // brand / creator handle
  website: urlOptional,
  linkedin: urlOptional,
  platform: trimmed.min(2, "Plateforme principale requise").max(80),
  audienceSize: optionalTrimmed,
  contentType: optionalTrimmed,
  proposal: trimmed.min(20, "Proposition trop courte").max(3000),
  message: trimmed.max(4000).optional().or(z.literal(""))
});
export type CreatorDetailsInput = z.infer<typeof creatorDetailsSchema>;

/* ------------------------------ APPLICATION LABELS (admin) ------------------------------ */

export const APPLICATION_TYPES = [
  "SPONSOR",
  "PARTNER",
  "SPEAKER",
  "CONTENT_CREATOR"
] as const;
export type ApplicationTypeKey = (typeof APPLICATION_TYPES)[number];

export const APPLICATION_TYPE_LABEL: Record<ApplicationTypeKey, string> = {
  SPONSOR: "Sponsor",
  PARTNER: "Partenaire",
  SPEAKER: "Intervenant",
  CONTENT_CREATOR: "Créateur de contenu"
};

export const APPLICATION_TYPE_SLUG: Record<ApplicationTypeKey, string> = {
  SPONSOR: "sponsor",
  PARTNER: "partner",
  SPEAKER: "speaker",
  CONTENT_CREATOR: "content-creator"
};

export function applicationTypeFromSlug(
  slug: string | null | undefined
): ApplicationTypeKey | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  for (const key of APPLICATION_TYPES) {
    if (APPLICATION_TYPE_SLUG[key] === s) return key;
  }
  return null;
}

export const APPLICATION_STATUSES = [
  "RECEIVED",
  "UNDER_REVIEW",
  "CONTACTED",
  "APPROVED",
  "REJECTED"
] as const;
export type ApplicationStatusKey = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatusKey, string> = {
  RECEIVED: "Reçue",
  UNDER_REVIEW: "En examen",
  CONTACTED: "Contacté",
  APPROVED: "Approuvé",
  REJECTED: "Rejeté"
};

// Map ParticipationChoice → Application type (VISITOR has no application).
export function participationToApplicationType(
  choice: ParticipationChoiceKey
): ApplicationTypeKey | null {
  return choice === "VISITOR" ? null : choice;
}

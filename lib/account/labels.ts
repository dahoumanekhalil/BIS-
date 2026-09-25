import type {
  ApplicationStatus,
  ApplicationType,
  BadgeStatus,
  CheckInResult,
  ParticipationChoice,
  RegistrationStatus
} from "@prisma/client";

// French labels for enums surfaced in the /compte experience. Kept as data
// (not JSX) so both server and client components can consume them. Fall-back
// to the enum name so a newly-added value never crashes the UI silently.

export const PARTICIPATION_LABEL: Record<ParticipationChoice, string> = {
  VISITOR: "Participant / Visiteur",
  SPONSOR: "Sponsor",
  PARTNER: "Partenaire",
  SPEAKER: "Intervenant",
  CONTENT_CREATOR: "Créateur de contenu"
};

export const REGISTRATION_STATUS_LABEL: Record<RegistrationStatus, string> = {
  // PENDING is deprecated — retained here so legacy rows still render a
  // human-readable label. New participants land in REGISTERED.
  PENDING: "Inscription reçue",
  REGISTERED: "Inscription enregistrée",
  CONFIRMED: "Inscription confirmée",
  CANCELLED: "Annulée"
};

export const BADGE_STATUS_LABEL: Record<BadgeStatus, string> = {
  PENDING: "Badge en attente",
  ACTIVE: "Badge actif",
  REVOKED: "Badge révoqué",
  EXPIRED: "Badge expiré"
};

// Semantic tone drives the accent color used in status pills. UI-agnostic —
// components decide how to map tone → color.
export type StatusTone = "ok" | "wait" | "danger" | "muted";

export const BADGE_STATUS_TONE: Record<BadgeStatus, StatusTone> = {
  ACTIVE: "ok",
  PENDING: "wait",
  REVOKED: "danger",
  EXPIRED: "danger"
};

export const REGISTRATION_STATUS_TONE: Record<RegistrationStatus, StatusTone> = {
  CONFIRMED: "ok",
  REGISTERED: "ok",
  PENDING: "wait",
  CANCELLED: "danger"
};

export const APPLICATION_TYPE_LABEL: Record<ApplicationType, string> = {
  SPONSOR: "Sponsor",
  PARTNER: "Partenaire",
  SPEAKER: "Intervenant",
  CONTENT_CREATOR: "Créateur de contenu"
};

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  RECEIVED: "Reçue",
  UNDER_REVIEW: "En cours d'examen",
  CONTACTED: "Contactée",
  APPROVED: "Approuvée",
  REJECTED: "Refusée"
};

export const APPLICATION_STATUS_TONE: Record<ApplicationStatus, StatusTone> = {
  RECEIVED: "wait",
  UNDER_REVIEW: "wait",
  CONTACTED: "wait",
  APPROVED: "ok",
  REJECTED: "danger"
};

// Attendee-facing CheckIn result labels. Deliberately not admin-vocabulary:
// e.g. `ALREADY_CHECKED_IN` is not an error for the attendee — it just
// means "you're already registered as present". Copy is intended to be
// read on the attendee's phone during or after the event.
export const CHECKIN_RESULT_LABEL: Record<CheckInResult, string> = {
  VALID: "Accès enregistré",
  ALREADY_CHECKED_IN: "Déjà présent",
  WRONG_GATE: "Porte incorrecte",
  WRONG_TIME: "Hors créneau",
  CANCELLED: "Inscription annulée",
  UNKNOWN: "Scan non identifié"
};

export const CHECKIN_RESULT_TONE: Record<CheckInResult, StatusTone> = {
  VALID: "ok",
  ALREADY_CHECKED_IN: "muted",
  WRONG_GATE: "danger",
  WRONG_TIME: "danger",
  CANCELLED: "danger",
  UNKNOWN: "danger"
};

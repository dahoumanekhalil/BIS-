// Phase 18 — attendee badge role classifier.
//
// Maps the participant's stored fields (`tier`, `participationChoice`)
// to a badge-visual role. The classifier is DERIVED — it does not
// change any authoritative record; two participants with the same
// tier + participationChoice always resolve to the same variant.
//
// SECURITY: pure, no I/O, no server-only, no Prisma imports at
// runtime (type-only imports below are erased at compile). Safe to
// use in both server and client components.

import type { ParticipationChoice, RegistrationTier } from "@prisma/client";

// Visual role variants. Kept as a flat union so the badge template
// can switch on it without nested conditionals.
export type BadgeRole =
  | "VVIP"
  | "VIP"
  | "SPEAKER"
  | "ORGANISATION"
  | "CONTENT_CREATOR"
  | "PRESS"
  | "VISITOR";

export type BadgeRoleInput = {
  tier: RegistrationTier | null;
  participationChoice: ParticipationChoice | null;
};

// Classification rules (ordered — first match wins):
//   1. VVIP / VIP tier → same-name variant.
//   2. SPEAKER participationChoice → SPEAKER.
//   3. SPONSOR or PARTNER participationChoice → ORGANISATION.
//   4. CONTENT_CREATOR (either source) → CONTENT_CREATOR.
//   5. Default → VISITOR.
//
// PRESS is included in the visual variant list for consistency with
// the operational badge concept, but the current data model has no
// dedicated PRESS marker. Callers may override `resolveBadgeRole` by
// passing an explicit override where they have one.
export function resolveBadgeRole(input: BadgeRoleInput): BadgeRole {
  if (input.tier === "VVIP") return "VVIP";
  if (input.tier === "VIP") return "VIP";
  if (input.participationChoice === "SPEAKER") return "SPEAKER";
  if (
    input.participationChoice === "SPONSOR" ||
    input.participationChoice === "PARTNER"
  ) {
    return "ORGANISATION";
  }
  if (
    input.participationChoice === "CONTENT_CREATOR" ||
    input.tier === "CONTENT_CREATOR"
  ) {
    return "CONTENT_CREATOR";
  }
  return "VISITOR";
}

// French labels for the role pill.
export const BADGE_ROLE_LABEL: Record<BadgeRole, string> = {
  VVIP: "VVIP",
  VIP: "VIP",
  SPEAKER: "Intervenant",
  ORGANISATION: "Organisation",
  CONTENT_CREATOR: "Créateur de contenu",
  PRESS: "Presse",
  VISITOR: "Visiteur"
};

// Accent palette per variant. Each entry is used ONLY for the small
// accent surfaces (role pill, corner stripe, thin accent line).
// The BIS brand colors (Ink Navy / Cobalt / Lime / Frost) remain
// dominant on every variant. Contrasts chosen for WCAG-AA on the
// role pill text.
export type BadgeAccent = {
  // Solid background for the role pill.
  pillBg: string;
  // Text color for the role pill (dark or light depending on bg).
  pillText: string;
  // Thin corner-stripe / accent-line color (typically same as pillBg).
  stripe: string;
  // Optional soft-tinted background for the inner geometric detail
  // (used sparingly — never dominant).
  softBg: string;
};

// Hex values chosen for good on-screen contrast + print fidelity.
// Kept as CSS variables inline in components rather than as Tailwind
// classes so PNG capture works regardless of dynamic class purging.
export const BADGE_ROLE_ACCENTS: Record<BadgeRole, BadgeAccent> = {
  // ORGANISATION — Cobalt-adjacent blue (BIS brand family).
  ORGANISATION: {
    pillBg: "#2453E0",
    pillText: "#FFFFFF",
    stripe: "#2453E0",
    softBg: "rgba(36, 83, 224, 0.08)"
  },
  // VIP — warm gold. Distinct from cobalt / lime; premium feel.
  VIP: {
    pillBg: "#C8992A",
    pillText: "#0A0A0A",
    stripe: "#C8992A",
    softBg: "rgba(200, 153, 42, 0.10)"
  },
  // VVIP — deep violet. Signals the highest tier without going purple-neon.
  VVIP: {
    pillBg: "#5B32C1",
    pillText: "#FFFFFF",
    stripe: "#5B32C1",
    softBg: "rgba(91, 50, 193, 0.10)"
  },
  // SPEAKER — cyan; complements cobalt without competing.
  SPEAKER: {
    pillBg: "#0BB4C7",
    pillText: "#0A0A0A",
    stripe: "#0BB4C7",
    softBg: "rgba(11, 180, 199, 0.10)"
  },
  // CONTENT_CREATOR — evergreen. Distinct from Electric Lime.
  CONTENT_CREATOR: {
    pillBg: "#2FA35C",
    pillText: "#FFFFFF",
    stripe: "#2FA35C",
    softBg: "rgba(47, 163, 92, 0.10)"
  },
  // PRESS — restrained coral. Serious enough for editorial credentials.
  PRESS: {
    pillBg: "#D0453C",
    pillText: "#FFFFFF",
    stripe: "#D0453C",
    softBg: "rgba(208, 69, 60, 0.10)"
  },
  // VISITOR — Electric Lime (BIS brand accent). Default variant.
  VISITOR: {
    pillBg: "#B8E62E",
    pillText: "#0A0A0A",
    stripe: "#B8E62E",
    softBg: "rgba(184, 230, 46, 0.14)"
  }
};

// Static BIS 2027 event context surfaced on the badge back.
// Kept as data so the same values feed the web preview, the PNG
// export, and the PDF export from one source of truth.
export const BIS_EVENT_2027 = {
  name: "Business Innovation Summit",
  edition: "2027",
  datesLabel: "03 – 05 Janvier 2027",
  venue: "Palais des Expositions SAFEX",
  city: "Alger",
  website: "www.brandimpactsummit.org",
  hashtag: "#BIS2027"
} as const;

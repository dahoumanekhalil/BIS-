// BIS email design tokens — kept in one place so every template
// stays visually consistent.

export const EMAIL_COLORS = {
  frost: "#F8FAF9",
  white: "#FFFFFF",
  ink: "#111827",
  inkSoft: "#334155",
  inkMuted: "#64748B",
  line: "#E6E8ED",
  cobalt: "#2453E0",
  cobaltDark: "#1339B7",
  lime: "#B8E62E",
  limeDark: "#A6D420",
  frostOnDark: "rgba(248,250,249,0.72)",
  frostOnDarkMuted: "rgba(248,250,249,0.5)"
} as const;

export const EMAIL_FONT_STACK =
  "'Alexandria', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, Helvetica, sans-serif";

export const EMAIL_CONTAINER_WIDTH = 640;

export const EMAIL_SPACING = {
  contentX: 32,
  contentY: 36,
  mobileContentX: 20,
  mobileContentY: 24
} as const;

export const EMAIL_RADIUS = {
  card: 12,
  cta: 8,
  block: 8
} as const;

export type EmailBrandInfo = {
  eventName: string;
  editionLabel: string;
  eventDate: string;
  eventVenue: string;
  eventCity: string;
  legalName: string;
  siteUrl: string;
  contactUrl: string;
  programmeUrl: string;
};

export const EMAIL_BRAND: EmailBrandInfo = {
  eventName: "Algeria Brand Impact Summit",
  editionLabel: "BIS 2026",
  eventDate: "15 – 17 novembre 2026",
  eventVenue: "CIC Alger",
  eventCity: "Alger, Algérie",
  legalName: "Algeria Brand Impact Summit",
  // Only URLs that actually exist on the marketing site are used.
  siteUrl: "https://bis-algeria.dz",
  contactUrl: "https://bis-algeria.dz/contact",
  programmeUrl: "https://bis-algeria.dz/programme"
};

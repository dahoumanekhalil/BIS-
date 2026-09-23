import "server-only";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { EMAIL_BRAND } from "../tokens";

// â”€â”€â”€ Email branding config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Reusable header/footer identity for admin-authored templates.
// Persisted in `SiteContent("email.branding")` â€” no new Prisma model
// needed. Defaults are lifted from `lib/email/tokens.ts` so a fresh
// deployment already renders coherent BIS 2027 branding without any
// admin intervention.

const SITE_CONTENT_KEY = "email.branding";

export type EmailBranding = {
  eventName: string;
  editionLabel: string; // e.g. "Brand Impact Summit 2027"
  eventDate: string;
  eventVenue: string;
  eventCity: string;
  siteUrl: string;
  contactUrl: string;
  privacyUrl: string;
  termsUrl: string;
  logoUrl: string | null;
  footerNote: string;
  socialLinkedIn: string;
  socialInstagram: string;
  socialFacebook: string;
  socialX: string;
  socialYouTube: string;
};

export function defaultBranding(): EmailBranding {
  return {
    eventName: EMAIL_BRAND.eventName,
    editionLabel: EMAIL_BRAND.editionLabel,
    eventDate: EMAIL_BRAND.eventDate,
    eventVenue: EMAIL_BRAND.eventVenue,
    eventCity: EMAIL_BRAND.eventCity,
    siteUrl: EMAIL_BRAND.siteUrl,
    contactUrl: EMAIL_BRAND.contactUrl,
    privacyUrl: "",
    termsUrl: "",
    logoUrl: null,
    footerNote: `Â© 2027 ${EMAIL_BRAND.legalName}. Tous droits rÃ©servÃ©s.`,
    socialLinkedIn: "",
    socialInstagram: "",
    socialFacebook: "",
    socialX: "",
    socialYouTube: ""
  };
}

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .optional()
  .default("")
  .refine(
    (v) => v === "" || /^https?:\/\//i.test(v),
    "URL invalide (http:// ou https:// requis)"
  );

export const brandingFormSchema = z.object({
  eventName: z.string().trim().min(1).max(120),
  editionLabel: z.string().trim().min(1).max(160),
  eventDate: z.string().trim().min(1).max(120),
  eventVenue: z.string().trim().min(1).max(160),
  eventCity: z.string().trim().min(1).max(120),
  siteUrl: optionalUrl,
  contactUrl: optionalUrl,
  privacyUrl: optionalUrl,
  termsUrl: optionalUrl,
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .default("")
    .transform((v) => (v && v.length > 0 ? v : null))
    .refine(
      (v) => v == null || /^https?:\/\//i.test(v),
      "URL logo invalide"
    ),
  footerNote: z.string().trim().max(500).optional().default(""),
  socialLinkedIn: optionalUrl,
  socialInstagram: optionalUrl,
  socialFacebook: optionalUrl,
  socialX: optionalUrl,
  socialYouTube: optionalUrl
});

export type BrandingFormInput = z.output<typeof brandingFormSchema>;

export async function getEmailBranding(): Promise<EmailBranding> {
  const row = await prisma.siteContent.findUnique({
    where: { key: SITE_CONTENT_KEY }
  });
  if (!row || !row.value || typeof row.value !== "object") {
    return defaultBranding();
  }
  const v = row.value as Record<string, unknown>;
  const d = defaultBranding();
  return {
    eventName: pickString(v.eventName, d.eventName),
    editionLabel: pickString(v.editionLabel, d.editionLabel),
    eventDate: pickString(v.eventDate, d.eventDate),
    eventVenue: pickString(v.eventVenue, d.eventVenue),
    eventCity: pickString(v.eventCity, d.eventCity),
    siteUrl: pickString(v.siteUrl, d.siteUrl),
    contactUrl: pickString(v.contactUrl, d.contactUrl),
    privacyUrl: pickString(v.privacyUrl, d.privacyUrl),
    termsUrl: pickString(v.termsUrl, d.termsUrl),
    logoUrl: v.logoUrl && typeof v.logoUrl === "string" && v.logoUrl.length > 0 ? v.logoUrl : d.logoUrl,
    footerNote: pickString(v.footerNote, d.footerNote),
    socialLinkedIn: pickString(v.socialLinkedIn, d.socialLinkedIn),
    socialInstagram: pickString(v.socialInstagram, d.socialInstagram),
    socialFacebook: pickString(v.socialFacebook, d.socialFacebook),
    socialX: pickString(v.socialX, d.socialX),
    socialYouTube: pickString(v.socialYouTube, d.socialYouTube)
  };
}

export async function saveEmailBranding(input: BrandingFormInput): Promise<void> {
  const blob: EmailBranding = {
    eventName: input.eventName,
    editionLabel: input.editionLabel,
    eventDate: input.eventDate,
    eventVenue: input.eventVenue,
    eventCity: input.eventCity,
    siteUrl: input.siteUrl,
    contactUrl: input.contactUrl,
    privacyUrl: input.privacyUrl,
    termsUrl: input.termsUrl,
    logoUrl: input.logoUrl,
    footerNote: input.footerNote,
    socialLinkedIn: input.socialLinkedIn,
    socialInstagram: input.socialInstagram,
    socialFacebook: input.socialFacebook,
    socialX: input.socialX,
    socialYouTube: input.socialYouTube
  };
  await prisma.siteContent.upsert({
    where: { key: SITE_CONTENT_KEY },
    create: { key: SITE_CONTENT_KEY, value: blob as unknown as object },
    update: { value: blob as unknown as object }
  });
}

function pickString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

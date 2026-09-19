import { z } from "zod";

export const registrationSchema = z.object({
  firstName: z.string().trim().min(2, "Prénom trop court").max(80),
  lastName: z.string().trim().min(2, "Nom trop court").max(80),
  email: z.string().trim().toLowerCase().email("Email invalide"),
  phone: z
    .string()
    .trim()
    .min(6, "Téléphone invalide")
    .max(24)
    .regex(/^[+0-9\s().-]+$/, "Téléphone invalide"),
  organization: z.string().trim().max(120).optional().or(z.literal("")),
  jobTitle: z.string().trim().max(120).optional().or(z.literal("")),
  country: z.string().trim().max(80).default("Algérie"),
  registrationType: z.enum(["ATTENDEE", "STARTUP", "INVESTOR", "MEDIA", "PARTNER"]).default("ATTENDEE"),
  consent: z.literal(true, {
    errorMap: () => ({ message: "Vous devez accepter les conditions" })
  })
});

export type RegistrationInput = z.infer<typeof registrationSchema>;

export const CONTACT_REASONS = [
  "general",
  "partnership",
  "sponsorship",
  "media",
  "speaker",
  "other"
] as const;

export type ContactReason = (typeof CONTACT_REASONS)[number];

export const contactSchema = z.object({
  name: z.string().trim().min(2, "Nom trop court").max(120),
  email: z.string().trim().toLowerCase().email("Adresse email invalide"),
  organization: z.string().trim().max(140).optional().or(z.literal("")),
  reason: z.enum(CONTACT_REASONS).default("general"),
  subject: z.string().trim().min(2, "Sujet requis").max(140),
  message: z.string().trim().min(10, "Message trop court").max(4000)
});

export type ContactInput = z.infer<typeof contactSchema>;

export const accountLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Adresse email invalide"),
  password: z.string().min(6, "Minimum 6 caractères").max(200),
  remember: z.boolean().default(false)
});

export type AccountLoginInput = z.infer<typeof accountLoginSchema>;

export const accountRegisterSchema = z
  .object({
    firstName: z.string().trim().min(2, "Prénom trop court").max(80),
    lastName: z.string().trim().min(2, "Nom trop court").max(80),
    email: z.string().trim().toLowerCase().email("Adresse email invalide"),
    password: z.string().min(8, "Minimum 8 caractères").max(200),
    confirm: z.string(),
    consent: z.literal(true, {
      errorMap: () => ({ message: "Vous devez accepter les conditions" })
    })
  })
  .refine((d) => d.password === d.confirm, {
    path: ["confirm"],
    message: "Les mots de passe ne correspondent pas"
  });

export type AccountRegisterInput = z.infer<typeof accountRegisterSchema>;

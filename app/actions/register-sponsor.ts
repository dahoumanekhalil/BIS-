"use server";

import { z } from "zod";
import { sponsorDetailsSchema } from "@/lib/applications";
import {
  submitProfessionalApplication,
  type ProfessionalRegisterState
} from "@/lib/register/professional-action";

// Sponsor role — server action for /register/sponsor.
//
// All account/participant/idempotency/rate-limit/email/badge logic lives
// in submitProfessionalApplication. This action only:
//   1. reads form fields
//   2. validates them with the existing sponsorDetailsSchema
//   3. projects the parsed values into ProfessionalDetails
//   4. delegates to the kernel.

export type SponsorRegisterState = ProfessionalRegisterState;

function getStr(fd: FormData, key: string, dflt = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : dflt;
}

function zerrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) out[issue.path.join(".")] = issue.message;
  return out;
}

export async function submitSponsorApplication(
  _prev: SponsorRegisterState,
  formData: FormData
): Promise<SponsorRegisterState> {
  const parsed = sponsorDetailsSchema.safeParse({
    organization: getStr(formData, "organization"),
    industry: getStr(formData, "industry"),
    website: getStr(formData, "website"),
    logoUrl: getStr(formData, "logoUrl"),
    position: getStr(formData, "position"),
    interest: getStr(formData, "interest"),
    focusAreas: getStr(formData, "focusAreas"),
    message: getStr(formData, "message")
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: zerrors(parsed.error)
    };
  }
  const p = parsed.data;

  return submitProfessionalApplication({
    type: "SPONSOR",
    slug: "sponsor",
    choice: "SPONSOR",
    emailTemplateKey: "application-sponsor-received",
    submitsPerAccount: 10,
    authNextPath: "/register/sponsor",
    contactPhone: getStr(formData, "phone"),
    contactCountry: getStr(formData, "country"),
    data: {
      organization: p.organization,
      industry: p.industry || undefined,
      website: p.website,
      logoUrl: p.logoUrl,
      position: p.position || undefined,
      message: p.message || undefined,
      details: {
        interest: p.interest || "",
        focusAreas: p.focusAreas || ""
      }
    }
  });
}

"use server";

import { z } from "zod";
import { partnerDetailsSchema } from "@/lib/applications";
import {
  submitProfessionalApplication,
  type ProfessionalRegisterState
} from "@/lib/register/professional-action";

export type PartnerRegisterState = ProfessionalRegisterState;

function getStr(fd: FormData, key: string, dflt = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : dflt;
}

function zerrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) out[issue.path.join(".")] = issue.message;
  return out;
}

export async function submitPartnerApplication(
  _prev: PartnerRegisterState,
  formData: FormData
): Promise<PartnerRegisterState> {
  const parsed = partnerDetailsSchema.safeParse({
    organization: getStr(formData, "organization"),
    industry: getStr(formData, "industry"),
    website: getStr(formData, "website"),
    position: getStr(formData, "position"),
    partnershipType: getStr(formData, "partnershipType"),
    proposal: getStr(formData, "proposal"),
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
    type: "PARTNER",
    slug: "partner",
    choice: "PARTNER",
    emailTemplateKey: "application-partner-received",
    submitsPerAccount: 10,
    authNextPath: "/register/partner",
    contactPhone: getStr(formData, "phone"),
    contactCountry: getStr(formData, "country"),
    data: {
      organization: p.organization,
      industry: p.industry || undefined,
      website: p.website,
      position: p.position || undefined,
      message: p.message || undefined,
      details: {
        partnershipType: p.partnershipType || "",
        proposal: p.proposal || ""
      }
    }
  });
}

"use server";

import { z } from "zod";
import { creatorDetailsSchema } from "@/lib/applications";
import {
  submitProfessionalApplication,
  type ProfessionalRegisterState
} from "@/lib/register/professional-action";

export type ContentCreatorRegisterState = ProfessionalRegisterState;

function getStr(fd: FormData, key: string, dflt = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : dflt;
}

function zerrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) out[issue.path.join(".")] = issue.message;
  return out;
}

export async function submitContentCreatorApplication(
  _prev: ContentCreatorRegisterState,
  formData: FormData
): Promise<ContentCreatorRegisterState> {
  const parsed = creatorDetailsSchema.safeParse({
    organization: getStr(formData, "organization"),
    website: getStr(formData, "website"),
    linkedin: getStr(formData, "linkedin"),
    platform: getStr(formData, "platform"),
    audienceSize: getStr(formData, "audienceSize"),
    contentType: getStr(formData, "contentType"),
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
    type: "CONTENT_CREATOR",
    slug: "content-creator",
    choice: "CONTENT_CREATOR",
    emailTemplateKey: "application-creator-received",
    submitsPerAccount: 10,
    authNextPath: "/register/content-creator",
    contactPhone: getStr(formData, "phone"),
    contactCountry: getStr(formData, "country"),
    data: {
      organization: p.organization || undefined,
      website: p.website,
      linkedin: p.linkedin,
      message: p.message || undefined,
      details: {
        platform: p.platform,
        audienceSize: p.audienceSize || "",
        contentType: p.contentType || "",
        proposal: p.proposal
      }
    }
  });
}

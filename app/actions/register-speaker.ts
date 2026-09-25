"use server";

import { z } from "zod";
import { speakerDetailsSchema } from "@/lib/applications";
import {
  submitProfessionalApplication,
  type ProfessionalRegisterState
} from "@/lib/register/professional-action";

// Speaker role — server action for /register/speaker.
//
// Kernel-based (Commit 2 refactor): all account / participant / badge /
// email / idempotency / rate-limit / status-guard logic lives in
// `submitProfessionalApplication`. This action only reads + validates the
// form fields, projects them into the kernel's ProfessionalDetails shape,
// and delegates.
//
// Behavioural contract unchanged from Commit 1 aside from:
//   • Participant.status is now updated via a guarded `updateMany`
//     (`status IN ("PENDING", "REGISTERED")`) so CONFIRMED / CANCELLED
//     rows are never downgraded / resurrected. Same guarantee now
//     applies to every professional flow.

export type SpeakerRegisterState = ProfessionalRegisterState;

function getStr(fd: FormData, key: string, dflt = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : dflt;
}

function zerrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) out[issue.path.join(".")] = issue.message;
  return out;
}

export async function submitSpeakerApplication(
  _prev: SpeakerRegisterState,
  formData: FormData
): Promise<SpeakerRegisterState> {
  const parsed = speakerDetailsSchema.safeParse({
    organization: getStr(formData, "organization"),
    website: getStr(formData, "website"),
    linkedin: getStr(formData, "linkedin"),
    photoUrl: getStr(formData, "photoUrl"),
    professionalTitle: getStr(formData, "professionalTitle"),
    expertise: getStr(formData, "expertise"),
    proposedTopic: getStr(formData, "proposedTopic"),
    bio: getStr(formData, "bio"),
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
  const s = parsed.data;

  return submitProfessionalApplication({
    type: "SPEAKER",
    slug: "speaker",
    choice: "SPEAKER",
    emailTemplateKey: "application-speaker-received",
    submitsPerAccount: 10,
    authNextPath: "/register/speaker",
    contactPhone: getStr(formData, "phone"),
    contactCountry: getStr(formData, "country"),
    data: {
      organization: s.organization || undefined,
      website: s.website,
      linkedin: s.linkedin,
      photoUrl: s.photoUrl,
      message: s.message || undefined,
      details: {
        professionalTitle: s.professionalTitle,
        expertise: s.expertise || "",
        proposedTopic: s.proposedTopic,
        bio: s.bio,
        proposal: s.proposal
      }
    }
  });
}

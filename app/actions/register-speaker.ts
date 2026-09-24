"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { getCurrentAccount } from "@/lib/account/auth";
import { ensureParticipantForAccount, ensureActiveBadge } from "@/lib/register/participant";
import { queueTemplatedEmail, EVENT_VARS } from "@/lib/email/queue";
import { speakerDetailsSchema } from "@/lib/applications";
import { isBlocked, record, THROTTLED_MESSAGE } from "@/lib/rate-limit";

// Per-account throttle — the DB unique constraint stops duplicate applications
// after the first success, but a logged-in caller can still spam failed
// validations. 10/15 min is enough headroom for typos.
const SPEAKER_SUBMITS_PER_ACCOUNT = 10;

// Speaker role — server action for the /register/speaker flow.
//
// Contract:
//   • Requires an authenticated AccountUser (redirect to /auth with a
//     next= param otherwise).
//   • Reuses / creates the Participant tied to the AccountUser.
//   • Collects contact fields (phone / country) if the Participant is
//     still missing them, and speaker-specific details.
//   • Creates one Application(type=SPEAKER, status=RECEIVED). The
//     `@@unique([participantId, type])` DB constraint prevents dupes;
//     a P2002 catch treats the race as success and redirects.
//   • Sets participationChoice=SPEAKER (only if not already set to
//     something else — a user who is also VISITOR keeps their existing
//     choice; the application row is the authoritative signal here).
//   • Ensures an ACTIVE BadgeCredential (idempotent).
//   • Queues the application-received email.
//   • Redirects to /register/complete?type=speaker.

const phoneField = z
  .string()
  .trim()
  .min(6, "Téléphone invalide")
  .max(24)
  .regex(/^[+0-9\s().\-]+$/, "Téléphone invalide");

const contactSchema = z.object({
  phone: phoneField,
  country: z.string().trim().min(1, "Pays requis").max(80).default("Algérie")
});

export type SpeakerRegisterState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

function getStr(fd: FormData, key: string, dflt = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : dflt;
}

function zerrors(err: z.ZodError, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    out[prefix + issue.path.join(".")] = issue.message;
  }
  return out;
}

export async function submitSpeakerApplication(
  _prev: SpeakerRegisterState,
  formData: FormData
): Promise<SpeakerRegisterState> {
  const account = await getCurrentAccount();
  if (!account) {
    redirect("/auth?mode=register&next=/register/speaker");
  }

  const throttleKey = `register-speaker:acct:${account.id}`;
  if (isBlocked(throttleKey, SPEAKER_SUBMITS_PER_ACCOUNT)) {
    return { status: "error", message: THROTTLED_MESSAGE };
  }
  record(throttleKey);

  const ensured = await ensureParticipantForAccount(account);
  if (ensured.kind === "no-event") {
    return {
      status: "error",
      message: "L'événement n'est pas encore configuré. Contactez l'organisation."
    };
  }
  if (ensured.kind === "conflict") {
    return {
      status: "error",
      message:
        "Une inscription existe déjà avec cette adresse email. Vérifiez votre boîte mail — un lien de vérification vous permettra de récupérer votre inscription."
    };
  }
  const participant = ensured.participant;

  // Contact fields — required only when the Participant is missing them.
  const contactParse = contactSchema.safeParse({
    phone: getStr(formData, "phone") || participant.phone || "",
    country: getStr(formData, "country") || participant.country || "Algérie"
  });
  if (!participant.phone && !contactParse.success) {
    return {
      status: "error",
      message: "Merci de renseigner un numéro de téléphone.",
      fieldErrors: zerrors(contactParse.error)
    };
  }
  const contact = contactParse.success ? contactParse.data : null;

  // Speaker-specific details.
  const speakerRaw = {
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
  };
  const speakerParse = speakerDetailsSchema.safeParse(speakerRaw);
  if (!speakerParse.success) {
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: zerrors(speakerParse.error)
    };
  }
  const s = speakerParse.data;

  const finalPhone = participant.phone || contact?.phone || "";
  const finalCountry = contact?.country || participant.country;

  // Refuse duplicate applications up-front (better UX than a raw P2002),
  // but the DB `@@unique([participantId, type])` is the authoritative
  // guard against the race window.
  const existingApp = await prisma.application.findFirst({
    where: { participantId: participant.id, type: "SPEAKER" },
    select: { id: true }
  });
  if (existingApp) {
    return {
      status: "error",
      message:
        "Votre candidature intervenant est déjà enregistrée. Consultez son statut depuis votre espace personnel."
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.application.create({
        data: {
          eventId: participant.eventId,
          participantId: participant.id,
          type: "SPEAKER",
          status: "RECEIVED",
          firstName: participant.firstName,
          lastName: participant.lastName,
          email: participant.email,
          phone: finalPhone,
          country: finalCountry,
          position: null,
          organization: s.organization ?? participant.organization ?? null,
          website: s.website ?? null,
          industry: null,
          photoUrl: s.photoUrl ?? null,
          logoUrl: null,
          linkedin: s.linkedin ?? null,
          message: s.message ?? null,
          details: {
            professionalTitle: s.professionalTitle,
            expertise: s.expertise || "",
            proposedTopic: s.proposedTopic,
            bio: s.bio,
            proposal: s.proposal
          } as Prisma.InputJsonValue
        }
      });

      // participationChoice — only overwrite when it is currently NULL.
      // A user who first registered as VISITOR keeps that; the SPEAKER
      // Application row is the authoritative signal for the professional
      // side. Also ensures status=REGISTERED (defence in depth — the
      // Participant may have been in a legacy PENDING state pre-migration).
      await tx.participant.update({
        where: { id: participant.id },
        data: {
          status: "REGISTERED",
          ...(participant.participationChoice == null
            ? { participationChoice: "SPEAKER" }
            : {})
        }
      });

      if (contact?.phone && !participant.phone) {
        await tx.participant.updateMany({
          where: { id: participant.id, phone: null },
          data: { phone: contact.phone }
        });
      }
      if (contact?.country && contact.country !== participant.country) {
        await tx.participant.update({
          where: { id: participant.id },
          data: { country: contact.country }
        });
      }
    });
  } catch (err) {
    // Racing double-submit — treat as success.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      await ensureActiveBadge(participant.id);
      redirect("/register/complete?type=speaker");
    }
    throw err;
  }

  await ensureActiveBadge(participant.id);

  await queueTemplatedEmail({
    templateKey: "application-speaker-received",
    to: participant.email,
    toName: `${participant.firstName} ${participant.lastName}`,
    idempotencyKey: `application:${participant.id}:SPEAKER`,
    vars: {
      firstName: participant.firstName,
      lastName: participant.lastName,
      fullName: `${participant.firstName} ${participant.lastName}`,
      email: participant.email,
      ...EVENT_VARS
    },
    participantId: participant.id
  });

  revalidatePath("/compte");
  revalidatePath("/compte/demandes");
  revalidatePath("/compte/badge");

  redirect("/register/complete?type=speaker");
}

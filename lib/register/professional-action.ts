import "server-only";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma, type ApplicationType, type ParticipationChoice } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentAccount } from "@/lib/account/auth";
import { ensureParticipantForAccount, ensureActiveBadge } from "@/lib/register/participant";
import { queueTemplatedEmail, EVENT_VARS } from "@/lib/email/queue";
import { isBlocked, record, THROTTLED_MESSAGE } from "@/lib/rate-limit";

// Shared server-side kernel for every professional-role registration
// (Sponsor / Partner / Content Creator / Speaker). Encapsulates the
// account-first invariants so each role's server action is 30 lines of
// validation + one call.
//
// Invariants enforced here:
//   • Requires an authenticated AccountUser (redirects to /auth with the
//     right `next=` otherwise). Never trusts a client-supplied
//     participantId / accountUserId.
//   • Reuses or creates the AccountUser-bound Participant. `conflict`
//     surfaces when a legacy anonymous Participant claims the email;
//     the email-verification claim path (Commit 1 §6.10) binds it once
//     ownership is proven.
//   • Prevents duplicate applications via a check-then-catch on the
//     `@@unique([participantId, type])` DB constraint.
//   • Refuses to overwrite an existing non-CANCELLED status (never
//     `CONFIRMED → REGISTERED`).
//   • Refuses to overwrite an existing non-NULL `participationChoice`.
//   • Ensures a badge (idempotent + non-fatal).
//   • Queues the role-specific email exactly once via
//     `idempotencyKey = application:<participantId>:<type>`.

// Kept identical to the speaker flow — same rationale.
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

export type ProfessionalRegisterState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

// Shape returned by role-specific validators — kept minimal so a new
// professional role only needs to project its fields into this common
// shape rather than change the kernel.
export type ProfessionalDetails = {
  organization?: string;
  website?: string;
  industry?: string;
  position?: string;
  linkedin?: string;
  photoUrl?: string;
  logoUrl?: string;
  message?: string;
  details: Record<string, unknown>;
};

export type SubmitProfessionalInput = {
  type: ApplicationType;
  // Slug used for /register/<slug>, ?type=<slug>, and next= param.
  slug: string;
  // Role-specific ParticipationChoice we stamp on Participant when the
  // choice is currently NULL. Never overwrites an existing choice.
  choice: ParticipationChoice;
  // Template key used by lib/email/triggers or the queue directly.
  emailTemplateKey: string;
  // Rate-limit budget per AccountUser (per 15-minute window).
  submitsPerAccount: number;
  // Zod-parsed, projected role details.
  data: ProfessionalDetails;
  // Contact completion — required only when the Participant is missing
  // its phone. The role page sends these when the user hasn't previously
  // supplied a phone.
  contactPhone?: string;
  contactCountry?: string;
  // Message the role page passes when the user isn't logged in yet —
  // guarantees the auth redirect keeps them on-flow.
  authNextPath: string;
};

/**
 * Kernel — every professional role calls this exactly once from its
 * server action. Never called from a client component.
 */
export async function submitProfessionalApplication(
  input: SubmitProfessionalInput
): Promise<ProfessionalRegisterState> {
  const account = await getCurrentAccount();
  if (!account) {
    redirect(`/auth?mode=register&next=${encodeURIComponent(input.authNextPath)}`);
  }

  const throttleKey = `register-${input.slug}:acct:${account.id}`;
  if (isBlocked(throttleKey, input.submitsPerAccount)) {
    return { status: "error", message: THROTTLED_MESSAGE };
  }
  record(throttleKey);

  const ensured = await ensureParticipantForAccount(account);
  if (ensured.kind === "no-event") {
    return {
      status: "error",
      message:
        "L'événement n'est pas encore configuré. Contactez l'organisation."
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

  // Contact-completion — only required when Participant.phone is missing.
  const contactParse = contactSchema.safeParse({
    phone: input.contactPhone || participant.phone || "",
    country: input.contactCountry || participant.country || "Algérie"
  });
  if (!participant.phone && !contactParse.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of contactParse.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message:
        "Merci de renseigner un numéro de téléphone pour finaliser votre candidature.",
      fieldErrors
    };
  }
  const contact = contactParse.success ? contactParse.data : null;
  const finalPhone = participant.phone || contact?.phone || "";
  const finalCountry = contact?.country || participant.country;

  // Better UX than a raw P2002 — but the DB unique constraint is the
  // authority. If the row already exists, the user sees the existing
  // application state on the role's page (page-level guard).
  const existing = await prisma.application.findFirst({
    where: { participantId: participant.id, type: input.type },
    select: { id: true }
  });
  if (existing) {
    return {
      status: "error",
      message:
        "Une candidature de ce type existe déjà pour votre inscription. Consultez son statut depuis votre espace personnel."
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.application.create({
        data: {
          eventId: participant.eventId,
          participantId: participant.id,
          type: input.type,
          status: "RECEIVED",
          firstName: participant.firstName,
          lastName: participant.lastName,
          email: participant.email,
          phone: finalPhone,
          country: finalCountry,
          position: input.data.position ?? null,
          organization:
            input.data.organization ?? participant.organization ?? null,
          website: input.data.website ?? null,
          industry: input.data.industry ?? null,
          photoUrl: input.data.photoUrl ?? null,
          logoUrl: input.data.logoUrl ?? null,
          linkedin: input.data.linkedin ?? null,
          message: input.data.message ?? null,
          details: input.data.details as Prisma.InputJsonValue
        }
      });

      // participationChoice — only stamp when currently NULL. Never
      // overwrites a prior choice (e.g. VISITOR + a new SPEAKER
      // application keeps VISITOR — the SPEAKER row is the authoritative
      // professional signal).
      //
      // status — always REGISTERED, but never downgrade from CONFIRMED
      // and never resurrect from CANCELLED. The `where.status.in` guard
      // is the safety rail.
      await tx.participant.updateMany({
        where: {
          id: participant.id,
          status: { in: ["PENDING", "REGISTERED"] }
        },
        data: { status: "REGISTERED" }
      });
      await tx.participant.updateMany({
        where: { id: participant.id, participationChoice: null },
        data: { participationChoice: input.choice }
      });

      if (contact?.phone && !participant.phone) {
        await tx.participant.updateMany({
          where: { id: participant.id, phone: null },
          data: { phone: contact.phone }
        });
      }
      if (
        contact?.country &&
        participant.country === "Algérie" &&
        contact.country !== "Algérie"
      ) {
        await tx.participant.updateMany({
          where: { id: participant.id, country: "Algérie" },
          data: { country: contact.country }
        });
      }
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      // Racing double-submit — the winning row is already in place.
      // Ensure the badge and redirect to success.
      await ensureActiveBadge(participant.id);
      redirect(`/register/complete?type=${input.slug}`);
    }
    throw err;
  }

  await ensureActiveBadge(participant.id);

  await queueTemplatedEmail({
    templateKey: input.emailTemplateKey,
    to: participant.email,
    toName: `${participant.firstName} ${participant.lastName}`,
    idempotencyKey: `application:${participant.id}:${input.type}`,
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

  redirect(`/register/complete?type=${input.slug}`);
}

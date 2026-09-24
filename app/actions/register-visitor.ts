"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getCurrentAccount } from "@/lib/account/auth";
import { ensureParticipantForAccount, ensureActiveBadge } from "@/lib/register/participant";
import { queueTemplatedEmail, EVENT_VARS } from "@/lib/email/queue";
import { isBlocked, record, THROTTLED_MESSAGE } from "@/lib/rate-limit";

// Per-account throttle. Registration completion is idempotent, but a
// logged-in attacker could hammer the endpoint to burn DB writes / email
// queue enqueues. 20/15 min matches the intent of the existing login &
// register buckets (defence-in-depth over the DB uniqueness constraint).
const VISITOR_SUBMITS_PER_ACCOUNT = 20;

// Visitor role — server action for the /register/visitor flow.
//
// Contract:
//   • Requires an authenticated AccountUser. If missing, redirect back to
//     the flow entry with a `next=` so the user is bounced through auth
//     and returns automatically.
//   • Reuses the AccountUser's Participant (or creates it).
//   • Stamps participationChoice=VISITOR, back-fills phone/country if the
//     Participant was missing them. Uses `updateMany` with a WHERE
//     predicate so two concurrent submits can't fight over the value.
//   • Ensures the participant has an ACTIVE BadgeCredential.
//   • Queues the visitor-received email (idempotent via the queue's
//     idempotencyKey semantics; the queue de-dupes on repeat).
//   • On success, redirects to /register/complete?type=visitor.

const phoneField = z
  .string()
  .trim()
  .min(6, "Téléphone invalide")
  .max(24)
  .regex(/^[+0-9\s().\-]+$/, "Téléphone invalide");

const visitorSchema = z.object({
  phone: phoneField,
  country: z.string().trim().min(1, "Pays requis").max(80).default("Algérie"),
  organization: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
  jobTitle: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined))
});

export type VisitorRegisterState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

function getStr(fd: FormData, key: string, dflt = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : dflt;
}

export async function completeVisitorRegistration(
  _prev: VisitorRegisterState,
  formData: FormData
): Promise<VisitorRegisterState> {
  // Auth is the identity — never trust a client-supplied participantId.
  const account = await getCurrentAccount();
  if (!account) {
    redirect("/auth?mode=register&next=/register/visitor");
  }

  const throttleKey = `register-visitor:acct:${account.id}`;
  if (isBlocked(throttleKey, VISITOR_SUBMITS_PER_ACCOUNT)) {
    return { status: "error", message: THROTTLED_MESSAGE };
  }
  record(throttleKey);

  const parsed = visitorSchema.safeParse({
    phone: getStr(formData, "phone"),
    country: getStr(formData, "country") || "Algérie",
    organization: getStr(formData, "organization"),
    jobTitle: getStr(formData, "jobTitle")
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors
    };
  }
  const data = parsed.data;

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

  // Stamp participationChoice + status. participationChoice never
  // overwrites an existing non-VISITOR choice — a Participant who already
  // applied as a SPEAKER can also be a VISITOR (visitor is the "attend"
  // opportunity; SPEAKER is layered on top via Application). We only set
  // the choice when it is currently NULL or already VISITOR.
  await prisma.participant.updateMany({
    where: {
      id: participant.id,
      OR: [{ participationChoice: null }, { participationChoice: "VISITOR" }]
    },
    data: {
      participationChoice: "VISITOR",
      status: "REGISTERED"
    }
  });

  // Back-fills — only write when the target column is NULL / defaulted so
  // concurrent requests never overwrite a value the user did not intend to
  // change. `country` uses the default "Algérie" (never NULL in schema),
  // so we only overwrite when the current value is still the default.
  if (data.phone && !participant.phone) {
    await prisma.participant.updateMany({
      where: { id: participant.id, phone: null },
      data: { phone: data.phone }
    });
  }
  if (data.organization && !participant.organization) {
    await prisma.participant.updateMany({
      where: { id: participant.id, organization: null },
      data: { organization: data.organization }
    });
  }
  if (data.jobTitle && !participant.jobTitle) {
    await prisma.participant.updateMany({
      where: { id: participant.id, jobTitle: null },
      data: { jobTitle: data.jobTitle }
    });
  }
  if (data.country && participant.country === "Algérie" && data.country !== "Algérie") {
    await prisma.participant.updateMany({
      where: { id: participant.id, country: "Algérie" },
      data: { country: data.country }
    });
  }

  await ensureActiveBadge(participant.id);

  // Confirmation email — idempotency key means repeated submits (e.g.
  // double-click) do not enqueue a second copy.
  await queueTemplatedEmail({
    templateKey: "registration-visitor-received",
    to: participant.email,
    toName: `${participant.firstName} ${participant.lastName}`,
    idempotencyKey: `visitor-registered:${participant.id}`,
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
  revalidatePath("/compte/badge");

  redirect("/register/complete?type=visitor");
}

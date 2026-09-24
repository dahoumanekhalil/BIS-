"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import {
  PaymentStatus,
  RegistrationStatus,
  RegistrationTier,
  RegistrationType
} from "@prisma/client";

const optionalTrimmed = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v.length === 0 ? null : v));

const nullableEnum = <T extends z.EnumLike>(e: T) =>
  z
    .string()
    .transform((v) => v.trim())
    .transform((v) => (v.length === 0 ? null : v))
    .refine(
      (v) => v == null || Object.values(e as Record<string, string>).includes(v),
      { message: "Valeur invalide" }
    )
    .transform((v) => v as z.infer<z.ZodNativeEnum<T>> | null);

const updateSchema = z.object({
  firstName: z.string().trim().min(1, "Prénom requis"),
  lastName: z.string().trim().min(1, "Nom requis"),
  email: z.string().trim().toLowerCase().email("Email invalide"),
  phone: z.string().trim().min(4, "Téléphone requis"),
  organization: optionalTrimmed,
  jobTitle: optionalTrimmed,
  country: z.string().trim().min(1, "Pays requis"),
  tier: nullableEnum(RegistrationTier),
  gate: optionalTrimmed,
  status: z.nativeEnum(RegistrationStatus),
  paymentStatus: z.nativeEnum(PaymentStatus),
  paymentAmount: z
    .string()
    .transform((v) => v.trim())
    .transform((v) => (v.length === 0 ? null : Number(v)))
    .refine((v) => v == null || (Number.isFinite(v) && v >= 0), {
      message: "Montant invalide"
    }),
  paymentRef: optionalTrimmed,
  ticketCode: optionalTrimmed,
  registrationType: z.nativeEnum(RegistrationType)
});

export type UpdateState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

export async function updateRegistrant(
  id: string,
  _prev: UpdateState,
  formData: FormData
): Promise<UpdateState> {
  const { user } = await requirePermission("registrants.edit");

  const raw = {
    firstName: String(formData.get("firstName") ?? ""),
    lastName: String(formData.get("lastName") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    organization: String(formData.get("organization") ?? ""),
    jobTitle: String(formData.get("jobTitle") ?? ""),
    country: String(formData.get("country") ?? "Algérie"),
    tier: String(formData.get("tier") ?? ""),
    gate: String(formData.get("gate") ?? ""),
    status: String(formData.get("status") ?? "REGISTERED"),
    paymentStatus: String(formData.get("paymentStatus") ?? "UNPAID"),
    paymentAmount: String(formData.get("paymentAmount") ?? ""),
    paymentRef: String(formData.get("paymentRef") ?? ""),
    ticketCode: String(formData.get("ticketCode") ?? ""),
    registrationType: String(formData.get("registrationType") ?? "ATTENDEE")
  };

  const parsed = updateSchema.safeParse(raw);
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

  const before = await prisma.participant.findUnique({ where: { id } });
  if (!before) {
    return { status: "error", message: "Inscrit introuvable." };
  }

  const data = parsed.data;
  // If paymentStatus flips to PAID and paidAt is empty, set it now.
  const paidAt =
    data.paymentStatus === PaymentStatus.PAID && !before.paidAt
      ? new Date()
      : data.paymentStatus !== PaymentStatus.PAID
        ? null
        : before.paidAt;

  try {
    await prisma.participant.update({
      where: { id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        organization: data.organization,
        jobTitle: data.jobTitle,
        country: data.country,
        tier: data.tier,
        gate: data.gate,
        status: data.status,
        paymentStatus: data.paymentStatus,
        paymentAmount: data.paymentAmount,
        paymentRef: data.paymentRef,
        ticketCode: data.ticketCode,
        registrationType: data.registrationType,
        paidAt
      }
    });
  } catch (e) {
    const err = e as { code?: string; meta?: { target?: string[] } };
    if (err.code === "P2002" && err.meta?.target?.includes("email")) {
      return {
        status: "error",
        message: "Un inscrit avec cet email existe déjà.",
        fieldErrors: { email: "Email déjà utilisé" }
      };
    }
    if (err.code === "P2002" && err.meta?.target?.includes("ticketCode")) {
      return {
        status: "error",
        message: "Ce code ticket est déjà attribué.",
        fieldErrors: { ticketCode: "Code déjà utilisé" }
      };
    }
    return {
      status: "error",
      message: "Impossible d'enregistrer les modifications."
    };
  }

  await audit({
    userId: user.id,
    action: "registrant.update",
    entity: "Participant",
    entityId: id,
    meta: {
      changes: diff(before, data)
    }
  });

  revalidatePath(`/admin/registrants/${id}`);
  revalidatePath(`/admin/registrants`);
  revalidatePath(`/admin/dashboard`);

  return {
    status: "success",
    message: "Modifications enregistrées."
  };
}

export async function deleteRegistrant(id: string) {
  const { user } = await requirePermission("registrants.delete");
  const before = await prisma.participant.findUnique({ where: { id } });
  if (!before) redirect("/admin/registrants");

  await prisma.participant.delete({ where: { id } });

  await audit({
    userId: user.id,
    action: "registrant.delete",
    entity: "Participant",
    entityId: id,
    meta: {
      snapshot: {
        firstName: before.firstName,
        lastName: before.lastName,
        email: before.email,
        tier: before.tier,
        paymentStatus: before.paymentStatus
      }
    }
  });

  revalidatePath(`/admin/registrants`);
  revalidatePath(`/admin/dashboard`);
  redirect("/admin/registrants?deleted=1");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function diff(before: Record<string, any>, after: Record<string, any>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    const b = before[k] instanceof Date ? before[k].toISOString() : before[k];
    const a = after[k];
    if (String(b ?? "") !== String(a ?? "")) {
      changes[k] = { from: b ?? null, to: a ?? null };
    }
  }
  return changes;
}

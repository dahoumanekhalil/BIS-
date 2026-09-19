"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { ApplicationStatus } from "@prisma/client";

const schema = z.object({
  status: z.nativeEnum(ApplicationStatus),
  reviewNotes: z.string().trim().max(4000).optional().or(z.literal(""))
});

export type UpdateApplicationState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function updateApplication(
  applicationId: string,
  _prev: UpdateApplicationState,
  formData: FormData
): Promise<UpdateApplicationState> {
  const { user } = await requirePermission("applications.manage");

  const parsed = schema.safeParse({
    status: String(formData.get("status") ?? ""),
    reviewNotes: String(formData.get("reviewNotes") ?? "")
  });
  if (!parsed.success) {
    return { status: "error", message: "Données invalides." };
  }

  const existing = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, status: true }
  });
  if (!existing) {
    return { status: "error", message: "Candidature introuvable." };
  }

  const nextStatus = parsed.data.status;
  const notes = parsed.data.reviewNotes;

  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: {
      status: nextStatus,
      reviewNotes: notes || null,
      reviewedById: user.id,
      reviewedAt: new Date()
    },
    select: { id: true, status: true, type: true }
  });

  await audit({
    userId: user.id,
    action: "application.update",
    entity: "Application",
    entityId: updated.id,
    meta: {
      from: existing.status,
      to: updated.status,
      type: updated.type
    }
  });

  revalidatePath(`/admin/applications`);
  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath(`/admin/audit-log`);

  return { status: "success", message: "Candidature mise à jour." };
}

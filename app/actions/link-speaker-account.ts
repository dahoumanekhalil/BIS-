"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";

export type LinkSpeakerResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function linkSpeakerAccount(
  speakerId: string,
  adminUserId: string | null
): Promise<LinkSpeakerResult> {
  const admin = await requirePermission("speakers.manage");

  if (!speakerId) {
    return { status: "error", message: "ID intervenant manquant." };
  }

  const speaker = await prisma.speaker.findUnique({
    where: { id: speakerId },
    select: { id: true, fullName: true, adminUserId: true },
  });

  if (!speaker) {
    return { status: "error", message: "Intervenant introuvable." };
  }

  // Prevent self-linking
  if (adminUserId === admin.user.id) {
    return {
      status: "error",
      message: "Vous ne pouvez pas lier votre propre compte à un intervenant.",
    };
  }

  // If linking to a user, verify the user exists and isn't already linked to another speaker
  if (adminUserId) {
    const user = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { id: true, name: true, speaker: { select: { id: true, fullName: true } } },
    });

    if (!user) {
      return { status: "error", message: "Utilisateur introuvable." };
    }

    if (user.speaker && user.speaker.id !== speakerId) {
      return {
        status: "error",
        message: `Cet utilisateur est déjà lié à l'intervenant "${user.speaker.fullName}".`,
      };
    }
  }

  try {
    await prisma.speaker.update({
      where: { id: speakerId },
      data: { adminUserId },
    });
  } catch (err: unknown) {
    // Handle race condition on unique constraint (P2002)
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      return {
        status: "error",
        message:
          "Cet utilisateur vient d'être lié à un autre intervenant. Veuillez actualiser la page.",
      };
    }
    throw err;
  }

  await audit({
    userId: admin.user.id,
    action: "speaker.linkAccount",
    entity: "Speaker",
    entityId: speakerId,
    meta: {
      speakerName: speaker.fullName,
      linkedUserId: adminUserId,
      previousUserId: speaker.adminUserId,
    },
  });

  revalidatePath("/admin/(protected)/speakers");
  return {
    status: "success",
    message: adminUserId
      ? "Compte lié avec succès."
      : "Lien supprimé avec succès.",
  };
}
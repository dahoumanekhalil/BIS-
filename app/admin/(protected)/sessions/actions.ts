"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import {
  parseSessionInput,
  sessionRawFromFormData,
  slugifyTitle,
  type SessionInput
} from "@/lib/admin/session-input";

export type SessionFormState =
  | { status: "idle" }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

export type DeleteSessionResult =
  | { ok: true }
  | { ok: false; message: string };

// Error class name only — never the payload or the Prisma message.
function logFailure(op: string, err: unknown) {
  console.error(`[sessions] ${op} failed`, err instanceof Error ? err.name : "unknown");
}

const GENERIC_ERROR = "Enregistrement impossible. Réessayez dans un instant.";

function revalidateEverywhere() {
  revalidatePath("/admin/sessions");
  // The public site reads the same Session rows.
  revalidatePath("/");
  revalidatePath("/programme");
  revalidatePath("/espaces");
}

async function ensureUniqueSlug(base: string): Promise<string> {
  const root = base || `session-${Date.now()}`;
  let slug = root;
  for (let i = 2; i < 200; i += 1) {
    const taken = await prisma.session.findUnique({
      where: { slug },
      select: { id: true }
    });
    if (!taken) return slug;
    slug = `${root}-${i}`;
  }
  return `${root}-${Date.now()}`;
}

/** Checks that the referenced space / speakers exist (ids come from a form). */
async function validateReferences(
  data: SessionInput
): Promise<Record<string, string> | null> {
  const errors: Record<string, string> = {};
  if (data.spaceId) {
    const space = await prisma.space.findUnique({
      where: { id: data.spaceId },
      select: { id: true }
    });
    if (!space) errors.spaceId = "Espace introuvable";
  }
  if (data.speakerIds.length > 0) {
    const found = await prisma.speaker.count({
      where: { id: { in: data.speakerIds } }
    });
    if (found !== data.speakerIds.length) {
      errors.speakerIds = "Un intervenant sélectionné n'existe plus";
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/* --------------------------------- CREATE --------------------------------- */

export async function createSession(
  _prev: SessionFormState,
  formData: FormData
): Promise<SessionFormState> {
  const { user } = await requirePermission("sessions.manage");

  const parsed = parseSessionInput(sessionRawFromFormData(formData));
  if (!parsed.ok) {
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: parsed.fieldErrors
    };
  }
  const data = parsed.data;

  const refErrors = await validateReferences(data);
  if (refErrors) {
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: refErrors
    };
  }

  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (!event) {
    return {
      status: "error",
      message:
        "Aucun événement n'est configuré : impossible d'ajouter une session."
    };
  }

  let createdId: string;
  try {
    const slug = await ensureUniqueSlug(slugifyTitle(data.title));
    const created = await prisma.session.create({
      data: {
        eventId: event.id,
        slug,
        title: data.title,
        summary: data.summary,
        type: data.type,
        category: data.category,
        startsAt: data.startsAt,
        durationMin: data.durationMin,
        stage: data.stage,
        spaceId: data.spaceId,
        isHighlighted: data.isHighlighted,
        order: data.order,
        speakers: {
          create: data.speakerIds.map((speakerId) => ({
            speakerId,
            role: "SPEAKER"
          }))
        }
      },
      select: { id: true }
    });
    createdId = created.id;
  } catch (err) {
    logFailure("create", err);
    return { status: "error", message: GENERIC_ERROR };
  }

  await audit({
    userId: user.id,
    action: "session.create",
    entity: "Session",
    entityId: createdId,
    meta: {
      title: data.title,
      type: data.type,
      startsAt: data.startsAt.toISOString(),
      speakers: data.speakerIds.length
    }
  });

  revalidateEverywhere();
  redirect("/admin/sessions?flash=created");
}

/* --------------------------------- UPDATE --------------------------------- */

export async function updateSession(
  id: string,
  _prev: SessionFormState,
  formData: FormData
): Promise<SessionFormState> {
  const { user } = await requirePermission("sessions.manage");

  const before = await prisma.session.findUnique({
    where: { id },
    select: {
      id: true,
      speakers: { select: { speakerId: true, role: true } }
    }
  });
  if (!before) return { status: "error", message: "Session introuvable." };

  const parsed = parseSessionInput(sessionRawFromFormData(formData));
  if (!parsed.ok) {
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: parsed.fieldErrors
    };
  }
  const data = parsed.data;

  const refErrors = await validateReferences(data);
  if (refErrors) {
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: refErrors
    };
  }

  // Keep a speaker's existing role (e.g. MODERATOR); new ones are SPEAKER.
  const roleBySpeaker = new Map(
    before.speakers.map((s) => [s.speakerId, s.role])
  );

  try {
    // The slug is intentionally left unchanged so existing links keep working.
    await prisma.$transaction([
      prisma.session.update({
        where: { id },
        data: {
          title: data.title,
          summary: data.summary,
          type: data.type,
          category: data.category,
          startsAt: data.startsAt,
          durationMin: data.durationMin,
          stage: data.stage,
          spaceId: data.spaceId,
          isHighlighted: data.isHighlighted,
          order: data.order
        }
      }),
      prisma.sessionSpeaker.deleteMany({ where: { sessionId: id } }),
      prisma.sessionSpeaker.createMany({
        data: data.speakerIds.map((speakerId) => ({
          sessionId: id,
          speakerId,
          role: roleBySpeaker.get(speakerId) ?? "SPEAKER"
        }))
      })
    ]);
  } catch (err) {
    logFailure("update", err);
    return { status: "error", message: GENERIC_ERROR };
  }

  await audit({
    userId: user.id,
    action: "session.update",
    entity: "Session",
    entityId: id,
    meta: {
      title: data.title,
      type: data.type,
      startsAt: data.startsAt.toISOString(),
      speakers: data.speakerIds.length
    }
  });

  revalidateEverywhere();
  redirect("/admin/sessions?flash=updated");
}

/* --------------------------------- DELETE --------------------------------- */

export async function deleteSession(id: string): Promise<DeleteSessionResult> {
  const { user } = await requirePermission("sessions.manage");

  const before = await prisma.session.findUnique({
    where: { id },
    select: { id: true, title: true, type: true, startsAt: true }
  });
  if (!before) return { ok: false, message: "Session introuvable." };

  try {
    // SessionSpeaker rows are removed by the FK's ON DELETE CASCADE.
    await prisma.session.delete({ where: { id } });
  } catch (err) {
    logFailure("delete", err);
    return { ok: false, message: "Suppression impossible. Réessayez." };
  }

  await audit({
    userId: user.id,
    action: "session.delete",
    entity: "Session",
    entityId: id,
    meta: {
      title: before.title,
      type: before.type,
      startsAt: before.startsAt.toISOString()
    }
  });

  revalidateEverywhere();
  return { ok: true };
}

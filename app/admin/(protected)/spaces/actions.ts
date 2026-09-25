"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AccessPointType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import {
  activitiesSchema,
  exhibitorsSchema,
  topicsSchema
} from "@/lib/admin/space-content";

// Phase 17 — Spaces Management server actions.
//
// Every action follows the SAME security shape used by Phase 7 / 8 /
// 10 / 11 / 13:
//
//   1. requirePermission("settings.manage")   ← actor is session-derived
//   2. Zod-parse inputs                        ← reject malformed
//   3. Server-side guards                      ← e.g. NOOP short-circuit,
//                                                  duplicate-team check
//   4. Prisma mutation                         ← additive fields only
//   5. audit({...})                            ← one row per real change
//   6. revalidatePath(...)                     ← UI reflects new state
//
// Business rules preserved unchanged (per Phase 17 brief):
//   • AccessPoint.type is create-only. No `updateType` export exists.
//   • Slug rename refused when a CheckIn already references the point
//     (same guard as Phase 8).
//   • Deletion refused when CheckIn or ParticipantAccess rows exist
//     (same guard as Phase 8).
//   • active=false is the safe operational off-switch.
//   • Team membership is a metadata association only — the Phase 3
//     type-level RBAC (`access.validate.main` / `.room`) remains the
//     server-side scanner gate. See master doc §Phase 17 for the
//     deferred per-space authorisation option.

const idSchema = z.string().trim().min(10).max(64);
const nameSchema = z.string().trim().min(1, "Nom requis").max(80);
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Slug requis")
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: minuscules, chiffres, tirets");
const orderSchema = z.coerce.number().int().min(0).max(999);
const typeSchema = z.nativeEnum(AccessPointType);
const descriptionSchema = z
  .string()
  .trim()
  .max(4000)
  .optional()
  .transform((s) => (s && s.length > 0 ? s : null));

const REVALIDATE_ROOTS = ["/admin/spaces", "/admin/access-points"];
function revalidate(slug?: string) {
  for (const p of REVALIDATE_ROOTS) revalidatePath(p);
  if (slug) revalidatePath(`/admin/spaces/${slug}`);
}

// Uniform result shape used by every action that a client component
// consumes via `useTransition`.
type Result<T = undefined> =
  | (T extends undefined
      ? { ok: true }
      : { ok: true; data: T })
  | { ok: false; message: string };

// ─── create ──────────────────────────────────────────────────────────────
export type CreateSpaceResult =
  | { ok: true; slug: string }
  | { ok: false; message: string };

export async function createSpaceAction(
  formData: FormData
): Promise<CreateSpaceResult> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({
      name: nameSchema,
      slug: slugSchema,
      type: typeSchema,
      order: orderSchema.default(0),
      description: descriptionSchema
    })
    .safeParse({
      name: formData.get("name"),
      slug: formData.get("slug"),
      type: formData.get("type"),
      order: formData.get("order") ?? "0",
      description: formData.get("description")
    });
  if (!parsed.success) {
    return {
      ok: false,
      message:
        parsed.error.issues[0]?.message ?? "Champ invalide."
    };
  }
  const { name, slug, type, order, description } = parsed.data;

  try {
    const created = await prisma.accessPoint.create({
      data: {
        name,
        slug,
        type,
        order,
        description
      },
      select: { id: true, slug: true }
    });
    await audit({
      userId: user.id,
      action: "space.create",
      entity: "AccessPoint",
      entityId: created.id,
      meta: { name, slug, type, order }
    });
    revalidate(created.slug);
    return { ok: true, slug: created.slug };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { ok: false, message: "Ce slug est déjà utilisé." };
    }
    throw err;
  }
}

// ─── update name ─────────────────────────────────────────────────────────
export async function updateSpaceNameAction(
  id: string,
  name: string
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({ id: idSchema, name: nameSchema })
    .safeParse({ id, name });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "" };
  }
  const point = await prisma.accessPoint.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, name: true, slug: true }
  });
  if (!point) return { ok: false, message: "Espace introuvable." };
  if (point.name === parsed.data.name) return { ok: true }; // NOOP

  await prisma.accessPoint.update({
    where: { id: point.id },
    data: { name: parsed.data.name }
  });
  await audit({
    userId: user.id,
    action: "space.rename",
    entity: "AccessPoint",
    entityId: point.id,
    meta: { before: point.name, after: parsed.data.name }
  });
  revalidate(point.slug);
  return { ok: true };
}

// ─── update slug ─────────────────────────────────────────────────────────
// Refused when CheckIn rows exist — Phase 8 policy.
export async function updateSpaceSlugAction(
  id: string,
  slug: string
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({ id: idSchema, slug: slugSchema })
    .safeParse({ id, slug });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "" };
  }
  const point = await prisma.accessPoint.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      slug: true,
      _count: { select: { checkIns: true } }
    }
  });
  if (!point) return { ok: false, message: "Espace introuvable." };
  if (point.slug === parsed.data.slug) return { ok: true }; // NOOP
  if (point._count.checkIns > 0) {
    return {
      ok: false,
      message:
        "Slug verrouillé : des check-ins référencent cet espace. Créez un nouvel espace au lieu de renommer."
    };
  }

  try {
    await prisma.accessPoint.update({
      where: { id: point.id },
      data: { slug: parsed.data.slug }
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { ok: false, message: "Ce slug est déjà utilisé." };
    }
    throw err;
  }
  await audit({
    userId: user.id,
    action: "space.slug",
    entity: "AccessPoint",
    entityId: point.id,
    meta: { before: point.slug, after: parsed.data.slug }
  });
  revalidate(parsed.data.slug);
  return { ok: true };
}

// ─── update description ──────────────────────────────────────────────────
export async function updateSpaceDescriptionAction(
  id: string,
  description: string
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({ id: idSchema, description: descriptionSchema })
    .safeParse({ id, description });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "" };
  }
  const point = await prisma.accessPoint.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, slug: true, description: true }
  });
  if (!point) return { ok: false, message: "Espace introuvable." };
  const next = parsed.data.description ?? null;
  if ((point.description ?? null) === next) return { ok: true }; // NOOP

  await prisma.accessPoint.update({
    where: { id: point.id },
    data: { description: next }
  });
  await audit({
    userId: user.id,
    action: "space.description",
    entity: "AccessPoint",
    entityId: point.id,
    meta: { hadDescription: !!point.description, hasDescription: !!next }
  });
  revalidate(point.slug);
  return { ok: true };
}

// ─── update order ────────────────────────────────────────────────────────
export async function updateSpaceOrderAction(
  id: string,
  order: number
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({ id: idSchema, order: orderSchema })
    .safeParse({ id, order });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "" };
  }
  const point = await prisma.accessPoint.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, slug: true, order: true }
  });
  if (!point) return { ok: false, message: "Espace introuvable." };
  if (point.order === parsed.data.order) return { ok: true }; // NOOP

  await prisma.accessPoint.update({
    where: { id: point.id },
    data: { order: parsed.data.order }
  });
  await audit({
    userId: user.id,
    action: "space.reorder",
    entity: "AccessPoint",
    entityId: point.id,
    meta: { before: point.order, after: parsed.data.order }
  });
  revalidate(point.slug);
  return { ok: true };
}

// ─── activate / deactivate ───────────────────────────────────────────────
export async function toggleSpaceActiveAction(
  id: string,
  active: boolean
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return { ok: false, message: "Identifiant invalide." };
  }
  const point = await prisma.accessPoint.findUnique({
    where: { id: parsed.data },
    select: { id: true, slug: true, active: true }
  });
  if (!point) return { ok: false, message: "Espace introuvable." };
  if (point.active === active) return { ok: true }; // NOOP

  await prisma.accessPoint.update({
    where: { id: point.id },
    data: { active }
  });
  await audit({
    userId: user.id,
    action: active ? "space.activate" : "space.deactivate",
    entity: "AccessPoint",
    entityId: point.id,
    meta: { before: point.active, after: active }
  });
  revalidate(point.slug);
  return { ok: true };
}

// ─── delete ──────────────────────────────────────────────────────────────
// Same policy as Phase 8: refuse when CheckIn or ParticipantAccess
// references exist. Deactivation is the preferred safe path.
export async function deleteSpaceAction(id: string): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return { ok: false, message: "Identifiant invalide." };
  }
  const point = await prisma.accessPoint.findUnique({
    where: { id: parsed.data },
    select: {
      id: true,
      slug: true,
      name: true,
      _count: { select: { checkIns: true, permissions: true } }
    }
  });
  if (!point) return { ok: false, message: "Espace introuvable." };

  if (point._count.checkIns > 0 || point._count.permissions > 0) {
    return {
      ok: false,
      message:
        "Suppression refusée : des check-ins ou des permissions référencent cet espace. Désactivez-le à la place."
    };
  }

  await prisma.accessPoint.delete({ where: { id: point.id } });
  await audit({
    userId: user.id,
    action: "space.delete",
    entity: "AccessPoint",
    entityId: point.id,
    meta: { name: point.name, slug: point.slug }
  });
  revalidate();
  return { ok: true };
}

// ─── team: add member ────────────────────────────────────────────────────
// Enforces: target must be an existing ACTIVE AdminUser; no duplicate
// membership (composite PK prevents at DB, this returns a friendly
// error).
export async function addTeamMemberAction(
  accessPointId: string,
  adminUserId: string
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({ accessPointId: idSchema, adminUserId: idSchema })
    .safeParse({ accessPointId, adminUserId });
  if (!parsed.success) {
    return { ok: false, message: "Identifiant invalide." };
  }
  const [space, target] = await Promise.all([
    prisma.accessPoint.findUnique({
      where: { id: parsed.data.accessPointId },
      select: { id: true, slug: true }
    }),
    prisma.adminUser.findUnique({
      where: { id: parsed.data.adminUserId },
      select: { id: true, status: true, name: true }
    })
  ]);
  if (!space) return { ok: false, message: "Espace introuvable." };
  if (!target) return { ok: false, message: "Utilisateur introuvable." };
  if (target.status !== "ACTIVE") {
    return { ok: false, message: "Utilisateur inactif — non éligible." };
  }
  const existing = await prisma.accessPointTeamMember.findUnique({
    where: {
      accessPointId_adminUserId: {
        accessPointId: space.id,
        adminUserId: target.id
      }
    },
    select: { accessPointId: true }
  });
  if (existing) {
    return { ok: false, message: "Ce membre est déjà dans l'équipe." };
  }

  await prisma.accessPointTeamMember.create({
    data: {
      accessPointId: space.id,
      adminUserId: target.id,
      assignedById: user.id
    }
  });
  await audit({
    userId: user.id,
    action: "space.team.add",
    entity: "AccessPoint",
    entityId: space.id,
    meta: { adminUserId: target.id }
  });
  revalidate(space.slug);
  return { ok: true };
}

// ─── team: remove member ─────────────────────────────────────────────────
// Does NOT touch AdminUser (never deletes an account). Only removes
// the join row.
export async function removeTeamMemberAction(
  accessPointId: string,
  adminUserId: string
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({ accessPointId: idSchema, adminUserId: idSchema })
    .safeParse({ accessPointId, adminUserId });
  if (!parsed.success) {
    return { ok: false, message: "Identifiant invalide." };
  }
  const space = await prisma.accessPoint.findUnique({
    where: { id: parsed.data.accessPointId },
    select: { id: true, slug: true }
  });
  if (!space) return { ok: false, message: "Espace introuvable." };

  const existing = await prisma.accessPointTeamMember.findUnique({
    where: {
      accessPointId_adminUserId: {
        accessPointId: space.id,
        adminUserId: parsed.data.adminUserId
      }
    },
    select: { accessPointId: true }
  });
  if (!existing) return { ok: true }; // NOOP (already removed)

  await prisma.accessPointTeamMember.delete({
    where: {
      accessPointId_adminUserId: {
        accessPointId: space.id,
        adminUserId: parsed.data.adminUserId
      }
    }
  });
  await audit({
    userId: user.id,
    action: "space.team.remove",
    entity: "AccessPoint",
    entityId: space.id,
    meta: { adminUserId: parsed.data.adminUserId }
  });
  revalidate(space.slug);
  return { ok: true };
}

// ─── content: activities / topics / exhibitors ───────────────────────────
// One action per list. Each replaces the entire array atomically after
// Zod validation. NOOP if the payload is byte-identical to what's stored.

async function replaceContent(
  id: string,
  field: "activities" | "topics" | "exhibitors",
  value: unknown,
  userId: string
): Promise<Result> {
  const point = await prisma.accessPoint.findUnique({
    where: { id },
    select: { id: true, slug: true, activities: true, topics: true, exhibitors: true }
  });
  if (!point) return { ok: false, message: "Espace introuvable." };
  const beforeJson = JSON.stringify(point[field] ?? []);
  const afterJson = JSON.stringify(value);
  if (beforeJson === afterJson) return { ok: true }; // NOOP

  await prisma.accessPoint.update({
    where: { id: point.id },
    data: { [field]: value as Prisma.InputJsonValue }
  });
  await audit({
    userId,
    action: `space.content.${field}`,
    entity: "AccessPoint",
    entityId: point.id,
    meta: {
      before: JSON.parse(beforeJson),
      after: JSON.parse(afterJson)
    }
  });
  revalidate(point.slug);
  return { ok: true };
}

export async function updateSpaceActivitiesAction(
  id: string,
  activities: unknown
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: "Identifiant invalide." };
  const parsed = activitiesSchema.safeParse(activities);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "" };
  }
  return replaceContent(parsedId.data, "activities", parsed.data, user.id);
}

export async function updateSpaceTopicsAction(
  id: string,
  topics: unknown
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: "Identifiant invalide." };
  const parsed = topicsSchema.safeParse(topics);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "" };
  }
  return replaceContent(parsedId.data, "topics", parsed.data, user.id);
}

export async function updateSpaceExhibitorsAction(
  id: string,
  exhibitors: unknown
): Promise<Result> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: "Identifiant invalide." };
  const parsed = exhibitorsSchema.safeParse(exhibitors);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "" };
  }
  return replaceContent(parsedId.data, "exhibitors", parsed.data, user.id);
}

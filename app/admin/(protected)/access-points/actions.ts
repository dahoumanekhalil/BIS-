"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AccessPointType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";

// ─── Shared shapes ───────────────────────────────────────────────────────
//
// AUTHORIZATION MODEL (uniform across every mutating action):
//   • Read on `/admin/access-points` is gated by `access.view` at the page.
//   • Every mutation here requires `settings.manage` — which is held by
//     SUPER_ADMIN + ADMIN today. REGISTRATION_MANAGER has `access.view`
//     but NOT `settings.manage`, so they see the list read-only.
//   • Actor is the current admin session; no field is read from the client.
//
// GUARDS enforced server-side (UI mirrors these for UX, but the truth is
// here):
//   • Slug rename is refused when ANY CheckIn references the point.
//     Slugs land in scanner URLs in Phase 9 (/admin/scan/[slug]) and in
//     paper printouts of scan reports.
//   • Type is CREATE-ONLY. Never editable — changing MAIN_ENTRANCE ↔ ROOM
//     silently flips validator behavior for every historical grant.
//   • Delete is refused when ANY CheckIn OR ParticipantAccess references
//     the point. Deactivation (`active=false`) is the safe operational
//     off-switch and preserves every linked row.
//   • Reactivating a deactivated point is always allowed.

const idSchema = z.string().trim().min(10).max(64);
const nameSchema = z
  .string()
  .trim()
  .min(1, "Nom requis")
  .max(80, "Nom trop long");
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Slug requis")
  .max(48, "Slug trop long")
  // URL-safe subset: lowercase letters, digits, hyphen. Anchored.
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: minuscules, chiffres, tirets");
const orderSchema = z.coerce.number().int().min(0).max(999);
const typeSchema = z.nativeEnum(AccessPointType);

const REVALIDATE_PATHS = ["/admin/access-points"];

function revalidate() {
  for (const p of REVALIDATE_PATHS) revalidatePath(p);
}

// ─── create ──────────────────────────────────────────────────────────────
//
// The six seeded points cover today's venue, but the admin may need to
// add a room later. Slug uniqueness is enforced by the DB (@unique) —
// we surface P2002 as a friendly error.
export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

export async function createAccessPointAction(
  formData: FormData
): Promise<CreateResult> {
  const { user } = await requirePermission("settings.manage");
  const parsed = z
    .object({
      name: nameSchema,
      slug: slugSchema,
      type: typeSchema,
      order: orderSchema.default(0)
    })
    .safeParse({
      name: formData.get("name"),
      slug: formData.get("slug"),
      type: formData.get("type"),
      order: formData.get("order") ?? "0"
    });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((i) => i.message).join(" · ")
    };
  }
  const { name, slug, type, order } = parsed.data;

  try {
    const created = await prisma.accessPoint.create({
      data: { name, slug, type, order, active: true },
      select: { id: true }
    });
    await audit({
      userId: user.id,
      action: "access-point.create",
      entity: "AccessPoint",
      entityId: created.id,
      meta: { after: { name, slug, type, order } }
    });
    revalidate();
    return { ok: true, id: created.id };
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

// ─── update label (name) ─────────────────────────────────────────────────
//
// Label is always editable — it is display-only. No CheckIn or
// ParticipantAccess row references it. Safe to rename freely.
export type UpdateResult =
  | { ok: true }
  | { ok: false; message: string };

export async function updateAccessPointNameAction(
  id: string,
  name: string
): Promise<UpdateResult> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  const parsedName = nameSchema.safeParse(name);
  if (!parsedId.success || !parsedName.success) {
    return { ok: false, message: "Nom ou identifiant invalide." };
  }

  const before = await prisma.accessPoint.findUnique({
    where: { id: parsedId.data },
    select: { name: true }
  });
  if (!before) return { ok: false, message: "Point d'accès introuvable." };
  if (before.name === parsedName.data) {
    // NOOP — per Phase 7 hardening pattern, skip mutation + audit when
    // the desired state already matches.
    return { ok: true };
  }

  await prisma.accessPoint.update({
    where: { id: parsedId.data },
    data: { name: parsedName.data }
  });
  await audit({
    userId: user.id,
    action: "access-point.rename",
    entity: "AccessPoint",
    entityId: parsedId.data,
    meta: { before: { name: before.name }, after: { name: parsedName.data } }
  });
  revalidate();
  return { ok: true };
}

// ─── update slug ─────────────────────────────────────────────────────────
//
// Slug lives in scanner URLs (Phase 9) and printed operator materials.
// Once ANY CheckIn references this AccessPoint, the slug becomes
// operationally load-bearing and this action refuses to rename it. The
// caller (UI) should hide the rename control when checkInCount > 0.
export async function updateAccessPointSlugAction(
  id: string,
  slug: string
): Promise<UpdateResult> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedId.success || !parsedSlug.success) {
    return { ok: false, message: "Slug ou identifiant invalide." };
  }

  const before = await prisma.accessPoint.findUnique({
    where: { id: parsedId.data },
    select: { slug: true, _count: { select: { checkIns: true } } }
  });
  if (!before) return { ok: false, message: "Point d'accès introuvable." };
  if (before.slug === parsedSlug.data) return { ok: true };
  if (before._count.checkIns > 0) {
    return {
      ok: false,
      message:
        "Slug verrouillé : des check-ins existent déjà pour ce point. Désactivez-le et créez-en un nouveau."
    };
  }

  try {
    await prisma.accessPoint.update({
      where: { id: parsedId.data },
      data: { slug: parsedSlug.data }
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
    action: "access-point.slug",
    entity: "AccessPoint",
    entityId: parsedId.data,
    meta: {
      before: { slug: before.slug },
      after: { slug: parsedSlug.data }
    }
  });
  revalidate();
  return { ok: true };
}

// ─── update order ────────────────────────────────────────────────────────
export async function updateAccessPointOrderAction(
  id: string,
  order: number
): Promise<UpdateResult> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  const parsedOrder = orderSchema.safeParse(order);
  if (!parsedId.success || !parsedOrder.success) {
    return { ok: false, message: "Ordre ou identifiant invalide." };
  }

  const before = await prisma.accessPoint.findUnique({
    where: { id: parsedId.data },
    select: { order: true }
  });
  if (!before) return { ok: false, message: "Point d'accès introuvable." };
  if (before.order === parsedOrder.data) return { ok: true };

  await prisma.accessPoint.update({
    where: { id: parsedId.data },
    data: { order: parsedOrder.data }
  });
  await audit({
    userId: user.id,
    action: "access-point.reorder",
    entity: "AccessPoint",
    entityId: parsedId.data,
    meta: {
      before: { order: before.order },
      after: { order: parsedOrder.data }
    }
  });
  revalidate();
  return { ok: true };
}

// ─── toggle active ───────────────────────────────────────────────────────
//
// The safe operational off-switch. `active=false` hides the point from the
// attendee /compte/acces matrix AND causes the Phase 7 admin actions to
// refuse mutations against it (`assertActiveAccessPoint`), while retaining
// every ParticipantAccess and CheckIn row unchanged. Re-enabling is
// always allowed and undoes only the hide-and-refuse; nothing is lost.
export async function toggleAccessPointActiveAction(
  id: string,
  active: boolean
): Promise<UpdateResult> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: "Identifiant invalide." };
  const desired = Boolean(active);

  const before = await prisma.accessPoint.findUnique({
    where: { id: parsedId.data },
    select: { active: true }
  });
  if (!before) return { ok: false, message: "Point d'accès introuvable." };
  if (before.active === desired) return { ok: true };

  await prisma.accessPoint.update({
    where: { id: parsedId.data },
    data: { active: desired }
  });
  await audit({
    userId: user.id,
    action: desired ? "access-point.activate" : "access-point.deactivate",
    entity: "AccessPoint",
    entityId: parsedId.data,
    meta: {
      before: { active: before.active },
      after: { active: desired }
    }
  });
  revalidate();
  return { ok: true };
}

// ─── delete ──────────────────────────────────────────────────────────────
//
// Hard delete — cascades ParticipantAccess (wiping grant history for this
// point) and SetNulls CheckIn rows (orphaning the historical scan record's
// point reference). Refused if ANY link exists; deactivate instead.
export async function deleteAccessPointAction(
  id: string
): Promise<UpdateResult> {
  const { user } = await requirePermission("settings.manage");
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: "Identifiant invalide." };

  const before = await prisma.accessPoint.findUnique({
    where: { id: parsedId.data },
    select: {
      slug: true,
      name: true,
      type: true,
      _count: { select: { checkIns: true, permissions: true } }
    }
  });
  if (!before) return { ok: false, message: "Point d'accès introuvable." };

  if (before._count.checkIns > 0 || before._count.permissions > 0) {
    return {
      ok: false,
      message:
        "Suppression refusée : des historiques ou des permissions référencent ce point. Désactivez-le à la place."
    };
  }

  await prisma.accessPoint.delete({ where: { id: parsedId.data } });
  await audit({
    userId: user.id,
    action: "access-point.delete",
    entity: "AccessPoint",
    entityId: parsedId.data,
    meta: {
      before: { slug: before.slug, name: before.name, type: before.type }
    }
  });
  revalidate();
  return { ok: true };
}

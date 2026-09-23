"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { PartnerTier } from "@prisma/client";

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif"
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base || `sponsor-${Date.now()}`;
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await prisma.partner.findUnique({ where: { slug } });
    if (!existing || existing.id === excludeId) return slug;
    i += 1;
    slug = `${base}-${i}`;
  }
}

async function persistLogoFile(file: File, slug: string): Promise<string> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error(
      "Format non supporté (PNG, JPEG, WEBP, SVG ou GIF uniquement)."
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Fichier trop volumineux (max 2 Mo).");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  // Derive extension from the mime type — filenames can lie.
  const ext =
    file.type === "image/svg+xml"
      ? "svg"
      : (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
  const stamp = crypto.randomBytes(4).toString("hex");
  const filename = `${slug}-${stamp}.${ext}`;
  const dir = path.join(process.cwd(), "public", "sponsors");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), buffer);
  return `/sponsors/${filename}`;
}

function safeExternalUrl(url: string): string | null {
  const t = url.trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  return t;
}

/* --------------------------------- SCHEMAS --------------------------------- */

const baseSchema = z.object({
  name: z.string().trim().min(1, "Nom requis").max(120),
  tier: z.nativeEnum(PartnerTier),
  website: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v === "" || /^https?:\/\//i.test(v), {
      message: "L'URL doit commencer par http:// ou https://"
    })
    .transform((v) => (v === "" ? null : v)),
  logoUrl: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v === "" || /^https?:\/\//i.test(v) || v.startsWith("/"), {
      message: "URL invalide"
    })
    .transform((v) => (v === "" ? null : v))
});

export type SponsorState =
  | { status: "idle" }
  | { status: "success"; message: string; id?: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

/* --------------------------------- CREATE --------------------------------- */

export async function createSponsor(
  _prev: SponsorState,
  formData: FormData
): Promise<SponsorState> {
  const { user } = await requirePermission("sponsors.manage");

  const raw = {
    name: String(formData.get("name") ?? ""),
    tier: String(formData.get("tier") ?? "ECOSYSTEM"),
    website: String(formData.get("website") ?? ""),
    logoUrl: String(formData.get("logoUrl") ?? "")
  };
  const parsed = baseSchema.safeParse(raw);
  if (!parsed.success) {
    const fe: Record<string, string> = {};
    for (const i of parsed.error.issues) fe[i.path.join(".")] = i.message;
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: fe
    };
  }

  const event = await prisma.event.findFirst({
    where: { slug: "getplus-summit-2027" }
  });
  if (!event) {
    return { status: "error", message: "Événement introuvable." };
  }

  const slug = await ensureUniqueSlug(slugify(parsed.data.name));

  // Append to the end of its tier — user can drag to reorder afterwards.
  const last = await prisma.partner.findFirst({
    where: { tier: parsed.data.tier },
    orderBy: { order: "desc" },
    select: { order: true }
  });
  const nextOrder = (last?.order ?? -1) + 1;

  // Handle logo upload (takes precedence over URL).
  let finalLogoUrl = parsed.data.logoUrl;
  const uploaded = formData.get("logoFile");
  if (uploaded instanceof File && uploaded.size > 0) {
    try {
      finalLogoUrl = await persistLogoFile(uploaded, slug);
    } catch (e) {
      return {
        status: "error",
        message: (e as Error).message ?? "Impossible d'enregistrer le logo."
      };
    }
  }

  const created = await prisma.partner.create({
    data: {
      eventId: event.id,
      slug,
      name: parsed.data.name,
      tier: parsed.data.tier,
      order: nextOrder,
      website: safeExternalUrl(parsed.data.website ?? "") ?? null,
      logoUrl: finalLogoUrl
    }
  });

  await audit({
    userId: user.id,
    action: "sponsor.create",
    entity: "Partner",
    entityId: created.id,
    meta: { name: created.name, tier: created.tier }
  });

  revalidatePath("/admin/sponsors");
  redirect(`/admin/sponsors?created=${encodeURIComponent(created.name)}`);
}

/* --------------------------------- UPDATE --------------------------------- */

export async function updateSponsor(
  id: string,
  _prev: SponsorState,
  formData: FormData
): Promise<SponsorState> {
  const { user } = await requirePermission("sponsors.manage");

  const before = await prisma.partner.findUnique({ where: { id } });
  if (!before) return { status: "error", message: "Sponsor introuvable." };

  const raw = {
    name: String(formData.get("name") ?? ""),
    tier: String(formData.get("tier") ?? "ECOSYSTEM"),
    website: String(formData.get("website") ?? ""),
    logoUrl: String(formData.get("logoUrl") ?? "")
  };
  const parsed = baseSchema.safeParse(raw);
  if (!parsed.success) {
    const fe: Record<string, string> = {};
    for (const i of parsed.error.issues) fe[i.path.join(".")] = i.message;
    return {
      status: "error",
      message: "Merci de vérifier les informations saisies.",
      fieldErrors: fe
    };
  }

  // When tier changes, append to the end of the new tier.
  const finalTier = parsed.data.tier;
  let finalOrder = before.order;
  if (finalTier !== before.tier) {
    const last = await prisma.partner.findFirst({
      where: { tier: finalTier },
      orderBy: { order: "desc" },
      select: { order: true }
    });
    finalOrder = (last?.order ?? -1) + 1;
  }

  // If the name changed, regenerate slug (unique).
  const slug =
    parsed.data.name !== before.name
      ? await ensureUniqueSlug(slugify(parsed.data.name), before.id)
      : before.slug;

  let finalLogoUrl = parsed.data.logoUrl;
  const uploaded = formData.get("logoFile");
  if (uploaded instanceof File && uploaded.size > 0) {
    try {
      finalLogoUrl = await persistLogoFile(uploaded, slug);
    } catch (e) {
      return {
        status: "error",
        message: (e as Error).message ?? "Impossible d'enregistrer le logo."
      };
    }
  }

  await prisma.partner.update({
    where: { id },
    data: {
      slug,
      name: parsed.data.name,
      tier: finalTier,
      order: finalOrder,
      website: safeExternalUrl(parsed.data.website ?? "") ?? null,
      logoUrl: finalLogoUrl
    }
  });

  await audit({
    userId: user.id,
    action: "sponsor.update",
    entity: "Partner",
    entityId: id,
    meta: {
      name: parsed.data.name,
      tier: parsed.data.tier
    }
  });

  revalidatePath("/admin/sponsors");
  revalidatePath(`/admin/sponsors/${id}/edit`);
  redirect(`/admin/sponsors?updated=${encodeURIComponent(parsed.data.name)}`);
}

/* --------------------------------- REORDER --------------------------------- */

/**
 * Persist a new display order for a set of sponsors within a single tier.
 * Every id supplied MUST belong to the target tier — the server verifies
 * this to prevent a client from silently moving sponsors across tiers via
 * this endpoint.
 */
export async function reorderSponsors({
  tier,
  orderedIds
}: {
  tier: PartnerTier;
  orderedIds: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { user } = await requirePermission("sponsors.manage");

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return { ok: false, error: "Liste d'ordre vide." };
  }
  if (orderedIds.length > 200) {
    return { ok: false, error: "Trop d'éléments à réordonner." };
  }

  const targets = await prisma.partner.findMany({
    where: { id: { in: orderedIds }, tier },
    select: { id: true }
  });
  if (targets.length !== orderedIds.length) {
    return {
      ok: false,
      error: "Certains sponsors n'appartiennent pas à ce tier."
    };
  }

  // Persist as a single transaction so partial updates never leak.
  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.partner.update({ where: { id }, data: { order: i } })
    )
  );

  await audit({
    userId: user.id,
    action: "sponsor.reorder",
    entity: "Partner",
    meta: { tier, count: orderedIds.length }
  });

  revalidatePath("/admin/sponsors");
  return { ok: true };
}

/* --------------------------------- DELETE --------------------------------- */

export async function deleteSponsor(id: string) {
  const { user } = await requirePermission("sponsors.manage");
  const before = await prisma.partner.findUnique({ where: { id } });
  if (!before) redirect("/admin/sponsors");

  await prisma.partner.delete({ where: { id } });

  // Clean up locally-stored logo file — external URLs are left untouched.
  if (before.logoUrl && before.logoUrl.startsWith("/sponsors/")) {
    const abs = path.join(process.cwd(), "public", before.logoUrl.slice(1));
    await fs.unlink(abs).catch(() => undefined);
  }

  await audit({
    userId: user.id,
    action: "sponsor.delete",
    entity: "Partner",
    entityId: id,
    meta: { name: before.name, tier: before.tier }
  });

  revalidatePath("/admin/sponsors");
  redirect(`/admin/sponsors?deleted=${encodeURIComponent(before.name)}`);
}

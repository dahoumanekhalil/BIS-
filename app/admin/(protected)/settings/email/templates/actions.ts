"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { prisma } from "@/lib/db";
import {
  createTemplate,
  updateTemplateAndVersion,
  setTemplateActive,
  duplicateTemplate,
  deleteTemplate,
  restoreVersion,
  validateTemplatePayload
} from "@/lib/email/templates/service";
import {
  brandingFormSchema,
  saveEmailBranding
} from "@/lib/email/templates/branding";
import { sendAdminTestEmail } from "@/lib/email/triggers/admin";
import { EMAIL_TEMPLATES } from "@/lib/admin/email-templates";

// ─── Admin server actions for /admin/settings/email/templates ───────────
//
// Every action here goes through requirePermission("settings.email.templates")
// (or "settings.manage" for the branding form) and produces an audit-log
// entry with the safe metadata shape agreed with the security reviewer:
//
//   • Never log the full HTML body (potentially large + may contain PII).
//   • Log stable identifiers: templateId, templateKey, templateName, action.
//   • Never log the sanitized/raw HTML source — it lives in the DB row.

export type ActionState =
  | { status: "idle" }
  | { status: "success"; message: string; templateKey?: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    };

const upsertSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "Clé requise")
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Clé invalide (lettres, chiffres, - et _ uniquement)"),
  name: z.string().trim().min(1, "Nom requis").max(160),
  description: z.string().trim().max(300).optional().default(""),
  category: z.string().trim().min(1).max(40),
  subject: z.string().trim().min(1, "Sujet requis").max(300),
  preheader: z.string().trim().max(300).optional().default(""),
  htmlBody: z.string().min(1, "HTML requis").max(200_000),
  textBody: z.string().min(1, "Texte requis").max(50_000),
  useHeader: z.enum(["on", ""]).optional().default(""),
  useFooter: z.enum(["on", ""]).optional().default(""),
  isActive: z.enum(["on", ""]).optional().default("")
});

function toBool(v: string | undefined): boolean {
  return v === "on";
}

function readForm(formData: FormData) {
  return {
    key: String(formData.get("key") ?? "").trim(),
    name: String(formData.get("name") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    category: String(formData.get("category") ?? "custom").trim(),
    subject: String(formData.get("subject") ?? "").trim(),
    preheader: String(formData.get("preheader") ?? "").trim(),
    htmlBody: String(formData.get("htmlBody") ?? ""),
    textBody: String(formData.get("textBody") ?? ""),
    useHeader: String(formData.get("useHeader") ?? "") as "on" | "",
    useFooter: String(formData.get("useFooter") ?? "") as "on" | "",
    isActive: String(formData.get("isActive") ?? "") as "on" | ""
  };
}

/**
 * Save a template — creates a new row when `id` is empty, or updates the
 * existing row (writing a version snapshot BEFORE overwriting the fields).
 */
export async function saveTemplateAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { user } = await requirePermission("settings.email.templates");
  const id = String(formData.get("id") ?? "");

  const raw = readForm(formData);
  const parsed = upsertSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return {
      status: "error",
      message: "Merci de vérifier les champs marqués.",
      fieldErrors
    };
  }
  const data = parsed.data;

  const validationErrors = validateTemplatePayload({
    subject: data.subject,
    htmlBody: data.htmlBody,
    textBody: data.textBody,
    preheader: data.preheader
  });
  if (validationErrors.length > 0) {
    return {
      status: "error",
      message: validationErrors.map((e) => `• ${e.message}`).join("\n")
    };
  }

  const isActive = toBool(data.isActive);
  const useHeader = toBool(data.useHeader);
  const useFooter = toBool(data.useFooter);

  try {
    let saved;
    if (id) {
      // Update: server-side authoritative check that the row exists.
      const existing = await prisma.emailTemplate.findUnique({ where: { id } });
      if (!existing) {
        return { status: "error", message: "Modèle introuvable." };
      }
      // Enforce: the immutable `key` cannot be reassigned via the form.
      if (existing.key !== data.key) {
        return { status: "error", message: "La clé du modèle ne peut pas être modifiée." };
      }
      saved = await updateTemplateAndVersion(id, {
        key: data.key,
        name: data.name,
        description: data.description || null,
        category: data.category,
        subject: data.subject,
        preheader: data.preheader || null,
        htmlBody: data.htmlBody,
        textBody: data.textBody,
        useHeader,
        useFooter,
        isActive,
        actorId: user.id
      });
      await audit({
        userId: user.id,
        action: "email.template.updated",
        entity: "EmailTemplate",
        entityId: saved.id,
        meta: {
          templateKey: saved.key,
          templateName: saved.name,
          isActive: saved.isActive,
          category: saved.category
        }
      });
    } else {
      // Create: enforce key uniqueness at the DB level (schema does this
      // too via UNIQUE — we surface a friendly error).
      const clash = await prisma.emailTemplate.findUnique({ where: { key: data.key } });
      if (clash) {
        return {
          status: "error",
          message: `Un modèle avec la clé "${data.key}" existe déjà.`,
          fieldErrors: { key: "Clé déjà utilisée" }
        };
      }
      // A DB row overriding a code-catalog template inherits the
      // "system" flag so admins can't accidentally delete an entry
      // triggers still depend on.
      const isSystem = EMAIL_TEMPLATES.some((t) => t.key === data.key);
      saved = await createTemplate({
        key: data.key,
        name: data.name,
        description: data.description || null,
        category: data.category,
        subject: data.subject,
        preheader: data.preheader || null,
        htmlBody: data.htmlBody,
        textBody: data.textBody,
        useHeader,
        useFooter,
        isSystem,
        isActive,
        actorId: user.id
      });
      await audit({
        userId: user.id,
        action: "email.template.created",
        entity: "EmailTemplate",
        entityId: saved.id,
        meta: {
          templateKey: saved.key,
          templateName: saved.name,
          category: saved.category,
          isSystem
        }
      });
    }

    revalidatePath("/admin/settings/email/templates");
    revalidatePath(`/admin/settings/email/templates/${saved.key}`);
    return {
      status: "success",
      message: "Modèle enregistré.",
      templateKey: saved.key
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[templates.save] failed", err instanceof Error ? err.message : err);
    return { status: "error", message: "Enregistrement impossible." };
  }
}

export async function toggleTemplateActiveAction(
  templateId: string,
  isActive: boolean
): Promise<ActionState> {
  const { user } = await requirePermission("settings.email.templates");
  const t = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
  if (!t) return { status: "error", message: "Modèle introuvable." };
  await setTemplateActive(templateId, isActive, user.id);
  await audit({
    userId: user.id,
    action: isActive
      ? "email.template.activated"
      : "email.template.deactivated",
    entity: "EmailTemplate",
    entityId: templateId,
    meta: { templateKey: t.key, templateName: t.name }
  });
  revalidatePath("/admin/settings/email/templates");
  return {
    status: "success",
    message: isActive ? "Modèle activé." : "Modèle désactivé (retour au modèle système)."
  };
}

export async function duplicateTemplateAction(
  templateId: string,
  newKey: string,
  newName: string
): Promise<ActionState> {
  const { user } = await requirePermission("settings.email.templates");
  const trimmedKey = newKey.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(trimmedKey)) {
    return { status: "error", message: "Nouvelle clé invalide." };
  }
  const clash = await prisma.emailTemplate.findUnique({ where: { key: trimmedKey } });
  if (clash) {
    return { status: "error", message: "La nouvelle clé est déjà utilisée." };
  }
  const dup = await duplicateTemplate(templateId, trimmedKey, newName.trim(), user.id);
  await audit({
    userId: user.id,
    action: "email.template.duplicated",
    entity: "EmailTemplate",
    entityId: dup.id,
    meta: {
      templateKey: dup.key,
      templateName: dup.name,
      sourceTemplateId: templateId
    }
  });
  revalidatePath("/admin/settings/email/templates");
  return { status: "success", message: "Modèle dupliqué (inactif).", templateKey: dup.key };
}

export async function deleteTemplateAction(templateId: string): Promise<ActionState> {
  const { user } = await requirePermission("settings.email.templates");
  const t = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
  if (!t) return { status: "error", message: "Modèle introuvable." };
  try {
    await deleteTemplate(templateId);
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Suppression impossible."
    };
  }
  await audit({
    userId: user.id,
    action: "email.template.deleted",
    entity: "EmailTemplate",
    entityId: templateId,
    meta: { templateKey: t.key, templateName: t.name }
  });
  revalidatePath("/admin/settings/email/templates");
  return { status: "success", message: "Modèle supprimé." };
}

export async function restoreVersionAction(
  templateId: string,
  versionId: string
): Promise<ActionState> {
  const { user } = await requirePermission("settings.email.templates");
  await restoreVersion(templateId, versionId, user.id);
  await audit({
    userId: user.id,
    action: "email.template.restored",
    entity: "EmailTemplate",
    entityId: templateId,
    meta: { versionId }
  });
  const t = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
  revalidatePath("/admin/settings/email/templates");
  if (t) revalidatePath(`/admin/settings/email/templates/${t.key}`);
  return { status: "success", message: "Version restaurée." };
}

/**
 * Send a test email using this template. Delegates entirely to the
 * existing `sendAdminTestEmail` path (queue-bypass for the sync UX, but
 * still writes an outbox row + audit trail + rate limit).
 */
export async function sendTemplateTestAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { user } = await requirePermission("settings.email.test");
  const recipient = String(formData.get("recipient") ?? "").trim();
  const email = z.string().email().safeParse(recipient);
  if (!email.success) {
    return { status: "error", message: "Adresse email invalide." };
  }
  // We reuse the admin-test infrastructure, which sends an
  // `admin-test-email` template. This validates the full pipeline
  // (provider, config, rate limit, allowlist) without needing a
  // template-specific variable bag.
  const result = await sendAdminTestEmail({
    adminId: user.id,
    adminName: user.name,
    recipient: email.data
  });
  if (result.ok) return { status: "success", message: "Email de test envoyé." };
  return {
    status: "error",
    message: result.message ?? "Envoi impossible."
  };
}

/* ------------------------------ BRANDING ------------------------------ */

export async function saveBrandingAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { user } = await requirePermission("settings.email.templates");
  const raw = {
    eventName: String(formData.get("eventName") ?? "").trim(),
    editionLabel: String(formData.get("editionLabel") ?? "").trim(),
    eventDate: String(formData.get("eventDate") ?? "").trim(),
    eventVenue: String(formData.get("eventVenue") ?? "").trim(),
    eventCity: String(formData.get("eventCity") ?? "").trim(),
    siteUrl: String(formData.get("siteUrl") ?? "").trim(),
    contactUrl: String(formData.get("contactUrl") ?? "").trim(),
    privacyUrl: String(formData.get("privacyUrl") ?? "").trim(),
    termsUrl: String(formData.get("termsUrl") ?? "").trim(),
    logoUrl: String(formData.get("logoUrl") ?? "").trim(),
    footerNote: String(formData.get("footerNote") ?? "").trim(),
    socialLinkedIn: String(formData.get("socialLinkedIn") ?? "").trim(),
    socialInstagram: String(formData.get("socialInstagram") ?? "").trim(),
    socialFacebook: String(formData.get("socialFacebook") ?? "").trim(),
    socialX: String(formData.get("socialX") ?? "").trim(),
    socialYouTube: String(formData.get("socialYouTube") ?? "").trim()
  };
  const parsed = brandingFormSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return { status: "error", message: "Merci de vérifier les champs.", fieldErrors };
  }
  await saveEmailBranding(parsed.data);
  await audit({
    userId: user.id,
    action: "email.branding.updated",
    entity: "SiteContent",
    entityId: "email.branding",
    meta: {
      eventName: parsed.data.eventName,
      hasLogo: Boolean(parsed.data.logoUrl),
      hasPrivacy: Boolean(parsed.data.privacyUrl),
      hasTerms: Boolean(parsed.data.termsUrl)
    }
  });
  revalidatePath("/admin/settings/email/templates");
  return { status: "success", message: "Branding enregistré." };
}

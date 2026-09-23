import "server-only";

import { prisma } from "@/lib/db";
import type { EmailTemplate as PrismaEmailTemplate } from "@prisma/client";
import { EMAIL_TEMPLATES } from "@/lib/admin/email-templates";
import type { EmailVars } from "../render";
import { renderEmail, type RenderResult } from "../render";
import { renderDbTemplate } from "./db-render";
import { getEmailBranding } from "./branding";
import { sanitizeTemplateHtml, detectDangerousPatterns } from "./sanitize";
import { extractPlaceholders, isKnownVariable } from "./registry";

// ─── Template service ────────────────────────────────────────────────────
//
// Single entry-point for anything that needs to turn a `templateKey` +
// variable bag into an email payload. Resolution order:
//
//   1. Active EmailTemplate row (key match, isActive = true) → renderDb.
//   2. Code catalog EMAIL_TEMPLATES → renderEmail (existing structured).
//
// A deactivated DB row silently falls back to the code catalog — the
// application NEVER sends an empty email because an admin messed up.

export type ResolvedTemplate =
  | { kind: "db"; row: PrismaEmailTemplate }
  | { kind: "code"; key: string; subject: string; content: (typeof EMAIL_TEMPLATES)[number]["content"] };

export async function resolveTemplate(key: string): Promise<ResolvedTemplate | null> {
  const dbRow = await prisma.emailTemplate.findFirst({
    where: { key, isActive: true }
  });
  if (dbRow) return { kind: "db", row: dbRow };
  const codeTpl = EMAIL_TEMPLATES.find((t) => t.key === key);
  if (codeTpl) {
    return { kind: "code", key: codeTpl.key, subject: codeTpl.subject, content: codeTpl.content };
  }
  return null;
}

export async function renderTemplate(
  key: string,
  vars: EmailVars
): Promise<RenderResult | null> {
  const resolved = await resolveTemplate(key);
  if (!resolved) return null;
  if (resolved.kind === "code") {
    return renderEmail({ subject: resolved.subject, content: resolved.content, vars });
  }
  const branding = await getEmailBranding();
  return renderDbTemplate({
    subject: resolved.row.subject,
    preheader: resolved.row.preheader,
    htmlBody: resolved.row.htmlBody,
    textBody: resolved.row.textBody,
    useHeader: resolved.row.useHeader,
    useFooter: resolved.row.useFooter,
    branding,
    vars
  });
}

/* ------------------------------ VALIDATION ------------------------------ */

export type TemplateValidationError = { code: string; message: string };

export function validateTemplatePayload(input: {
  subject: string;
  htmlBody: string;
  textBody: string;
  preheader?: string | null;
}): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];
  if (!input.subject || input.subject.trim().length === 0) {
    errors.push({ code: "subject-empty", message: "Le sujet est requis." });
  }
  if (!input.htmlBody || input.htmlBody.trim().length === 0) {
    errors.push({ code: "html-empty", message: "Le corps HTML est requis." });
  }
  if (!input.textBody || input.textBody.trim().length === 0) {
    errors.push({ code: "text-empty", message: "Le corps texte est requis (fallback multipart)." });
  }
  // Dangerous patterns — reported BEFORE sanitize so operators know why
  // their input was rejected instead of silently having tags stripped.
  for (const finding of detectDangerousPatterns(input.htmlBody)) {
    errors.push({ code: "html-dangerous", message: `HTML refusé : ${finding}.` });
  }
  // Unknown placeholders across every text-bearing field.
  const seen = new Set<string>();
  const scan = (source: string) => {
    for (const name of extractPlaceholders(source)) {
      if (!isKnownVariable(name) && !seen.has(name)) {
        seen.add(name);
        errors.push({
          code: "unknown-variable",
          message: `Variable inconnue : {{${name}}}.`
        });
      }
    }
  };
  scan(input.subject);
  if (input.preheader) scan(input.preheader);
  scan(input.htmlBody);
  scan(input.textBody);
  return errors;
}

/* ------------------------------ CRUD ------------------------------ */

export type UpsertTemplateInput = {
  key: string;
  name: string;
  description: string | null;
  category: string;
  subject: string;
  preheader: string | null;
  htmlBody: string;
  textBody: string;
  useHeader: boolean;
  useFooter: boolean;
  isSystem?: boolean;
  isActive?: boolean;
  actorId: string | null;
};

export async function createTemplate(
  input: UpsertTemplateInput
): Promise<PrismaEmailTemplate> {
  const cleaned = sanitizeTemplateHtml(input.htmlBody);
  return prisma.emailTemplate.create({
    data: {
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      category: input.category,
      subject: input.subject,
      preheader: input.preheader ?? null,
      htmlBody: cleaned,
      textBody: input.textBody,
      useHeader: input.useHeader,
      useFooter: input.useFooter,
      isSystem: input.isSystem ?? false,
      isActive: input.isActive ?? true,
      createdBy: input.actorId,
      updatedBy: input.actorId
    }
  });
}

export async function updateTemplateAndVersion(
  templateId: string,
  input: UpsertTemplateInput
): Promise<PrismaEmailTemplate> {
  const cleaned = sanitizeTemplateHtml(input.htmlBody);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.emailTemplate.findUnique({ where: { id: templateId } });
    if (!existing) throw new Error("Template not found");

    // Snapshot the PREVIOUS content into an EmailTemplateVersion before
    // overwriting. Version numbering counts existing rows so an admin
    // can walk backwards.
    const currentCount = await tx.emailTemplateVersion.count({
      where: { templateId }
    });
    await tx.emailTemplateVersion.create({
      data: {
        templateId,
        version: currentCount + 1,
        subject: existing.subject,
        preheader: existing.preheader,
        htmlBody: existing.htmlBody,
        textBody: existing.textBody,
        createdBy: input.actorId
      }
    });

    return tx.emailTemplate.update({
      where: { id: templateId },
      data: {
        name: input.name,
        description: input.description ?? null,
        category: input.category,
        subject: input.subject,
        preheader: input.preheader ?? null,
        htmlBody: cleaned,
        textBody: input.textBody,
        useHeader: input.useHeader,
        useFooter: input.useFooter,
        isActive: input.isActive ?? existing.isActive,
        updatedBy: input.actorId
      }
    });
  });
}

export async function setTemplateActive(
  templateId: string,
  isActive: boolean,
  actorId: string | null
): Promise<void> {
  await prisma.emailTemplate.update({
    where: { id: templateId },
    data: { isActive, updatedBy: actorId }
  });
}

export async function duplicateTemplate(
  templateId: string,
  newKey: string,
  newName: string,
  actorId: string | null
): Promise<PrismaEmailTemplate> {
  const src = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
  if (!src) throw new Error("Template not found");
  return prisma.emailTemplate.create({
    data: {
      key: newKey,
      name: newName,
      description: src.description,
      // Duplicates are always custom — even if we duplicated a system template.
      category: src.category === "system" ? "custom" : src.category,
      subject: src.subject,
      preheader: src.preheader,
      htmlBody: src.htmlBody,
      textBody: src.textBody,
      useHeader: src.useHeader,
      useFooter: src.useFooter,
      isSystem: false,
      isActive: false, // duplicates start inactive so a mistake never ships
      createdBy: actorId,
      updatedBy: actorId
    }
  });
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const t = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw new Error("Template not found");
  if (t.isSystem) {
    // System-flagged rows are protected from deletion. Deactivate the row
    // (and the code catalog fallback takes over) — never delete.
    throw new Error(
      "Impossible de supprimer un modèle système. Désactivez-le à la place."
    );
  }
  await prisma.emailTemplate.delete({ where: { id: templateId } });
}

export async function restoreVersion(
  templateId: string,
  versionId: string,
  actorId: string | null
): Promise<PrismaEmailTemplate> {
  return prisma.$transaction(async (tx) => {
    const v = await tx.emailTemplateVersion.findUnique({ where: { id: versionId } });
    if (!v || v.templateId !== templateId) {
      throw new Error("Version not found");
    }
    const existing = await tx.emailTemplate.findUnique({ where: { id: templateId } });
    if (!existing) throw new Error("Template not found");

    const currentCount = await tx.emailTemplateVersion.count({ where: { templateId } });
    await tx.emailTemplateVersion.create({
      data: {
        templateId,
        version: currentCount + 1,
        subject: existing.subject,
        preheader: existing.preheader,
        htmlBody: existing.htmlBody,
        textBody: existing.textBody,
        createdBy: actorId
      }
    });

    return tx.emailTemplate.update({
      where: { id: templateId },
      data: {
        subject: v.subject,
        preheader: v.preheader,
        htmlBody: v.htmlBody,
        textBody: v.textBody,
        updatedBy: actorId
      }
    });
  });
}

/* ------------------------------ LISTING ------------------------------ */

export type TemplateListRow = {
  id: string | null; // null when the row only exists in the code catalog
  key: string;
  name: string;
  category: string;
  isSystem: boolean;
  isActive: boolean; // effective (code-catalog entries are always active)
  source: "db" | "code";
  updatedAt: Date | null;
  description: string | null;
};

/**
 * Return the union of code-catalog templates and DB templates, keyed by
 * `key`. If a key exists in both, the DB row wins in the listing (that
 * is the same precedence as the send-time resolver).
 */
export async function listTemplates(): Promise<TemplateListRow[]> {
  const dbRows = await prisma.emailTemplate.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }]
  });
  const byKey = new Map<string, TemplateListRow>();
  for (const t of dbRows) {
    byKey.set(t.key, {
      id: t.id,
      key: t.key,
      name: t.name,
      category: t.category,
      isSystem: t.isSystem,
      isActive: t.isActive,
      source: "db",
      updatedAt: t.updatedAt,
      description: t.description
    });
  }
  for (const codeTpl of EMAIL_TEMPLATES) {
    if (byKey.has(codeTpl.key)) continue;
    byKey.set(codeTpl.key, {
      id: null,
      key: codeTpl.key,
      name: codeTpl.label,
      category: codeTpl.category,
      isSystem: true,
      isActive: true,
      source: "code",
      updatedAt: null,
      description: codeTpl.description
    });
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.category === b.category) return a.name.localeCompare(b.name);
    return a.category.localeCompare(b.category);
  });
}

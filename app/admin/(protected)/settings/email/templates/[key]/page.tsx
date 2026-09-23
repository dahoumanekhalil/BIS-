import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { AdminHeader } from "@/components/admin/header";
import { prisma } from "@/lib/db";
import { EMAIL_TEMPLATES } from "@/lib/admin/email-templates";
import { TEMPLATE_VARIABLES } from "@/lib/email/templates/registry";
import { TemplateEditor } from "./editor-client";

type Params = { params: Promise<{ key: string }> };

export default async function TemplateEditorPage({ params }: Params) {
  const { user } = await requirePermission("settings.email.templates");
  const { key } = await params;
  const isNew = key === "new";

  let initial;
  let versions: Array<{ id: string; version: number; createdAt: Date }> = [];

  if (isNew) {
    initial = {
      id: null,
      key: "",
      name: "",
      description: "",
      category: "custom",
      subject: "",
      preheader: "",
      htmlBody:
        "<h2 style=\"font-family:'Alexandria',sans-serif;color:#111;\">Bonjour {{firstName}},</h2>\n<p>Votre contenu personnalisé ici.</p>",
      textBody: "Bonjour {{firstName}},\n\nVotre contenu personnalisé ici.",
      useHeader: true,
      useFooter: true,
      isSystem: false,
      isActive: false
    };
  } else {
    const dbRow = await prisma.emailTemplate.findUnique({ where: { key } });
    if (dbRow) {
      initial = {
        id: dbRow.id,
        key: dbRow.key,
        name: dbRow.name,
        description: dbRow.description ?? "",
        category: dbRow.category,
        subject: dbRow.subject,
        preheader: dbRow.preheader ?? "",
        htmlBody: dbRow.htmlBody,
        textBody: dbRow.textBody,
        useHeader: dbRow.useHeader,
        useFooter: dbRow.useFooter,
        isSystem: dbRow.isSystem,
        isActive: dbRow.isActive
      };
      versions = await prisma.emailTemplateVersion.findMany({
        where: { templateId: dbRow.id },
        orderBy: { version: "desc" },
        take: 20,
        select: { id: true, version: true, createdAt: true }
      });
    } else {
      // Fall back to the code catalog so admins can "start from" a system
      // template. Saving creates a DB row that overrides the code entry.
      const codeTpl = EMAIL_TEMPLATES.find((t) => t.key === key);
      if (!codeTpl) return notFound();
      const html = codeTpl.content.paragraphs
        .map((p) => `<p>${p}</p>`)
        .join("\n");
      initial = {
        id: null,
        key: codeTpl.key,
        name: codeTpl.label,
        description: codeTpl.description,
        category: codeTpl.category,
        subject: codeTpl.subject,
        preheader: "",
        htmlBody: html,
        textBody: codeTpl.content.paragraphs.join("\n\n"),
        useHeader: true,
        useFooter: true,
        isSystem: true,
        isActive: false
      };
    }
  }

  return (
    <>
      <AdminHeader
        user={user}
        title={isNew ? "Nouveau modèle" : initial.name || "Modèle"}
        subtitle="Settings / Email / Templates"
      />
      <div className="space-y-4 p-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-[11.5px] text-ink/55">
          <Link href="/admin/settings" className="font-semibold text-cobalt hover:underline">
            Paramètres
          </Link>
          <Chevron />
          <Link href="/admin/settings/email" className="font-semibold text-cobalt hover:underline">
            Email
          </Link>
          <Chevron />
          <Link
            href="/admin/settings/email/templates"
            className="font-semibold text-cobalt hover:underline"
          >
            Modèles
          </Link>
          <Chevron />
          <span className="font-semibold text-ink/70 truncate">
            {isNew ? "Nouveau" : initial.name || initial.key}
          </span>
        </nav>

        <TemplateEditor
          isNew={isNew}
          initial={initial}
          versions={versions.map((v) => ({
            id: v.id,
            version: v.version,
            createdAt: v.createdAt.toISOString()
          }))}
          variables={TEMPLATE_VARIABLES}
        />
      </div>
    </>
  );
}

function Chevron() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

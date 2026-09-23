"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  saveTemplateAction,
  toggleTemplateActiveAction,
  duplicateTemplateAction,
  deleteTemplateAction,
  restoreVersionAction,
  sendTemplateTestAction,
  type ActionState
} from "../actions";
import { previewTemplateAction, type PreviewResult } from "./preview-action";
import type { TemplateVariable } from "@/lib/email/templates/registry";

type Initial = {
  id: string | null;
  key: string;
  name: string;
  description: string;
  category: string;
  subject: string;
  preheader: string;
  htmlBody: string;
  textBody: string;
  useHeader: boolean;
  useFooter: boolean;
  isSystem: boolean;
  isActive: boolean;
};

type VersionRow = { id: string; version: number; createdAt: string };
type Msg = { tone: "success" | "error"; text: string } | null;
type SidebarTab = "preview" | "vars" | "test" | "history";
type EditorTab = "html" | "text";

const CATEGORY_LABEL: Record<string, string> = {
  auth: "Authentification",
  registration: "Inscription",
  room: "Salles",
  payment: "Paiement",
  event: "Événement",
  marketing: "Marketing",
  system: "Système",
  contact: "Contact",
  custom: "Personnalisé",
  profile: "Profil",
  admin: "Administration"
};
function catLabel(c: string): string {
  return CATEGORY_LABEL[c] ?? c;
}

// Recommended subject-line length for inbox rendering. Anything above 60
// gets truncated by most webmail; below 25 tends to look sparse. Numbers
// are the *display* range shown to operators — they are advisory, not
// enforced.
const SUBJECT_IDEAL_MIN = 25;
const SUBJECT_IDEAL_MAX = 60;
const PREHEADER_IDEAL_MIN = 30;
const PREHEADER_IDEAL_MAX = 130;

export function TemplateEditor({
  isNew,
  initial,
  versions,
  variables
}: {
  isNew: boolean;
  initial: Initial;
  versions: VersionRow[];
  variables: TemplateVariable[];
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [previewMsg, setPreviewMsg] = useState<Msg>(null);
  const [testMsg, setTestMsg] = useState<Msg>(null);
  const [dirty, setDirty] = useState(false);

  // Form state
  const [name, setName] = useState(initial.name);
  const [templateKey, setTemplateKey] = useState(initial.key);
  const [description, setDescription] = useState(initial.description);
  const [category, setCategory] = useState(initial.category);
  const [subject, setSubject] = useState(initial.subject);
  const [preheader, setPreheader] = useState(initial.preheader);
  const [htmlBody, setHtmlBody] = useState(initial.htmlBody);
  const [textBody, setTextBody] = useState(initial.textBody);
  const [useHeader, setUseHeader] = useState(initial.useHeader);
  const [useFooter, setUseFooter] = useState(initial.useFooter);
  const [isActive, setIsActive] = useState(initial.isActive);

  // UI state
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("preview");
  const [editorTab, setEditorTab] = useState<EditorTab>("html");
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [varSearch, setVarSearch] = useState("");

  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const preheaderRef = useRef<HTMLInputElement>(null);

  // Warn on unload with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const markDirty = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    if (!dirty) setDirty(true);
  };

  const groupedVars = useMemo(() => {
    const needle = varSearch.trim().toLowerCase();
    const filtered = variables.filter((v) => {
      if (!needle) return true;
      return (
        v.key.toLowerCase().includes(needle) ||
        v.label.toLowerCase().includes(needle) ||
        v.description.toLowerCase().includes(needle)
      );
    });
    const map = new Map<string, TemplateVariable[]>();
    for (const v of filtered) {
      const cat = v.categories[0] ?? "custom";
      const arr = map.get(cat) ?? [];
      arr.push(v);
      map.set(cat, arr);
    }
    return Array.from(map.entries()).sort((a, b) =>
      catLabel(a[0]).localeCompare(catLabel(b[0]))
    );
  }, [variables, varSearch]);

  function insertAtCursor(input: HTMLTextAreaElement | HTMLInputElement | null, snippet: string) {
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const next = before + snippet + after;
    if (input === htmlRef.current) setHtmlBody(next);
    else if (input === textRef.current) setTextBody(next);
    else if (input === subjectRef.current) setSubject(next);
    else if (input === preheaderRef.current) setPreheader(next);
    if (!dirty) setDirty(true);
    // Restore focus + cursor after React re-renders.
    setTimeout(() => {
      input.focus();
      const pos = start + snippet.length;
      input.setSelectionRange(pos, pos);
    }, 0);
  }

  function insertVar(varKey: string, target: "html" | "text" | "subject" | "preheader") {
    const token = `{{${varKey}}}`;
    const el =
      target === "html"
        ? htmlRef.current
        : target === "text"
          ? textRef.current
          : target === "subject"
            ? subjectRef.current
            : preheaderRef.current;
    insertAtCursor(el, token);
  }

  // HTML editor quick-insert snippets — each is a pre-styled fragment
  // that fits the sanitizer allowlist and renders cleanly in most mail
  // clients (table-based patterns where possible).
  function htmlSnippet(kind: string) {
    let snippet = "";
    switch (kind) {
      case "h2":
        snippet =
          '\n<h2 style="font-family:sans-serif;color:#111827;font-size:22px;margin:0 0 12px 0;">Titre</h2>\n';
        break;
      case "p":
        snippet =
          '\n<p style="font-family:sans-serif;color:#334155;font-size:15px;line-height:1.6;margin:0 0 16px 0;">Votre paragraphe ici.</p>\n';
        break;
      case "link":
        snippet =
          '<a href="https://example.com" style="color:#2453E0;text-decoration:underline;">lien</a>';
        break;
      case "button":
        snippet =
          '\n<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;"><tr><td bgcolor="#B8E62E" style="border-radius:8px;"><a href="https://example.com" target="_blank" style="display:inline-block;padding:14px 22px;font-family:sans-serif;font-size:14px;font-weight:800;color:#111827;text-decoration:none;border-radius:8px;">Appel à l\'action →</a></td></tr></table>\n';
        break;
      case "hr":
        snippet =
          '\n<hr style="border:none;border-top:1px solid #E6E8ED;margin:24px 0;">\n';
        break;
      case "ul":
        snippet =
          '\n<ul style="font-family:sans-serif;color:#334155;font-size:15px;line-height:1.6;margin:0 0 16px 0;padding-left:20px;">\n  <li>Élément 1</li>\n  <li>Élément 2</li>\n</ul>\n';
        break;
      case "info":
        snippet =
          '\n<div style="background:#F8FAF9;border-left:3px solid #2453E0;padding:14px 18px;margin:16px 0;font-family:sans-serif;font-size:14px;color:#334155;">\n  <strong>Info :</strong> texte d\'information.\n</div>\n';
        break;
    }
    insertAtCursor(htmlRef.current, snippet);
  }

  const runPreview = () => {
    startTransition(async () => {
      const res: PreviewResult = await previewTemplateAction({
        subject,
        preheader,
        htmlBody,
        textBody,
        useHeader,
        useFooter
      });
      if (res.ok) {
        setPreviewHtml(res.html);
        setPreviewWarnings(res.warnings);
        setPreviewMsg(null);
        setSidebarTab("preview");
      } else {
        setPreviewHtml(null);
        setPreviewWarnings([]);
        setPreviewMsg({ tone: "error", text: res.message });
        setSidebarTab("preview");
      }
    });
  };

  const submitForm = (formData: FormData) => {
    startTransition(async () => {
      const res: ActionState = await saveTemplateAction({ status: "idle" }, formData);
      if (res.status === "success") {
        setMsg({ tone: "success", text: res.message });
        setDirty(false);
        if (res.templateKey && !initial.id) {
          window.location.href = `/admin/settings/email/templates/${res.templateKey}`;
          return;
        }
      } else if (res.status === "error") {
        setMsg({ tone: "error", text: res.message });
      }
    });
  };

  return (
    <div className="space-y-4">
      {/* ─── Sticky action bar ─── */}
      <div className="sticky top-16 z-20 -mx-6 border-b border-line bg-white/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <StatusBadge active={isActive} isSystem={initial.isSystem} isNew={isNew} />
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-black text-ink">
                {name || (isNew ? "Nouveau modèle" : templateKey)}
              </h1>
              <p className="truncate font-mono text-[11px] text-ink/50">
                {templateKey || "clé-du-modèle"}
              </p>
            </div>
            {dirty && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-amber-800">
                <Dot className="bg-amber-500" /> Modifs non sauvegardées
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/settings/email/templates"
              className="text-[12px] font-semibold text-ink/60 hover:text-ink"
            >
              Annuler
            </Link>
            <button
              type="button"
              onClick={runPreview}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-btn border border-ink/20 bg-white px-3 py-2 text-[12.5px] font-bold text-ink hover:border-ink/40"
            >
              <IconEye />
              Prévisualiser
            </button>
            <button
              type="submit"
              form="template-form"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-btn bg-ink px-4 py-2 text-[12.5px] font-bold text-lime disabled:opacity-60"
            >
              <IconSave />
              {pending
                ? "Enregistrement…"
                : isNew
                  ? "Créer le modèle"
                  : "Enregistrer"}
            </button>
          </div>
        </div>
        {msg && msg.text && (
          <p
            className={
              msg.tone === "success"
                ? "mt-2 rounded-btn bg-lime/20 px-3 py-1.5 text-[12px] font-semibold text-ink"
                : "mt-2 rounded-btn bg-red-100 px-3 py-1.5 text-[12px] font-semibold text-red-800 whitespace-pre-line"
            }
          >
            {msg.text}
          </p>
        )}
      </div>

      {/* ─── Two-column layout ─── */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* ─── LEFT: form ─── */}
        <div className="space-y-5">
          <form id="template-form" action={submitForm} className="space-y-5">
            {initial.id && <input type="hidden" name="id" value={initial.id} />}
            <input type="hidden" name="useHeader" value={useHeader ? "on" : ""} />
            <input type="hidden" name="useFooter" value={useFooter ? "on" : ""} />
            <input type="hidden" name="isActive" value={isActive ? "on" : ""} />

            {/* Metadata */}
            <Card icon={<IconMeta />} title="Métadonnées" hint="Nom interne, catégorie, activation.">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Nom (interne)"
                  name="name"
                  value={name}
                  onChange={markDirty(setName)}
                  required
                  placeholder="Ex : Confirmation d'inscription"
                />
                <label className="text-[12px] font-semibold text-ink/70">
                  Clé (immuable{initial.id ? "" : ", stable"})
                  <div className="relative mt-1">
                    <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[13px] font-mono text-ink/40">
                      #
                    </span>
                    <input
                      name="key"
                      value={templateKey}
                      onChange={(e) => markDirty(setTemplateKey)(e.currentTarget.value)}
                      readOnly={Boolean(initial.id)}
                      required
                      pattern="[a-z0-9][a-z0-9_-]*"
                      className="w-full rounded-btn border border-line bg-white pl-7 pr-3 py-2 text-[13px] font-mono text-ink placeholder:text-ink/35 read-only:bg-ink/5 read-only:text-ink/60 focus:border-cobalt focus:outline-none"
                      placeholder="ma_cle_de_modele"
                    />
                  </div>
                </label>
                <label className="text-[12px] font-semibold text-ink/70 sm:col-span-2">
                  Description
                  <input
                    name="description"
                    value={description}
                    onChange={(e) => markDirty(setDescription)(e.currentTarget.value)}
                    className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink placeholder:text-ink/35 focus:border-cobalt focus:outline-none"
                    placeholder="À quoi sert ce modèle ?"
                  />
                </label>
                <label className="text-[12px] font-semibold text-ink/70">
                  Catégorie
                  <select
                    name="category"
                    value={category}
                    onChange={(e) => markDirty(setCategory)(e.currentTarget.value)}
                    className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink focus:border-cobalt focus:outline-none"
                  >
                    {[
                      "auth",
                      "registration",
                      "room",
                      "payment",
                      "event",
                      "marketing",
                      "system",
                      "contact",
                      "custom"
                    ].map((c) => (
                      <option key={c} value={c}>
                        {catLabel(c)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-col justify-end">
                  <Toggle
                    label="Modèle actif (remplace le modèle système)"
                    checked={isActive}
                    onChange={(v) => {
                      setIsActive(v);
                      if (!dirty) setDirty(true);
                    }}
                    tone={isActive ? "ok" : "neutral"}
                  />
                </div>
              </div>
            </Card>

            {/* Subject & preheader */}
            <Card icon={<IconSubject />} title="Sujet & preheader" hint="Ce qui apparaît dans la boîte de réception.">
              <div className="space-y-4">
                <FieldWithCounter
                  label="Sujet"
                  name="subject"
                  refCb={subjectRef}
                  value={subject}
                  onChange={markDirty(setSubject)}
                  required
                  placeholder="Ex : Bonjour {{firstName}}, votre inscription est confirmée"
                  min={SUBJECT_IDEAL_MIN}
                  max={SUBJECT_IDEAL_MAX}
                />
                <FieldWithCounter
                  label="Preheader (texte de prévisualisation)"
                  name="preheader"
                  refCb={preheaderRef}
                  value={preheader}
                  onChange={markDirty(setPreheader)}
                  placeholder="Optionnel — masqué dans le corps, visible dans l'inbox"
                  min={PREHEADER_IDEAL_MIN}
                  max={PREHEADER_IDEAL_MAX}
                />
              </div>
            </Card>

            {/* Body — tabbed HTML / text */}
            <Card
              icon={<IconCode />}
              title="Corps du message"
              hint="HTML principal + fallback plain-text (envoyés en multipart/alternative)."
            >
              {/* Tabs */}
              <div className="mb-3 flex items-center gap-1 rounded-btn border border-line bg-frost/50 p-1 w-fit">
                <TabPill
                  active={editorTab === "html"}
                  onClick={() => setEditorTab("html")}
                  label="HTML"
                />
                <TabPill
                  active={editorTab === "text"}
                  onClick={() => setEditorTab("text")}
                  label="Texte"
                />
              </div>

              {editorTab === "html" && (
                <div>
                  {/* HTML toolbar */}
                  <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-btn border border-line bg-frost/40 p-1.5">
                    <SnippetBtn onClick={() => htmlSnippet("h2")} label="H2" tooltip="Titre" />
                    <SnippetBtn onClick={() => htmlSnippet("p")} label="P" tooltip="Paragraphe" />
                    <SnippetBtn onClick={() => htmlSnippet("link")} label="↗" tooltip="Lien" />
                    <SnippetBtn onClick={() => htmlSnippet("button")} label="⏵" tooltip="Bouton CTA" primary />
                    <SnippetBtn onClick={() => htmlSnippet("ul")} label="•" tooltip="Liste" />
                    <SnippetBtn onClick={() => htmlSnippet("hr")} label="—" tooltip="Séparateur" />
                    <SnippetBtn onClick={() => htmlSnippet("info")} label="ℹ" tooltip="Bloc info" />
                    <div className="ml-2 h-4 w-px bg-line" />
                    <span className="ml-1 text-[10.5px] font-semibold text-ink/50">
                      {htmlBody.length.toLocaleString()} caractères
                    </span>
                  </div>
                  <textarea
                    ref={htmlRef}
                    name="htmlBody"
                    value={htmlBody}
                    onChange={(e) => markDirty(setHtmlBody)(e.currentTarget.value)}
                    required
                    rows={20}
                    spellCheck={false}
                    className="block w-full rounded-btn border border-line bg-white px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink focus:border-cobalt focus:outline-none"
                  />
                  <p className="mt-2 text-[11px] text-ink/55">
                    Les balises &lt;script&gt;, &lt;iframe&gt;, les gestionnaires
                    d'événements JS et les URLs javascript: sont supprimés côté
                    serveur. Utilisez <code className="rounded bg-ink/10 px-1 py-0.5 text-[10.5px] font-mono">{"{{variable}}"}</code> pour
                    insérer une donnée dynamique.
                  </p>
                </div>
              )}

              {editorTab === "text" && (
                <div>
                  <div className="mb-2 flex items-center justify-between rounded-btn border border-line bg-frost/40 px-3 py-1.5">
                    <span className="text-[11px] text-ink/60">
                      Fallback multipart pour les clients sans HTML.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const stripped = htmlBody
                          .replace(/<style[\s\S]*?<\/style>/gi, "")
                          .replace(/<[^>]+>/g, "")
                          .replace(/\n{3,}/g, "\n\n")
                          .trim();
                        markDirty(setTextBody)(stripped);
                      }}
                      className="text-[11px] font-bold text-cobalt hover:underline"
                    >
                      Générer depuis le HTML
                    </button>
                  </div>
                  <textarea
                    ref={textRef}
                    name="textBody"
                    value={textBody}
                    onChange={(e) => markDirty(setTextBody)(e.currentTarget.value)}
                    required
                    rows={14}
                    className="block w-full rounded-btn border border-line bg-white px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink focus:border-cobalt focus:outline-none"
                  />
                </div>
              )}
            </Card>

            {/* Wrap options */}
            <Card icon={<IconLayout />} title="Habillage" hint="Header et footer partagés (issus du branding email).">
              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Utiliser le header global"
                  hint="Bandeau supérieur avec logo & nom d'événement."
                  checked={useHeader}
                  onChange={(v) => {
                    setUseHeader(v);
                    if (!dirty) setDirty(true);
                  }}
                />
                <Toggle
                  label="Utiliser le footer global"
                  hint="Bandeau inférieur avec liens & mentions légales."
                  checked={useFooter}
                  onChange={(v) => {
                    setUseFooter(v);
                    if (!dirty) setDirty(true);
                  }}
                />
              </div>
            </Card>
          </form>

          {/* Danger zone (existing templates only) */}
          {initial.id && (
            <Card
              icon={<IconDanger />}
              title="Actions avancées"
              hint="Basculer l'activation, dupliquer ou supprimer ce modèle."
              tone="danger"
            >
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      const res = await toggleTemplateActiveAction(initial.id!, !isActive);
                      if (res.status === "success") setIsActive(!isActive);
                      setMsg({
                        tone: res.status === "success" ? "success" : "error",
                        text: res.status === "idle" ? "" : res.message
                      });
                    })
                  }
                  className="rounded-btn border border-ink px-3 py-2 text-[12.5px] font-bold text-ink hover:bg-ink hover:text-lime"
                >
                  {isActive ? "Désactiver" : "Activer"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nk = window.prompt("Nouvelle clé pour la copie :");
                    if (!nk) return;
                    startTransition(async () => {
                      const res = await duplicateTemplateAction(
                        initial.id!,
                        nk,
                        `${initial.name} (copie)`
                      );
                      setMsg({
                        tone: res.status === "success" ? "success" : "error",
                        text: res.status === "idle" ? "" : res.message
                      });
                    });
                  }}
                  className="rounded-btn border border-line px-3 py-2 text-[12.5px] font-bold text-ink"
                >
                  Dupliquer
                </button>
                {!initial.isSystem && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm("Supprimer définitivement ce modèle ?")) return;
                      startTransition(async () => {
                        const res = await deleteTemplateAction(initial.id!);
                        if (res.status === "success") {
                          window.location.href = "/admin/settings/email/templates";
                        } else if (res.status === "error") {
                          setMsg({ tone: "error", text: res.message });
                        }
                      });
                    }}
                    className="rounded-btn bg-red-100 px-3 py-2 text-[12.5px] font-bold text-red-800 hover:bg-red-200"
                  >
                    Supprimer
                  </button>
                )}
              </div>
              {initial.isSystem && (
                <p className="mt-3 text-[11.5px] text-ink/55">
                  Les modèles système ne peuvent pas être supprimés. Désactivez-les
                  pour rétablir le fallback code.
                </p>
              )}
            </Card>
          )}
        </div>

        {/* ─── RIGHT: sticky sidebar with tabs ─── */}
        <aside className="lg:sticky lg:top-[132px] lg:self-start">
          <div className="rounded-[16px] border border-line bg-white overflow-hidden">
            <div className="flex border-b border-line bg-frost/40">
              <SidebarTabBtn
                active={sidebarTab === "preview"}
                onClick={() => setSidebarTab("preview")}
                icon={<IconEye />}
                label="Aperçu"
              />
              <SidebarTabBtn
                active={sidebarTab === "vars"}
                onClick={() => setSidebarTab("vars")}
                icon={<IconVar />}
                label="Variables"
              />
              <SidebarTabBtn
                active={sidebarTab === "test"}
                onClick={() => setSidebarTab("test")}
                icon={<IconSend />}
                label="Test"
              />
              {versions.length > 0 && (
                <SidebarTabBtn
                  active={sidebarTab === "history"}
                  onClick={() => setSidebarTab("history")}
                  icon={<IconClock />}
                  label={`v${versions[0].version}`}
                />
              )}
            </div>

            {sidebarTab === "preview" && (
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex gap-1 rounded-btn border border-line bg-frost/40 p-0.5">
                    <DeviceBtn
                      active={previewDevice === "desktop"}
                      onClick={() => setPreviewDevice("desktop")}
                      icon={<IconDesktop />}
                    />
                    <DeviceBtn
                      active={previewDevice === "mobile"}
                      onClick={() => setPreviewDevice("mobile")}
                      icon={<IconMobile />}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={runPreview}
                    disabled={pending}
                    className="inline-flex items-center gap-1 rounded-btn bg-cobalt/10 px-2.5 py-1.5 text-[11px] font-bold text-cobalt hover:bg-cobalt hover:text-white disabled:opacity-60"
                  >
                    <IconRefresh /> {pending ? "…" : "Actualiser"}
                  </button>
                </div>

                {previewMsg && previewMsg.text && (
                  <p className="rounded-btn bg-red-100 px-3 py-2 text-[11.5px] font-semibold text-red-800 whitespace-pre-line">
                    {previewMsg.text}
                  </p>
                )}
                {previewWarnings.length > 0 && (
                  <div className="rounded-btn bg-amber-100 px-3 py-2 text-[11px] text-amber-900">
                    <div className="font-bold">Avertissements :</div>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {previewWarnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {previewHtml ? (
                  <div className="rounded-[10px] border border-line bg-frost/40 p-2">
                    <iframe
                      sandbox=""
                      srcDoc={previewHtml}
                      style={{
                        width: previewDevice === "mobile" ? 360 : "100%",
                        maxWidth: "100%",
                        height: 620,
                        border: "none",
                        borderRadius: 8,
                        background: "#fff",
                        display: "block",
                        margin: previewDevice === "mobile" ? "0 auto" : undefined
                      }}
                    />
                  </div>
                ) : (
                  <div className="rounded-[10px] border-2 border-dashed border-line bg-frost/30 p-8 text-center">
                    <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-white text-ink/40">
                      <IconEye />
                    </div>
                    <p className="text-[12.5px] font-semibold text-ink/60">
                      Cliquez « Actualiser » pour rendre le modèle
                    </p>
                    <p className="mt-1 text-[11px] text-ink/45">
                      Le rendu utilise des données d'exemple depuis le registre
                      de variables. Aucune donnée participant réelle n'est
                      utilisée.
                    </p>
                  </div>
                )}
              </div>
            )}

            {sidebarTab === "vars" && (
              <div className="p-4 space-y-3">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/40">
                    <IconSearch />
                  </span>
                  <input
                    type="search"
                    value={varSearch}
                    onChange={(e) => setVarSearch(e.currentTarget.value)}
                    placeholder="Chercher une variable…"
                    className="w-full rounded-btn border border-line bg-frost/50 pl-9 pr-3 py-2 text-[12.5px] text-ink placeholder:text-ink/40 focus:border-cobalt focus:outline-none"
                  />
                </div>
                <p className="text-[11px] text-ink/55">
                  Cliquez un bouton d'insertion pour ajouter le token à
                  l'endroit voulu.
                </p>
                <div className="max-h-[560px] space-y-4 overflow-y-auto pr-1">
                  {groupedVars.length === 0 && (
                    <p className="text-[12px] text-ink/50 text-center py-6">
                      Aucune variable ne correspond.
                    </p>
                  )}
                  {groupedVars.map(([cat, vars]) => (
                    <div key={cat}>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-ink/50">
                        {catLabel(cat)}
                      </p>
                      <ul className="space-y-1.5">
                        {vars.map((v) => (
                          <li
                            key={v.key}
                            className="rounded-[10px] border border-line bg-white p-2.5"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <code className="text-[11.5px] font-bold text-cobalt">
                                  {`{{${v.key}}}`}
                                </code>
                                <p className="mt-0.5 text-[10.5px] text-ink/60 leading-snug">
                                  {v.description}
                                </p>
                                <p className="mt-0.5 truncate text-[10px] text-ink/40 font-mono">
                                  Ex : {v.example}
                                </p>
                              </div>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1">
                              {(["subject", "preheader", "html", "text"] as const).map((t) => (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => insertVar(v.key, t)}
                                  className="rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold text-ink/70 hover:border-cobalt hover:text-cobalt"
                                >
                                  +{t === "preheader" ? "preh." : t}
                                </button>
                              ))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {sidebarTab === "test" && (
              <form
                action={(fd) =>
                  startTransition(async () => {
                    const res: ActionState = await sendTemplateTestAction(
                      { status: "idle" },
                      fd
                    );
                    setTestMsg({
                      tone: res.status === "success" ? "success" : "error",
                      text: res.status === "idle" ? "" : res.message
                    });
                  })
                }
                className="p-4 space-y-3"
              >
                <p className="text-[11.5px] text-ink/60">
                  Envoie un email de test via le pipeline complet (provider,
                  rate-limit, log-only, allowlist). Utilise le modèle{" "}
                  <code className="rounded bg-ink/10 px-1 py-0.5 font-mono text-[10.5px]">
                    admin-test-email
                  </code>{" "}
                  — enregistrez d'abord ce modèle et utilisez « Aperçu » pour
                  valider le rendu de ce modèle-ci.
                </p>
                <label className="block text-[12px] font-semibold text-ink/70">
                  Adresse du destinataire
                  <input
                    type="email"
                    name="recipient"
                    required
                    placeholder="ops@example.com"
                    className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink placeholder:text-ink/35 focus:border-cobalt focus:outline-none"
                  />
                </label>
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-btn bg-lime px-3 py-2 text-[12.5px] font-bold text-ink w-full justify-center disabled:opacity-60"
                >
                  <IconSend />
                  Envoyer le test
                </button>
                {testMsg && testMsg.text && (
                  <p
                    className={
                      testMsg.tone === "success"
                        ? "rounded-btn bg-lime/20 px-3 py-2 text-[11.5px] font-semibold text-ink"
                        : "rounded-btn bg-red-100 px-3 py-2 text-[11.5px] font-semibold text-red-800"
                    }
                  >
                    {testMsg.text}
                  </p>
                )}
              </form>
            )}

            {sidebarTab === "history" && (
              <div className="p-4 space-y-2">
                <p className="text-[11.5px] text-ink/60">
                  Chaque enregistrement archive une version. Cliquez pour
                  restaurer.
                </p>
                <ul className="space-y-1">
                  {versions.map((v) => (
                    <li
                      key={v.id}
                      className="flex items-center justify-between rounded-btn border border-line bg-frost/40 px-3 py-2 text-[12px]"
                    >
                      <span>
                        <span className="font-bold text-ink">v{v.version}</span>
                        <span className="ml-2 text-ink/55">
                          {new Date(v.createdAt)
                            .toISOString()
                            .slice(0, 16)
                            .replace("T", " ")}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm(`Restaurer la version ${v.version} ?`))
                            return;
                          startTransition(async () => {
                            const res = await restoreVersionAction(initial.id!, v.id);
                            if (res.status === "success") {
                              window.location.reload();
                            } else if (res.status === "error") {
                              setMsg({ tone: "error", text: res.message });
                            }
                          });
                        }}
                        className="text-[11.5px] font-bold text-cobalt hover:underline"
                      >
                        Restaurer
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ─── Presentational bits ─────────────────────────────────────────────── */

function Card({
  title,
  hint,
  icon,
  tone,
  children
}: {
  title: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        tone === "danger"
          ? "rounded-[16px] border border-red-200 bg-red-50/30 overflow-hidden"
          : "rounded-[16px] border border-line bg-white overflow-hidden"
      }
    >
      <div className="flex items-start gap-3 border-b border-line bg-frost/40 px-5 py-3">
        <span
          className={
            tone === "danger"
              ? "grid h-7 w-7 place-items-center rounded-full bg-red-100 text-red-700"
              : "grid h-7 w-7 place-items-center rounded-full bg-cobalt/10 text-cobalt"
          }
        >
          {icon}
        </span>
        <div className="flex-1">
          <h3 className="text-[13.5px] font-bold text-ink">{title}</h3>
          {hint && <p className="text-[11.5px] text-ink/55 mt-0.5">{hint}</p>}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function TextField({
  label,
  name,
  value,
  onChange,
  required,
  placeholder
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="text-[12px] font-semibold text-ink/70">
      {label}
      <input
        name={name}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        required={required}
        placeholder={placeholder}
        className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink placeholder:text-ink/35 focus:border-cobalt focus:outline-none"
      />
    </label>
  );
}

function FieldWithCounter({
  label,
  name,
  value,
  onChange,
  required,
  placeholder,
  min,
  max,
  refCb
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  min: number;
  max: number;
  refCb: React.Ref<HTMLInputElement>;
}) {
  const len = value.length;
  const tone: "warn" | "ok" | "muted" =
    len === 0 ? "muted" : len < min || len > max ? "warn" : "ok";
  const toneCls =
    tone === "ok"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-amber-700"
        : "text-ink/40";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={`field-${name}`} className="text-[12px] font-semibold text-ink/70">
          {label}
        </label>
        <span className={`text-[10.5px] font-mono ${toneCls}`}>
          {len} / {max}
        </span>
      </div>
      <input
        id={`field-${name}`}
        ref={refCb}
        name={name}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        required={required}
        placeholder={placeholder}
        className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink placeholder:text-ink/35 focus:border-cobalt focus:outline-none"
      />
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  tone
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  tone?: "ok" | "neutral";
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line bg-frost/40 px-3 py-2.5">
      <span className="relative mt-0.5 inline-block h-5 w-9 flex-shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
          className="peer sr-only"
        />
        <span
          className={
            "block h-5 w-9 rounded-full transition-colors " +
            (checked
              ? tone === "ok"
                ? "bg-lime"
                : "bg-cobalt"
              : "bg-ink/20")
          }
        />
        <span
          className={
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform " +
            (checked ? "translate-x-4" : "translate-x-0")
          }
        />
      </span>
      <span className="flex-1">
        <span className="block text-[12.5px] font-semibold text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] text-ink/55">{hint}</span>}
      </span>
    </label>
  );
}

function TabPill({
  active,
  onClick,
  label
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-btn bg-ink px-3 py-1 text-[11.5px] font-bold text-lime"
          : "rounded-btn px-3 py-1 text-[11.5px] font-semibold text-ink/60 hover:text-ink"
      }
    >
      {label}
    </button>
  );
}

function SnippetBtn({
  onClick,
  label,
  tooltip,
  primary
}: {
  onClick: () => void;
  label: string;
  tooltip: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      className={
        primary
          ? "inline-flex h-7 items-center rounded-[6px] bg-cobalt px-2 text-[11.5px] font-bold text-white hover:bg-cobalt/90"
          : "inline-flex h-7 items-center rounded-[6px] border border-line bg-white px-2 text-[11.5px] font-bold text-ink/70 hover:border-cobalt hover:text-cobalt"
      }
    >
      {label}
    </button>
  );
}

function SidebarTabBtn({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex-1 border-b-2 border-cobalt bg-white px-3 py-2.5 text-[11.5px] font-bold text-cobalt inline-flex items-center justify-center gap-1.5"
          : "flex-1 border-b-2 border-transparent px-3 py-2.5 text-[11.5px] font-semibold text-ink/60 hover:text-ink inline-flex items-center justify-center gap-1.5"
      }
    >
      {icon}
      {label}
    </button>
  );
}

function DeviceBtn({
  active,
  onClick,
  icon
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "inline-flex h-7 w-7 items-center justify-center rounded-[6px] bg-ink text-lime"
          : "inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-ink/50 hover:text-ink"
      }
    >
      {icon}
    </button>
  );
}

function StatusBadge({
  active,
  isSystem,
  isNew
}: {
  active: boolean;
  isSystem: boolean;
  isNew: boolean;
}) {
  if (isNew) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-cobalt/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-cobalt">
        <Dot className="bg-cobalt" /> Brouillon
      </span>
    );
  }
  return active ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-lime/25 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink">
      <Dot className="bg-lime" /> Actif
      {isSystem && <span className="text-ink/50">· Système</span>}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink/8 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink/60">
      <Dot className="bg-ink/40" /> Inactif
      {isSystem && <span className="text-ink/50">· Système</span>}
    </span>
  );
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} />;
}

/* ─── Icons ────────────────────────────────────────────────────────────── */

function IconMeta() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function IconSubject() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="14" y2="15" />
    </svg>
  );
}
function IconCode() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function IconLayout() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </svg>
  );
}
function IconDanger() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconVar() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="7" y1="4" x2="4" y2="20" />
      <line x1="20" y1="4" x2="17" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function IconSave() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  );
}
function IconDesktop() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
function IconMobile() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  CATEGORY_LABEL,
  EMAIL_TEMPLATES,
  EMAIL_VARIABLES,
  composeEmailContent,
  templateBodyToText,
  type EmailTemplate,
  type EmailTemplateCategory,
  type EmailVarKey
} from "@/lib/admin/email-templates";
import { renderEmail } from "@/lib/email/render";
import { sendEmail, type SendState } from "./actions";
import { cn } from "@/lib/utils";

const initial: SendState = { status: "idle" };

type Participant = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  tier: string | null;
  gate: string | null;
  ticketCode: string | null;
  paymentAmount: number | null;
  paymentRef: string | null;
};

type HistoryItem = {
  id: string;
  subject: string;
  templateKey: string | null;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  body: string;
  html: string | null;
  toEmail: string;
  sender: { id: string; name: string; email: string } | null;
};

type PreviewSize = "desktop" | "mobile";

export function EmailComposer({
  participant,
  templates,
  history
}: {
  participant: Participant;
  templates: EmailTemplate[];
  history: HistoryItem[];
}) {
  const [templateKey, setTemplateKey] = useState<string>("");
  const [subject, setSubject] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [previewMode, setPreviewMode] = useState(false);
  const [previewSize, setPreviewSize] = useState<PreviewSize>("desktop");
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [state, action] = useActionState(
    sendEmail.bind(null, participant.id),
    initial
  );

  const vars = useMemo(
    () => ({
      firstName: participant.firstName,
      lastName: participant.lastName,
      fullName: `${participant.firstName} ${participant.lastName}`,
      email: participant.email,
      tier: (participant.tier ?? "").replace("_", " "),
      gate: participant.gate ?? "",
      ticketCode: participant.ticketCode ?? "",
      paymentAmount:
        participant.paymentAmount != null
          ? participant.paymentAmount.toLocaleString("fr-FR")
          : "",
      paymentRef: participant.paymentRef ?? "",
      eventDate: "3 – 5 janvier 2017",
      eventVenue: "CIC Alger"
    }),
    [participant]
  );

  function applyTemplate(t: EmailTemplate) {
    setTemplateKey(t.key);
    setSubject(t.subject);
    setBody(templateBodyToText(t));
  }

  function clearTemplate() {
    setTemplateKey("");
    setSubject("");
    setBody("");
  }

  function insertVariable(v: EmailVarKey) {
    const el = bodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + `{{${v}}}` + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + `{{${v}}}`.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const activeTemplate = useMemo(
    () => templates.find((t) => t.key === templateKey),
    [templates, templateKey]
  );

  // Live-render the branded email HTML from current inputs.
  const rendered = useMemo(() => {
    const content = composeEmailContent({
      template: activeTemplate,
      bodyText: body
    });
    return renderEmail({ subject: subject || "BIS 2027", content, vars });
  }, [activeTemplate, body, subject, vars]);

  useEffect(() => {
    if (state.status === "success") setPreviewMode(false);
  }, [state]);

  const grouped = useMemo(() => {
    const m = new Map<EmailTemplateCategory, EmailTemplate[]>();
    for (const t of templates) {
      if (!m.has(t.category)) m.set(t.category, []);
      m.get(t.category)!.push(t);
    }
    return m;
  }, [templates]);

  const err =
    state.status === "error" ? state.fieldErrors ?? {} : ({} as Record<string, string>);

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      {/* Template sidebar */}
      <aside className="lg:col-span-4">
        <div className="rounded-card border border-line bg-white">
          <div className="border-b border-line px-5 py-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Modèles prêts
            </p>
            <p className="mt-1 text-[12px] text-ink/60">
              Chaque modèle applique l&apos;identité BIS (header, footer,
              signature, mise en page).
            </p>
          </div>
          <div className="max-h-[560px] overflow-y-auto p-3">
            {Array.from(grouped.entries()).map(([cat, list]) => (
              <div key={cat} className="mb-3 last:mb-0">
                <p className="mb-1 px-2 text-[9.5px] font-bold uppercase tracking-[0.24em] text-ink/45">
                  {CATEGORY_LABEL[cat]}
                </p>
                <ul className="space-y-1">
                  {list.map((t) => {
                    const active = t.key === templateKey;
                    return (
                      <li key={t.key}>
                        <button
                          type="button"
                          onClick={() => applyTemplate(t)}
                          className={cn(
                            "block w-full rounded-btn px-3 py-2 text-left transition-colors",
                            active
                              ? "bg-cobalt/10 ring-1 ring-cobalt/40"
                              : "hover:bg-frost"
                          )}
                        >
                          <p
                            className={cn(
                              "text-[13px] font-semibold",
                              active ? "text-cobalt" : "text-ink"
                            )}
                          >
                            {t.label}
                          </p>
                          <p className="mt-0.5 line-clamp-1 text-[11px] text-ink/55">
                            {t.description}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            <button
              type="button"
              onClick={clearTemplate}
              className="mt-2 w-full rounded-btn border border-dashed border-line px-3 py-2 text-[12px] font-semibold text-ink/60 hover:border-ink/30 hover:text-ink"
            >
              + Écrire un message vierge
            </button>
          </div>
        </div>

        {/* Variables */}
        <div className="mt-5 rounded-card border border-line bg-white">
          <div className="border-b border-line px-5 py-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Variables disponibles
            </p>
            <p className="mt-1 text-[11px] text-ink/50">
              Cliquez pour insérer dans le message.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 p-3">
            {EMAIL_VARIABLES.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => insertVariable(v)}
                className="rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-cobalt hover:bg-cobalt/5 hover:text-cobalt"
                title={`Insérer {{${v}}}`}
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </div>

        {/* History */}
        <div className="mt-5 rounded-card border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Historique
            </p>
            <span className="rounded-full bg-ink/[0.06] px-2 py-[3px] text-[10.5px] font-bold tabular-nums text-ink/70">
              {history.length}
            </span>
          </div>
          {history.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-ink/55">
              Aucun email envoyé à ce contact.
            </p>
          ) : (
            <ul className="max-h-[420px] divide-y divide-line overflow-y-auto">
              {history.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => setOpenHistoryId(h.id)}
                    className="block w-full px-5 py-3 text-left transition-colors hover:bg-frost"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-1 flex-1 text-[12.5px] font-semibold text-ink">
                        {h.subject}
                      </p>
                      <StatusPill status={h.status} />
                    </div>
                    <p className="mt-1 text-[10.5px] uppercase tracking-[0.18em] text-ink/45">
                      {new Intl.DateTimeFormat("fr-FR", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit"
                      }).format(h.createdAt)}
                      {h.templateKey && ` · ${h.templateKey}`}
                    </p>
                    {h.sender && (
                      <p className="mt-0.5 text-[10.5px] text-ink/50">
                        par {h.sender.name}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* History preview modal */}
        <HistoryModal
          item={history.find((h) => h.id === openHistoryId) ?? null}
          onClose={() => setOpenHistoryId(null)}
        />
      </aside>

      {/* Composer */}
      <div className="lg:col-span-8">
        <form action={action} className="rounded-card border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="min-w-0">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
                Destinataire
              </p>
              <p className="mt-0.5 truncate text-[13px] font-semibold text-ink">
                {participant.firstName} {participant.lastName} ·{" "}
                <span className="text-ink/60">{participant.email}</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              {previewMode && (
                <div className="inline-flex rounded-btn border border-line bg-white p-0.5">
                  <button
                    type="button"
                    onClick={() => setPreviewSize("desktop")}
                    className={cn(
                      "rounded-[6px] px-2.5 py-1 text-[11px] font-semibold transition-colors",
                      previewSize === "desktop"
                        ? "bg-ink text-white"
                        : "text-ink/60 hover:text-ink"
                    )}
                  >
                    Desktop
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewSize("mobile")}
                    className={cn(
                      "rounded-[6px] px-2.5 py-1 text-[11px] font-semibold transition-colors",
                      previewSize === "mobile"
                        ? "bg-ink text-white"
                        : "text-ink/60 hover:text-ink"
                    )}
                  >
                    Mobile
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setPreviewMode((v) => !v)}
                className={cn(
                  "rounded-btn border px-3 py-1.5 text-[11.5px] font-semibold transition-colors",
                  previewMode
                    ? "border-cobalt bg-cobalt text-white"
                    : "border-line bg-white text-ink hover:border-ink/30"
                )}
              >
                {previewMode ? "Retour à l'éditeur" : "Aperçu"}
              </button>
            </div>
          </div>

          <input type="hidden" name="templateKey" value={templateKey} />

          {previewMode ? (
            <div className="flex justify-center bg-frost p-6">
              <div
                className="overflow-hidden rounded-[10px] border border-line bg-white transition-[width] duration-300"
                style={{
                  width: previewSize === "mobile" ? 375 : 656,
                  maxWidth: "100%"
                }}
              >
                <iframe
                  title="Aperçu email"
                  srcDoc={rendered.html}
                  className="block h-[680px] w-full border-0 bg-white"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 px-5 py-5">
              <div>
                <label
                  htmlFor="subject"
                  className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55"
                >
                  Sujet
                </label>
                <input
                  id="subject"
                  name="subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Objet du message"
                  className={cn(
                    "mt-1.5 w-full rounded-btn border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none",
                    "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
                    err.subject && "border-red-400"
                  )}
                />
                {err.subject && (
                  <p className="mt-1 text-[11px] text-red-600">{err.subject}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="body"
                  className="flex items-center justify-between text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55"
                >
                  <span>Message</span>
                  <span className="font-medium normal-case tracking-normal text-ink/40">
                    Header · footer · signature ajoutés automatiquement
                  </span>
                </label>
                <textarea
                  id="body"
                  name="body"
                  ref={bodyRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={14}
                  placeholder={
                    "Bonjour {{firstName}},\n\nVotre message ici (une ligne vide = nouveau paragraphe)."
                  }
                  className={cn(
                    "mt-1.5 w-full resize-y rounded-btn border border-line bg-white px-3 py-3 font-mono text-[13px] leading-relaxed text-ink outline-none",
                    "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
                    err.body && "border-red-400"
                  )}
                />
                {err.body && (
                  <p className="mt-1 text-[11px] text-red-600">{err.body}</p>
                )}
              </div>

              <p className="text-[11.5px] text-ink/50">
                Les variables entre <code className="font-mono">{"{{ }}"}</code>{" "}
                sont automatiquement remplacées. Le modèle sélectionné apporte
                l&apos;eyebrow, l&apos;en-tête, l&apos;info-card et le CTA — vous
                éditez uniquement le corps du message.
              </p>
            </div>
          )}

          {/* Feedback */}
          {state.status === "success" && (
            <div className="mx-5 mb-4 rounded-btn border border-lime/40 bg-lime/10 px-3.5 py-3 text-[12.5px] text-ink">
              <p className="font-semibold">{state.message}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <a
                  href={state.mailtoUrl}
                  className="inline-flex items-center gap-1.5 rounded-btn border border-cobalt bg-cobalt/10 px-2.5 py-1 text-[11.5px] font-bold text-cobalt hover:bg-cobalt hover:text-white"
                >
                  Ouvrir dans mon client mail
                </a>
                <span className="text-[11.5px] text-ink/60">
                  L&apos;HTML complet est stocké dans l&apos;audit trail. Intégrez
                  votre SMTP côté serveur pour l&apos;envoi automatique.
                </span>
              </div>
            </div>
          )}
          {state.status === "error" && (
            <div
              role="alert"
              className="mx-5 mb-4 rounded-btn border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
            >
              {state.message}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line bg-frost px-5 py-3">
            <p className="mr-auto text-[11.5px] text-ink/55">
              À · <span className="font-semibold text-ink">{participant.email}</span>
            </p>
            <Submit disabled={previewMode} />
          </div>
        </form>
      </div>
    </div>
  );
}

function Submit({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={cn(
        "inline-flex items-center gap-2 rounded-btn bg-lime px-5 py-2.5 text-[13px] font-bold text-ink transition-all",
        "hover:bg-lime-600 disabled:cursor-not-allowed disabled:opacity-70"
      )}
    >
      {pending ? (
        <>
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/60 border-t-transparent" />
          Envoi…
        </>
      ) : (
        <>
          Envoyer le message
          <span aria-hidden>→</span>
        </>
      )}
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  const style =
    s === "SENT"
      ? "bg-lime/25 text-ink"
      : s === "QUEUED"
        ? "bg-cobalt/10 text-cobalt"
        : s === "FAILED"
          ? "bg-red-100 text-red-800"
          : "bg-ink/[0.06] text-ink/60";
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
        style
      )}
    >
      {s}
    </span>
  );
}

function HistoryModal({
  item,
  onClose
}: {
  item: HistoryItem | null;
  onClose: () => void;
}) {
  const [size, setSize] = useState<PreviewSize>("desktop");

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  const dt = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-preview-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 bg-navy/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex max-h-[92vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[16px] border border-line bg-white shadow-[0_40px_100px_-40px_rgba(15,25,60,0.5)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Email · {item.templateKey ?? "message vierge"}
            </p>
            <h2
              id="history-preview-title"
              className="mt-1 truncate font-display text-lg font-black tracking-tight text-ink"
            >
              {item.subject}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink/55">
              <span>
                À · <span className="font-semibold text-ink">{item.toEmail}</span>
              </span>
              <span>·</span>
              <span>Créé le {dt.format(item.createdAt)}</span>
              {item.sentAt && (
                <>
                  <span>·</span>
                  <span>Envoyé le {dt.format(item.sentAt)}</span>
                </>
              )}
              {item.sender && (
                <>
                  <span>·</span>
                  <span>par {item.sender.name}</span>
                </>
              )}
              <StatusPill status={item.status} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {item.html && (
              <div className="inline-flex rounded-btn border border-line bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setSize("desktop")}
                  className={cn(
                    "rounded-[6px] px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    size === "desktop"
                      ? "bg-ink text-white"
                      : "text-ink/60 hover:text-ink"
                  )}
                >
                  Desktop
                </button>
                <button
                  type="button"
                  onClick={() => setSize("mobile")}
                  className={cn(
                    "rounded-[6px] px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    size === "mobile"
                      ? "bg-ink text-white"
                      : "text-ink/60 hover:text-ink"
                  )}
                >
                  Mobile
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink/60 transition-colors hover:border-ink/30 hover:text-ink"
              aria-label="Fermer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-frost p-6">
          {item.html ? (
            <div
              className="mx-auto overflow-hidden rounded-[10px] border border-line bg-white transition-[width] duration-300"
              style={{
                width: size === "mobile" ? 375 : 656,
                maxWidth: "100%"
              }}
            >
              <iframe
                title={item.subject}
                srcDoc={item.html}
                className="block h-[560px] w-full border-0 bg-white"
              />
            </div>
          ) : (
            <div className="mx-auto max-w-[656px] rounded-[10px] border border-line bg-white p-6">
              <p className="mb-3 text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
                Contenu texte
              </p>
              <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-ink">
                {item.body}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line bg-white px-5 py-3">
          <p className="text-[11px] text-ink/50">
            Cet email est un enregistrement d&apos;audit — il ne peut pas être
            modifié.
          </p>
          <div className="flex items-center gap-2">
            <a
              href={`mailto:${encodeURIComponent(item.toEmail)}?subject=${encodeURIComponent(item.subject)}&body=${encodeURIComponent(item.body)}`}
              className="rounded-btn border border-line bg-white px-3 py-1.5 text-[11.5px] font-semibold text-ink hover:border-ink/30"
            >
              Ré-ouvrir dans mon client mail
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-btn bg-ink px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-navy"
            >
              Fermer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Silence "unused" warning for the shared list re-export.
export { EMAIL_TEMPLATES };

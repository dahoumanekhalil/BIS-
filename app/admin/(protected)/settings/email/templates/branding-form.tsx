"use client";

import { useState, useTransition } from "react";
import { saveBrandingAction, type ActionState } from "./actions";
import type { EmailBranding } from "@/lib/email/templates/branding";

// Branding form — event identity, links and social profiles shared by
// every DB template. Grouped into three visually-distinct sub-cards so
// operators can scan the form quickly without a wall of inputs.
export function BrandingForm({ initial }: { initial: EmailBranding }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  return (
    <form
      action={(fd) =>
        startTransition(async () => {
          const res: ActionState = await saveBrandingAction({ status: "idle" }, fd);
          setMsg({
            tone: res.status === "success" ? "success" : "error",
            text: res.status === "idle" ? "" : res.message
          });
        })
      }
      className="space-y-5"
    >
      <p className="text-[12.5px] leading-relaxed text-ink/60">
        Ces valeurs alimentent le header et le footer de tous les modèles DB.
        Les modèles code continuent d'utiliser la configuration statique dans{" "}
        <code className="rounded bg-ink/10 px-1.5 py-0.5 text-[11px] font-mono">
          lib/email/tokens.ts
        </code>
        .
      </p>

      <SubCard title="Identité de l'événement" icon={<IconStar />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom court" name="eventName" defaultValue={initial.eventName} required />
          <Field label="Libellé complet" name="editionLabel" defaultValue={initial.editionLabel} required />
          <Field label="Dates" name="eventDate" defaultValue={initial.eventDate} required />
          <Field label="Lieu" name="eventVenue" defaultValue={initial.eventVenue} required />
          <Field label="Ville" name="eventCity" defaultValue={initial.eventCity} required />
          <Field
            label="Logo (URL)"
            name="logoUrl"
            defaultValue={initial.logoUrl ?? ""}
            placeholder="https://…"
          />
        </div>
      </SubCard>

      <SubCard title="Liens principaux" icon={<IconLink />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Site web" name="siteUrl" defaultValue={initial.siteUrl} placeholder="https://…" />
          <Field label="Page contact" name="contactUrl" defaultValue={initial.contactUrl} placeholder="https://…" />
          <Field label="Confidentialité" name="privacyUrl" defaultValue={initial.privacyUrl} placeholder="https://…" />
          <Field label="CGU" name="termsUrl" defaultValue={initial.termsUrl} placeholder="https://…" />
        </div>
      </SubCard>

      <SubCard title="Réseaux sociaux" icon={<IconShare />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="LinkedIn" name="socialLinkedIn" defaultValue={initial.socialLinkedIn} placeholder="https://linkedin.com/…" />
          <Field label="Instagram" name="socialInstagram" defaultValue={initial.socialInstagram} placeholder="https://instagram.com/…" />
          <Field label="Facebook" name="socialFacebook" defaultValue={initial.socialFacebook} placeholder="https://facebook.com/…" />
          <Field label="X (Twitter)" name="socialX" defaultValue={initial.socialX} placeholder="https://x.com/…" />
          <Field label="YouTube" name="socialYouTube" defaultValue={initial.socialYouTube} placeholder="https://youtube.com/…" />
        </div>
      </SubCard>

      <SubCard title="Copyright" icon={<IconInfo />}>
        <Field
          label="Mention de bas de page"
          name="footerNote"
          defaultValue={initial.footerNote}
        />
      </SubCard>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime disabled:opacity-60"
        >
          <IconSave />
          {pending ? "Enregistrement…" : "Enregistrer le branding"}
        </button>
        {msg && msg.text && (
          <p
            className={
              msg.tone === "success"
                ? "rounded-btn bg-lime/20 px-3 py-2 text-[12.5px] font-semibold text-ink"
                : "rounded-btn bg-red-100 px-3 py-2 text-[12.5px] font-semibold text-red-800"
            }
          >
            {msg.text}
          </p>
        )}
      </div>
    </form>
  );
}

/* ─── Presentational bits ─────────────────────────────────────────────── */

function SubCard({
  title,
  icon,
  children
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[14px] border border-line/70 bg-frost/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-cobalt border border-line">
          {icon}
        </span>
        <h4 className="text-[11px] font-bold uppercase tracking-[0.2em] text-ink/70">
          {title}
        </h4>
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  required,
  placeholder
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="text-[12px] font-semibold text-ink/70">
      {label}
      <input
        name={name}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink placeholder:text-ink/35 focus:border-cobalt focus:outline-none"
      />
    </label>
  );
}

function IconStar() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
function IconLink() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.72" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.72-1.72" />
    </svg>
  );
}
function IconShare() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}
function IconInfo() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
function IconSave() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

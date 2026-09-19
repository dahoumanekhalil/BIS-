"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { PartnerTier } from "@prisma/client";
import {
  createSponsor,
  updateSponsor,
  type SponsorState
} from "./actions";
import { cn } from "@/lib/utils";

const TIERS: PartnerTier[] = [
  PartnerTier.PRESENTING,
  PartnerTier.PLATINUM,
  PartnerTier.GOLD,
  PartnerTier.SILVER,
  PartnerTier.ECOSYSTEM,
  PartnerTier.MEDIA
];

const initial: SponsorState = { status: "idle" };

export type SponsorFormInitial = {
  name: string;
  tier: PartnerTier;
  order: number;
  website: string;
  logoUrl: string;
};

export function SponsorForm({
  mode,
  id,
  initial: init
}: {
  mode: "create" | "edit";
  id?: string;
  initial?: SponsorFormInitial;
}) {
  const action =
    mode === "edit" && id ? updateSponsor.bind(null, id) : createSponsor;
  const [state, formAction] = useActionState(action, initial);
  const [logoPreview, setLogoPreview] = useState<string | null>(
    init?.logoUrl || null
  );
  const [logoFileName, setLogoFileName] = useState<string | null>(null);
  const err =
    state.status === "error" ? state.fieldErrors ?? {} : ({} as Record<string, string>);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setLogoFileName(f.name);
    const url = URL.createObjectURL(f);
    setLogoPreview(url);
  }

  return (
    <form action={formAction} className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Main info */}
        <section className="rounded-card border border-line bg-white p-6 lg:col-span-8">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Informations
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              name="name"
              label="Nom"
              defaultValue={init?.name}
              required
              error={err.name}
              placeholder="Ex. ATLAS CAPITAL"
            />
            <Select
              name="tier"
              label="Tier"
              defaultValue={init?.tier ?? PartnerTier.ECOSYSTEM}
              options={TIERS}
            />
            <Field
              name="website"
              type="url"
              label="Site web"
              defaultValue={init?.website ?? ""}
              error={err.website}
              placeholder="https://…"
              hint="Facultatif"
            />
          </div>
          <p className="mt-3 text-[11.5px] text-ink/50">
            L&apos;ordre d&apos;affichage se règle directement par glisser-déposer
            depuis la liste des sponsors.
          </p>
        </section>

        {/* Logo */}
        <section className="rounded-card border border-line bg-white p-6 lg:col-span-4">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Logo
          </p>
          <div className="mt-4">
            <div className="flex h-40 items-center justify-center overflow-hidden rounded-btn border border-dashed border-line bg-frost p-4">
              {logoPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoPreview}
                  alt="Aperçu du logo"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="text-center">
                  <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-ink/40">
                    Aucun logo
                  </p>
                  <p className="mt-1 text-[11px] text-ink/40">
                    Chargez un fichier ou collez une URL
                  </p>
                </div>
              )}
            </div>

            <label className="mt-3 block">
              <span className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
                Charger un fichier
              </span>
              <input
                type="file"
                name="logoFile"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
                onChange={onFile}
                className="mt-1.5 block w-full text-[12px] text-ink file:mr-3 file:rounded-btn file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-[11.5px] file:font-bold file:text-white hover:file:bg-navy"
              />
              {logoFileName && (
                <p className="mt-1 text-[11px] text-ink/50">{logoFileName}</p>
              )}
              <p className="mt-1.5 text-[10.5px] text-ink/40">
                PNG · JPG · WEBP · SVG · GIF · max 2 Mo
              </p>
            </label>

            <label className="mt-3 block">
              <span className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
                …ou coller une URL
              </span>
              <input
                type="url"
                name="logoUrl"
                defaultValue={init?.logoUrl ?? ""}
                placeholder="https://…"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (!logoFileName) setLogoPreview(v || null);
                }}
                className={cn(
                  "mt-1.5 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] outline-none",
                  "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
                  err.logoUrl && "border-red-400"
                )}
              />
              {err.logoUrl && (
                <p className="mt-1 text-[11px] text-red-600">{err.logoUrl}</p>
              )}
            </label>
          </div>
        </section>
      </div>

      {state.status === "error" && (
        <div
          role="alert"
          className="rounded-btn border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
        >
          {state.message}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
        <Link
          href="/admin/sponsors"
          className="rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-semibold text-ink hover:border-ink/30"
        >
          Annuler
        </Link>
        <Submit mode={mode} />
      </div>
    </form>
  );
}

function Submit({ mode }: { mode: "create" | "edit" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "inline-flex items-center gap-2 rounded-btn bg-lime px-5 py-2.5 text-[13px] font-bold text-ink transition-all",
        "hover:bg-lime-600 disabled:cursor-not-allowed disabled:opacity-70"
      )}
    >
      {pending ? (
        <>
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/60 border-t-transparent" />
          {mode === "edit" ? "Enregistrement…" : "Création…"}
        </>
      ) : (
        <>
          {mode === "edit" ? "Enregistrer" : "Créer le sponsor"}
          <span aria-hidden>→</span>
        </>
      )}
    </button>
  );
}

function Field({
  name,
  label,
  type = "text",
  defaultValue,
  required,
  error,
  hint,
  placeholder
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="flex items-center justify-between text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55"
      >
        <span>
          {label}
          {required && <span className="text-cobalt"> *</span>}
        </span>
        {hint && (
          <span className="font-medium normal-case tracking-normal text-ink/40">
            {hint}
          </span>
        )}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={cn(
          "mt-1.5 w-full rounded-btn border bg-white px-3 py-2 text-[13.5px] text-ink outline-none",
          "border-line focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
          error && "border-red-400 focus:border-red-500 focus:ring-red-500/15"
        )}
      />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

function Select({
  name,
  label,
  defaultValue,
  options
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: string[];
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55"
      >
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        className="mt-1.5 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-cobalt focus:ring-2 focus:ring-cobalt/15"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace("_", " ")}
          </option>
        ))}
      </select>
    </div>
  );
}

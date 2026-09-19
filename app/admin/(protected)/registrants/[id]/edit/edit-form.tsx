"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { updateRegistrant, type UpdateState } from "../../actions";
import { cn } from "@/lib/utils";

const initial: UpdateState = { status: "idle" };

const TIERS = ["", "VVIP", "VIP", "VISITOR", "CONTENT_CREATOR", "IMPACT_MAKER"];
const STATUSES = ["PENDING", "CONFIRMED", "CANCELLED"];
const PAYMENTS = ["UNPAID", "PENDING", "PAID", "REFUNDED", "FAILED"];
const GATES = ["", "Gate A", "Gate B", "Gate C", "Gate D"];
const REG_TYPES = ["ATTENDEE", "STARTUP", "INVESTOR", "MEDIA", "PARTNER"];

export type EditInitial = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  organization: string;
  jobTitle: string;
  country: string;
  tier: string;
  gate: string;
  status: string;
  paymentStatus: string;
  paymentAmount: string;
  paymentRef: string;
  ticketCode: string;
  registrationType: string;
};

export function EditRegistrantForm({
  id,
  initial: init
}: {
  id: string;
  initial: EditInitial;
}) {
  const bound = updateRegistrant.bind(null, id);
  const [state, action] = useActionState(bound, initial);
  const err =
    state.status === "error" ? state.fieldErrors ?? {} : ({} as Record<string, string>);

  return (
    <form action={action} className="space-y-6">
      {/* IDENTITY */}
      <Section title="Identité">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="firstName"
            label="Prénom"
            defaultValue={init.firstName}
            required
            error={err.firstName}
          />
          <Field
            name="lastName"
            label="Nom"
            defaultValue={init.lastName}
            required
            error={err.lastName}
          />
          <Field
            name="email"
            type="email"
            label="Email"
            defaultValue={init.email}
            required
            error={err.email}
          />
          <Field
            name="phone"
            type="tel"
            label="Téléphone"
            defaultValue={init.phone}
            required
            error={err.phone}
          />
          <Field
            name="organization"
            label="Organisation"
            defaultValue={init.organization}
            error={err.organization}
          />
          <Field
            name="jobTitle"
            label="Fonction"
            defaultValue={init.jobTitle}
            error={err.jobTitle}
          />
          <Field
            name="country"
            label="Pays"
            defaultValue={init.country}
            required
            error={err.country}
          />
          <Select
            name="registrationType"
            label="Profil"
            defaultValue={init.registrationType}
            options={REG_TYPES}
          />
        </div>
      </Section>

      {/* TICKET & ACCESS */}
      <Section title="Ticket & accès">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="tier"
            label="Tier"
            defaultValue={init.tier}
            options={TIERS}
            format={(v) => (v === "" ? "— non défini" : v.replace("_", " "))}
          />
          <Select
            name="gate"
            label="Gate assigné"
            defaultValue={init.gate}
            options={GATES}
            format={(v) => (v === "" ? "— aucun" : v)}
          />
          <Field
            name="ticketCode"
            label="Code ticket"
            defaultValue={init.ticketCode}
            error={err.ticketCode}
            hint="Doit être unique"
            mono
          />
          <Select
            name="status"
            label="Statut inscription"
            defaultValue={init.status}
            options={STATUSES}
          />
        </div>
      </Section>

      {/* PAYMENT */}
      <Section title="Paiement">
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            name="paymentStatus"
            label="Statut paiement"
            defaultValue={init.paymentStatus}
            options={PAYMENTS}
          />
          <Field
            name="paymentAmount"
            label="Montant (DZD)"
            type="number"
            defaultValue={init.paymentAmount}
            error={err.paymentAmount}
            hint="Entier en dinars"
          />
          <Field
            name="paymentRef"
            label="Référence"
            defaultValue={init.paymentRef}
            error={err.paymentRef}
            mono
          />
        </div>
        <p className="mt-2 text-[11.5px] text-ink/50">
          Le passage à « PAID » enregistre automatiquement la date de règlement.
        </p>
      </Section>

      {/* Feedback */}
      {state.status === "success" && (
        <div
          role="status"
          className="rounded-btn border border-lime/40 bg-lime/10 px-3.5 py-2.5 text-[12.5px] text-ink"
        >
          {state.message}
        </div>
      )}
      {state.status === "error" && (
        <div
          role="alert"
          className="rounded-btn border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
        >
          {state.message}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
        <Link
          href={`/admin/registrants/${id}`}
          className="rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-semibold text-ink hover:border-ink/30"
        >
          Annuler
        </Link>
        <Submit />
      </div>
    </form>
  );
}

function Submit() {
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
          Enregistrement…
        </>
      ) : (
        <>
          Enregistrer les modifications
          <span aria-hidden>→</span>
        </>
      )}
    </button>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-line bg-white p-6">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        {title}
      </p>
      <div className="mt-4">{children}</div>
    </section>
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
  mono
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  mono?: boolean;
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
        aria-invalid={error ? true : undefined}
        className={cn(
          "mt-1.5 w-full rounded-btn border bg-white px-3 py-2 text-[13.5px] text-ink outline-none transition-colors",
          "border-line focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
          error && "border-red-400 focus:border-red-500 focus:ring-red-500/15",
          mono && "font-mono tracking-wider"
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
  options,
  format
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: string[];
  format?: (v: string) => string;
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
          <option key={o || "empty"} value={o}>
            {format ? format(o) : o.replace("_", " ") || "—"}
          </option>
        ))}
      </select>
    </div>
  );
}

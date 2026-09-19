"use client";

import { cn } from "@/lib/utils";
import type {
  ReactNode,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  ButtonHTMLAttributes
} from "react";
import { useFormStatus } from "react-dom";

/* ------------------------------ FIELD ------------------------------ */

type FieldProps = {
  name: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
};

export function FormField({
  name,
  label,
  required,
  error,
  hint,
  children,
  className
}: FieldProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <label
        htmlFor={name}
        className="block text-[11px] font-semibold uppercase tracking-[0.2em] text-black/60"
      >
        {label}
        {required && <span className="text-cobalt"> *</span>}
      </label>
      <div className="mt-2">{children}</div>
      {hint && !error && (
        <p className="mt-1 text-[11.5px] text-black/50">{hint}</p>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------ INPUTS ------------------------------ */

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export function TextInput({ invalid, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-2xl border border-black/10 bg-white px-4 py-3.5 text-sm outline-none transition-colors placeholder:text-black/30 focus:border-cobalt aria-[invalid=true]:border-red-400",
        className
      )}
    />
  );
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export function TextArea({ invalid, className, ...rest }: TextAreaProps) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-black/30 focus:border-cobalt aria-[invalid=true]:border-red-400",
        className
      )}
    />
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  options: { value: string; label: string }[];
  placeholder?: string;
};

export function Select({
  invalid,
  options,
  placeholder,
  className,
  ...rest
}: SelectProps) {
  return (
    <select
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full appearance-none rounded-2xl border border-black/10 bg-white px-4 py-3.5 text-sm outline-none transition-colors focus:border-cobalt aria-[invalid=true]:border-red-400",
        className
      )}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

type CheckboxProps = InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  error?: string;
};

export function Checkbox({ label, error, name, className, ...rest }: CheckboxProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <label className="flex items-start gap-3 text-sm text-ink/80">
        <input
          type="checkbox"
          name={name}
          {...rest}
          className="mt-1 h-4 w-4 rounded border-black/20 accent-cobalt"
        />
        <span>{label}</span>
      </label>
      {error && (
        <p className="ml-7 mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------ SECTION ------------------------------ */

export function FormSection({
  eyebrow,
  title,
  description,
  children
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-6">
      <header className="space-y-2">
        {eyebrow && (
          <p className="eyebrow">
            <span className="h-px w-6 bg-black/40" /> {eyebrow}
          </p>
        )}
        <h2 className="font-display text-2xl font-black tracking-tight text-ink">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-ink/60">{description}</p>
        )}
      </header>
      <div className="grid gap-6 md:grid-cols-2">{children}</div>
    </section>
  );
}

/* ------------------------------ FILE UPLOAD (URL fallback) ------------------------------ */

// UI wraps a URL field. Backed by a URL string for now; storage can be added
// later without changing the form contract.
export function FileUpload({
  name,
  label,
  hint,
  error,
  accept: _accept,
  defaultValue,
  required
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  accept?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <FormField
      name={name}
      label={label}
      hint={hint ?? "Lien https:// vers l'image (hébergement externe pour l'instant)."}
      error={error}
      required={required}
    >
      <TextInput
        id={name}
        name={name}
        type="url"
        inputMode="url"
        placeholder="https://…"
        defaultValue={defaultValue}
        invalid={!!error}
        required={required}
      />
    </FormField>
  );
}

/* ------------------------------ SUBMIT BUTTON ------------------------------ */

type SubmitProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pendingLabel?: string;
};

export function SubmitButton({
  children,
  pendingLabel = "Envoi en cours…",
  className,
  ...rest
}: SubmitProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || rest.disabled}
      {...rest}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-btn bg-cobalt px-6 py-3.5 text-sm font-semibold text-white transition-all duration-200 hover:bg-cobalt-700 disabled:opacity-60",
        className
      )}
    >
      {pending ? pendingLabel : children}
      {!pending && <span aria-hidden>→</span>}
    </button>
  );
}

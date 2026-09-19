"use client";

import { useState, useTransition } from "react";
import { AdminRole } from "@prisma/client";
import { ROLE_LABEL } from "@/lib/admin/rbac";
import { createUser, type CreateUserResult } from "@/app/actions/create-user";

const ROLES = Object.values(AdminRole);

export function CreateUserDialog() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CreateUserResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setResult(null);
    startTransition(async () => {
      const res = await createUser(formData);
      setResult(res);
      if (res.status === "success") {
        setOpen(false);
        // Reset form by closing and reopening would lose state;
        // instead we rely on server component revalidation via redirect-less approach.
        // The page will revalidate because of the server action's revalidatePath call.
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
        className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-[12px] font-bold uppercase tracking-[0.15em] text-white transition-all hover:bg-ink/90 active:scale-[0.98]"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        Nouvel utilisateur
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="font-display text-[16px] font-black tracking-tight text-ink">
                Créer un compte administrateur
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form action={handleSubmit} className="space-y-4">
              <Field label="Nom complet" name="name" required placeholder="ex: Karim Benali" />
              <Field label="Email" name="email" type="email" required placeholder="ex: karim@bis-algeria.dz" />
              <Field label="Mot de passe" name="password" type="password" required minLength={6} placeholder="Minimum 6 caractères" />

              <div>
                <label htmlFor="role" className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
                  Rôle
                </label>
                <select
                  id="role"
                  name="role"
                  required
                  className="mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>

              {result && result.status === "error" && (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] font-medium text-red-700">
                  {result.message}
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={isPending}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-lime px-5 py-2.5 text-[12px] font-bold uppercase tracking-[0.15em] text-ink transition-all hover:bg-lime/80 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isPending ? "Création…" : "Créer le compte"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.15em] text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink"
                >
                  Annuler
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  placeholder,
  minLength,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  minLength?: number;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        minLength={minLength}
        className="mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
      />
    </div>
  );
}
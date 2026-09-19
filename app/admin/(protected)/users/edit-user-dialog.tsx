"use client";

import { useState, useTransition } from "react";
import { AdminRole, AdminStatus } from "@prisma/client";
import { ROLE_LABEL } from "@/lib/admin/rbac";
import { updateUser, type UpdateUserResult } from "@/app/actions/update-user";

const ROLES = Object.values(AdminRole);
const STATUSES = Object.values(AdminStatus);

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: AdminStatus;
};

export function EditUserDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<UpdateUserResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setResult(null);
    startTransition(async () => {
      const res = await updateUser(formData);
      setResult(res);
      if (res.status === "success") {
        setOpen(false);
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
        className="rounded-md p-1.5 text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
        title="Modifier"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="font-display text-[16px] font-black tracking-tight text-ink">
                Modifier le compte
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
              <input type="hidden" name="id" value={user.id} />

              <Field label="Nom complet" name="name" required defaultValue={user.name} />
              <Field label="Email" name="email" type="email" required defaultValue={user.email} />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="role" className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
                    Rôle
                  </label>
                  <select
                    id="role"
                    name="role"
                    required
                    defaultValue={user.role}
                    className="mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="status" className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
                    Statut
                  </label>
                  <select
                    id="status"
                    name="status"
                    required
                    defaultValue={user.status}
                    className="mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
                  >
                    <option value={AdminStatus.ACTIVE}>Actif</option>
                    <option value={AdminStatus.DISABLED}>Désactivé</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
                  Nouveau mot de passe (optionnel)
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  minLength={6}
                  placeholder="Laisser vide pour ne pas changer"
                  className="mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
                />
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
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-ink px-5 py-2.5 text-[12px] font-bold uppercase tracking-[0.15em] text-white transition-all hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isPending ? "Sauvegarde…" : "Sauvegarder"}
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
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
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
        defaultValue={defaultValue}
        className="mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
      />
    </div>
  );
}
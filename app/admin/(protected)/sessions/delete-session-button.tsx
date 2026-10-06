"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteSession } from "./actions";
import { cn } from "@/lib/utils";

export function DeleteSessionButton({
  id,
  title,
  variant = "link"
}: {
  id: string;
  title: string;
  variant?: "link" | "solid";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirmDelete() {
    setError(null);
    startTransition(async () => {
      const res = await deleteSession(id);
      if (res.ok) {
        setOpen(false);
        router.push("/admin/sessions?flash=deleted");
        router.refresh();
      } else {
        setError(res.message);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className={cn(
          "inline-flex items-center rounded-btn text-[13px] font-semibold transition-colors",
          variant === "solid"
            ? "border border-red-300 bg-white px-4 py-2.5 text-[14px] text-red-700 hover:border-red-500 hover:bg-red-50"
            : "px-2.5 py-1.5 text-red-700 hover:bg-red-50"
        )}
      >
        Supprimer
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`del-session-${id}`}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            className="absolute inset-0 bg-navy/60 backdrop-blur-sm"
            onClick={() => !pending && setOpen(false)}
          />
          <div className="relative w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-[0_40px_100px_-40px_rgba(15,25,60,0.5)]">
            <h2
              id={`del-session-${id}`}
              className="font-display text-[18px] font-black tracking-tight text-ink"
            >
              Supprimer cette session ?
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-ink/70">
              «&nbsp;{title}&nbsp;» sera retirée définitivement du programme,
              y compris sur le site public. Cette action est irréversible.
            </p>
            {error && (
              <p
                role="alert"
                className="mt-3 rounded-btn border border-red-200 bg-red-50 px-3 py-2 text-[13.5px] text-red-800"
              >
                {error}
              </p>
            )}
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="rounded-btn border border-line bg-white px-4 py-2.5 text-[14px] font-semibold text-ink hover:border-ink/30 disabled:opacity-60"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={pending}
                className="rounded-btn bg-red-600 px-4 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-70"
              >
                {pending ? "Suppression…" : "Supprimer définitivement"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

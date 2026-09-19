"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteRegistrant } from "../actions";
import { cn } from "@/lib/utils";

export function DeleteRegistrantButton({
  id,
  name
}: {
  id: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const canDelete = confirmText.trim().toUpperCase() === "SUPPRIMER";

  function submit() {
    if (!canDelete) return;
    startTransition(async () => {
      try {
        await deleteRegistrant(id);
      } catch (e) {
        // Server action redirects on success — an actual error would land here.
        // NEXT_REDIRECT is thrown by redirect(); we swallow that as expected.
        const msg = (e as Error)?.message ?? "";
        if (!msg.includes("NEXT_REDIRECT")) {
          // eslint-disable-next-line no-console
          console.error(e);
          setOpen(false);
          router.refresh();
        }
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-btn border border-red-300 bg-white px-3 py-1.5 text-[12px] font-bold text-red-700 transition-colors hover:border-red-500 hover:bg-red-50"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6" />
        </svg>
        Supprimer
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="del-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            className="absolute inset-0 bg-navy/60 backdrop-blur-sm animate-[fade-up_200ms_ease-out_both]"
            onClick={() => !pending && setOpen(false)}
          />
          <div className="relative w-full max-w-md rounded-[16px] border border-line bg-white p-6 shadow-[0_40px_100px_-40px_rgba(15,25,60,0.5)] animate-[fade-up_260ms_ease-out_both]">
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-red-100 text-red-600"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </span>
              <div className="min-w-0">
                <h2
                  id="del-title"
                  className="font-display text-lg font-black tracking-tight text-ink"
                >
                  Supprimer {name} ?
                </h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink/65">
                  Cette action est <strong>irréversible</strong>. L&apos;inscrit,
                  son ticket, ses paiements et son historique de check-in
                  seront supprimés définitivement.
                </p>
              </div>
            </div>

            <label className="mt-5 block">
              <span className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55">
                Tapez « SUPPRIMER » pour confirmer
              </span>
              <input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="SUPPRIMER"
                className="mt-1.5 w-full rounded-btn border border-line bg-white px-3 py-2 font-mono text-[13.5px] tracking-wider text-ink outline-none focus:border-red-400 focus:ring-2 focus:ring-red-400/20"
                aria-label="Confirmation"
              />
            </label>

            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="rounded-btn border border-line bg-white px-4 py-2 text-[12.5px] font-semibold text-ink hover:border-ink/30 disabled:opacity-60"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!canDelete || pending}
                className={cn(
                  "inline-flex items-center gap-2 rounded-btn px-4 py-2 text-[12.5px] font-bold text-white transition-all",
                  canDelete
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-red-300 cursor-not-allowed",
                  pending && "opacity-70"
                )}
              >
                {pending ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/60 border-t-transparent" />
                    Suppression…
                  </>
                ) : (
                  "Supprimer définitivement"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

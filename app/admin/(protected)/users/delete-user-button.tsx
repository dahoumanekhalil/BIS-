"use client";

import { useState, useTransition } from "react";
import { deleteUser, type DeleteUserResult } from "@/app/actions/delete-user";

export function DeleteUserButton({
  userId,
  userName,
}: {
  userId: string;
  userName: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<DeleteUserResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    setResult(null);
    startTransition(async () => {
      const res = await deleteUser(userId);
      setResult(res);
      if (res.status === "success") {
        setConfirmOpen(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setResult(null);
          setConfirmOpen(true);
        }}
        className="rounded-md p-1.5 text-ink/40 transition-colors hover:bg-red-50 hover:text-red-600"
        title="Supprimer"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      </button>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl border border-line bg-white p-6 shadow-xl">
            <h3 className="font-display text-[16px] font-black tracking-tight text-ink">
              Confirmer la suppression
            </h3>
            <p className="mt-2 text-[13px] text-ink/60">
              Êtes-vous sûr de vouloir supprimer le compte de{" "}
              <strong className="text-ink">{userName}</strong> ? Cette action
              est irréversible.
            </p>

            {result && result.status === "error" && (
              <div
                role="alert"
                className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] font-medium text-red-700"
              >
                {result.message}
              </div>
            )}

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={handleDelete}
                disabled={isPending}
                className="inline-flex flex-1 items-center justify-center rounded-lg bg-red-600 px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.15em] text-white transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPending ? "Suppression…" : "Supprimer"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.15em] text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink"
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
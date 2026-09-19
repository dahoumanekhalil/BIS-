"use client";

import { useState, useTransition } from "react";
import { linkSpeakerAccount, type LinkSpeakerResult } from "@/app/actions/link-speaker-account";

type AdminUserOption = {
  id: string;
  name: string;
  email: string;
};

export function LinkAccountDialog({
  speakerId,
  speakerName,
  currentUserId,
  users,
}: {
  speakerId: string;
  speakerName: string;
  currentUserId: string | null;
  users: AdminUserOption[];
}) {
  const [open, setOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState(currentUserId ?? "");
  const [result, setResult] = useState<LinkSpeakerResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setResult(null);
    startTransition(async () => {
      const res = await linkSpeakerAccount(
        speakerId,
        selectedUserId || null
      );
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
          setSelectedUserId(currentUserId ?? "");
          setOpen(true);
        }}
        className="rounded-md p-1.5 text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
        title="Lier un compte"
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
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="font-display text-[16px] font-black tracking-tight text-ink">
                Lier un compte administrateur
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <p className="mb-4 text-[13px] text-ink/60">
              Associez un compte administrateur à{" "}
              <strong className="text-ink">{speakerName}</strong> pour lui
              permettre de se connecter et voir ses informations et sessions.
            </p>

            <div>
              <label
                htmlFor="adminUser"
                className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/55"
              >
                Compte administrateur
              </label>
              <select
                id="adminUser"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
              >
                <option value="">— Aucun compte (supprimer le lien) —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </div>

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
                onClick={handleSave}
                disabled={isPending}
                className="inline-flex flex-1 items-center justify-center rounded-lg bg-ink px-5 py-2.5 text-[12px] font-bold uppercase tracking-[0.15em] text-white transition-all hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
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
          </div>
        </div>
      )}
    </>
  );
}
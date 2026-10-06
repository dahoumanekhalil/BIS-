"use client";

import { useState, useTransition } from "react";
import { deleteMyAccount } from "@/app/actions/account";

// Self-service account deletion (required by the App Store and Google Play).
// Two deliberate frictions: the password AND the typed word. The server
// action re-checks both; nothing here is authoritative.
export function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ready = password.length > 0 && confirm === "SUPPRIMER";

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        // On success the action redirects (this promise never resolves with ok).
        const res = await deleteMyAccount({ password, confirm });
        if (res && res.ok === false) setError(res.message);
      } catch (e) {
        // NEXT_REDIRECT is thrown to perform the redirect — let it through.
        const msg = e instanceof Error ? e.message : "";
        if (!msg.includes("NEXT_REDIRECT")) {
          setError("Suppression impossible pour le moment.");
        }
      }
    });
  };

  return (
    <div>
      <p className="text-[13.5px] leading-relaxed text-ink/70">
        Vous pouvez supprimer définitivement votre compte BIS 2027. Votre
        inscription, votre badge et votre QR code seront supprimés
        immédiatement ; vos demandes (sponsor, intervenant…) seront
        anonymisées ; l&apos;historique d&apos;entrée est conservé sous forme
        anonyme. Cette action est irréversible.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-5 inline-flex w-full items-center justify-center rounded-btn border border-red-300 bg-red-50 px-4 py-2.5 text-[13px] font-bold text-red-800 hover:bg-red-100"
        >
          Supprimer mon compte
        </button>
      ) : (
        <div
          role="dialog"
          aria-label="Confirmer la suppression du compte"
          className="mt-5 space-y-3 rounded-lg border border-red-200 bg-red-50/60 p-4"
        >
          <label className="block text-[11px] font-bold uppercase tracking-[0.16em] text-ink/60">
            Mot de passe
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={200}
              className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-2 text-[14px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
            />
          </label>
          <label className="block text-[11px] font-bold uppercase tracking-[0.16em] text-ink/60">
            Tapez « SUPPRIMER » pour confirmer
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              maxLength={20}
              className="mt-1.5 block w-full rounded-btn border border-line bg-white px-3 py-2 text-[14px] font-normal normal-case tracking-normal text-ink outline-none focus:border-cobalt"
            />
          </label>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900"
            >
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={!ready || pending}
              className="inline-flex flex-1 items-center justify-center rounded-btn bg-red-700 px-4 py-2.5 text-[13px] font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Suppression…" : "Supprimer définitivement"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPassword("");
                setConfirm("");
                setError(null);
              }}
              disabled={pending}
              className="inline-flex items-center justify-center rounded-btn border border-ink/15 bg-white px-4 py-2.5 text-[13px] font-bold text-ink"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

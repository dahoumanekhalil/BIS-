"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import type { AccessPointType } from "@prisma/client";
import {
  validateMainEntranceTextScan,
  validateRoomTextScan
} from "./text-actions";
import type { ScannerValidationResult } from "./action-types";

// Phase 19 — collapsible text-code fallback panel inside the
// scanner workspace.
//
// The operator normally scans QR codes. When QR fails (bad lighting,
// damaged screen, camera issue), they open this panel, type the
// attendee's 14-character check-in code, and submit. The server
// action routes to the appropriate strict-permission validator based
// on the AccessPoint type.
//
// SECURITY:
//   • No client-side authorization decision — the panel only sends
//     `{code, slug}` and renders whatever the server returns.
//   • The raw code lives ONLY in this component's transient state
//     while the user is typing. Not persisted, not logged, not sent
//     over URLs. On submit success or failure, the input is cleared.
//   • Rate limiting lives on the server; the client honours the
//     THROTTLED message but does not enforce anything.

type Props = {
  accessPointSlug: string;
  accessPointType: AccessPointType;
  onResult: (result: ScannerValidationResult) => void;
};

export function TextFallback({
  accessPointSlug,
  accessPointType,
  onResult
}: Props) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim()) {
      setError("Saisissez le code participant.");
      return;
    }
    setSubmitting(true);
    startTransition(async () => {
      try {
        const action =
          accessPointType === "MAIN_ENTRANCE"
            ? validateMainEntranceTextScan
            : validateRoomTextScan;
        const result = await action({
          code,
          slug: accessPointSlug
        });
        // Clear the input BEFORE surfacing the result so the raw
        // code does not linger in the DOM after the operator has
        // seen the outcome.
        setCode("");
        onResult(result);
        // Auto-close on VALID so the operator can immediately scan
        // the next attendee. Keep open on failures so they can
        // retry / re-read the code.
        if (result.ok) setOpen(false);
      } catch {
        setError("Échec de la validation. Réessayez.");
      } finally {
        setSubmitting(false);
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
        className="inline-flex w-full items-center justify-center gap-2 rounded-btn border border-dashed border-line bg-white px-4 py-3 text-[13px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt sm:w-auto"
      >
        <svg
          aria-hidden
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" />
        </svg>
        Entrer le code manuellement
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-cobalt/25 bg-gradient-to-br from-cobalt/[0.05] to-cobalt/[0.01] p-5"
      aria-label="Saisie du code participant"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-cobalt">
          Code de secours
        </p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setCode("");
            setError(null);
          }}
          className="text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          Annuler
        </button>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink/65">
        À utiliser si le QR ne scanne pas. Le participant trouve son
        code sur la face avant de son badge.
      </p>
      <label className="mt-4 block">
        <span className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Code participant
        </span>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(formatCheckinCode(e.target.value))}
          maxLength={14}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          disabled={submitting}
          aria-label="Code de check-in du participant"
          className={cn(
            "mt-2 block w-full rounded-btn border-2 border-line bg-white px-4 py-3.5",
            "text-center font-mono text-[20px] font-bold tracking-[0.22em] text-ink outline-none placeholder:text-ink/25",
            "transition-colors focus:border-cobalt focus:ring-4 focus:ring-cobalt/10",
            "disabled:cursor-not-allowed disabled:opacity-60",
            "uppercase"
          )}
          style={{ textTransform: "uppercase" }}
        />
      </label>
      <button
        type="submit"
        disabled={submitting || !code.trim()}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-btn bg-cobalt px-4 py-3 text-[14px] font-bold text-white transition-colors hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <>
            <svg
              aria-hidden
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="animate-spin"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Validation…
          </>
        ) : (
          "Valider le code"
        )}
      </button>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900"
        >
          {error}
        </p>
      )}
    </form>
  );
}

// Formats a raw string as XXXX-XXXX-XXXX (uppercase alnum, hyphens
// every 4 chars, capped at 12 payload chars = 14 visible). Purely a
// UX helper for keyboard entry — the server accepts either format
// because it strips non-alnum before hashing. The formatter is
// deterministic and never emits characters outside [A-Z0-9-], so it
// cannot inject content into the input.
function formatCheckinCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const parts: string[] = [];
  for (let i = 0; i < cleaned.length; i += 4) parts.push(cleaned.slice(i, i + 4));
  return parts.join("-");
}

"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { cn } from "@/lib/utils";
import type { AccessPointType } from "@prisma/client";
import {
  validateMainEntranceQrScan,
  validateRoomQrScan
} from "./actions";
import type {
  ScannerOutcome,
  ScannerValidationResult
} from "./action-types";

// Phase 9 / 10 scanner client.
//
// This component decodes a QR credential from the camera and forwards
// the opaque credential to the Phase 10 server action for validation.
// It does NOT:
//   • verify the credential locally
//   • create a CheckIn locally
//   • persist the decoded value (cookies, localStorage, sessionStorage,
//     IndexedDB, or any other client store)
//   • log the decoded value (console, analytics, beacon)
//   • render the raw decoded string as text
//   • place the value in URLs or query params
//
// The decoded value exists only as a bound argument in the onDecode
// callback and as the `rawToken` field of the action invocation. Once
// the server action returns, the value is dropped — it is not stored
// in any React state and is not read from state to render anything.
//
// The action's structured result IS held in transient React state so
// the operator can see "Accès autorisé / refusé". That result contains
// only server-derived, safe-to-render fields (see action-types.ts).

// Camera / decode configuration — kept intentionally conservative:
//   fps 10:      enough to feel responsive without pegging CPU on tablets
//   qrbox 260:   comfortable target zone at both mobile and desktop widths
//   aspectRatio: square to avoid stretched preview
const CAMERA_CONFIG = { fps: 10, qrbox: 260, aspectRatio: 1.0 } as const;

// Small cooldown between accepted decodes — protects against the same
// QR being processed dozens of times per second when it stays in frame.
const COOLDOWN_MS = 1_500;

// Stable DOM id required by html5-qrcode. Only one scanner mount per
// page — the parent page ensures this because it renders exactly one
// <ScannerClient />.
const READER_ELEMENT_ID = "bis-scanner-view";

type ScannerState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "detected"; at: number }
  | { kind: "submitting" }
  | { kind: "result"; result: ScannerValidationResult }
  | { kind: "permission-denied" }
  | { kind: "no-camera" }
  | { kind: "error"; message: string }
  | { kind: "stopped" };

export function ScannerClient({
  accessPointName,
  accessPointType,
  accessPointSlug
}: {
  accessPointName: string;
  accessPointType: AccessPointType;
  accessPointSlug: string;
}) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const lastAcceptedAtRef = useRef<number>(0);
  // Cheap re-entrancy guard: while an action call is in flight, refuse
  // subsequent decodes. The library's `.pause(true)` also stops feeding
  // the callback, but this ref covers the tiny window between pause
  // and the state transition.
  const submittingRef = useRef<boolean>(false);
  const [state, setState] = useState<ScannerState>({ kind: "idle" });
  const [, startTransition] = useTransition();

  // Stop the camera cleanly. Safe to call from any state; swallows
  // library errors so the React unmount path never throws. The
  // library's `.stop()` / `.clear()` are typed as returning `void` in
  // some builds — wrap them in try/catch to defensively handle both
  // sync-throw and promise-reject shapes.
  const stopScanner = useCallback(async () => {
    const inst = scannerRef.current;
    if (!inst) return;
    try {
      // getState is inherited from Html5QrcodeCore; check it exists so
      // future library versions do not break the guard.
      const s = inst.getState?.();
      // 2 = SCANNING in the html5-qrcode enum. Only stop when active.
      if (s === 2) {
        try {
          await inst.stop();
        } catch {
          // library-side stop error is not actionable on teardown
        }
      }
      try {
        await inst.clear?.();
      } catch {
        // idem
      }
    } catch {
      // outer guard — teardown must never throw
    }
  }, []);

  // Start the camera. Runs once per mount and on operator-triggered
  // restart. Prefers the environment-facing camera on mobile via the
  // facingMode config — the library falls back to the first available
  // camera if the exact request is not satisfiable.
  const startScanner = useCallback(async () => {
    setState({ kind: "starting" });
    try {
      // Instantiate lazily so the html5-qrcode CJS module is not
      // imported into the client bundle until the operator opens a
      // scanner route.
      if (!scannerRef.current) {
        scannerRef.current = new Html5Qrcode(READER_ELEMENT_ID);
      }
      const inst = scannerRef.current;
      await inst.start(
        { facingMode: "environment" },
        CAMERA_CONFIG,
        // onDecode
        (decoded) => {
          // Cooldown: same or new QR staying in frame produces bursts —
          // one accepted decode per COOLDOWN_MS window is plenty.
          const now = Date.now();
          if (now - lastAcceptedAtRef.current < COOLDOWN_MS) return;
          // Re-entrancy guard for an in-flight submission.
          if (submittingRef.current) return;
          lastAcceptedAtRef.current = now;
          submittingRef.current = true;

          // Pause scanning while the server action runs. Deliberately
          // do NOT log or persist `decoded`.
          void inst.pause?.(true);
          setState({ kind: "submitting" });

          // Fire the server action inside a transition so React can
          // batch the pending state and avoid layout thrash.
          startTransition(() => {
            void submitDecoded(decoded);
          });
        },
        // onError — html5-qrcode calls this on every failed decode
        // attempt (many per second). Intentionally noisy from the lib
        // side; we simply ignore it, matching the library's own
        // recommendation.
        () => undefined
      );
      setState({ kind: "scanning" });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const lower = raw.toLowerCase();
      // Map the library's error surface to our small state enum. We
      // deliberately avoid rendering the raw browser error string —
      // it can carry userAgent leaks in some engines.
      if (
        lower.includes("permission") ||
        lower.includes("notallowed") ||
        lower.includes("denied")
      ) {
        setState({ kind: "permission-denied" });
      } else if (
        lower.includes("not found") ||
        lower.includes("no camera") ||
        lower.includes("notfound")
      ) {
        setState({ kind: "no-camera" });
      } else {
        setState({
          kind: "error",
          message: "Le scanner n'a pas pu démarrer."
        });
      }
    }
  }, []);

  // Invoke the server action. `decoded` is bound as an argument and is
  // NOT stored in state, cookies, URL, localStorage, or anything else.
  // The action's return value (safe, server-derived) IS stored so the
  // operator can see the outcome.
  //
  // Dispatch by the type prop that the server-rendered scanner page
  // passed down. That prop originates from the DB row the Phase 9
  // route resolved via `getAccessPointBySlug`, and Phase 9's route
  // already enforced the type-derived strict RBAC — so the type here
  // is trustworthy for CLIENT-SIDE ROUTING. Each server action still
  // enforces its own strict `requirePermission(...)` gate on entry,
  // and the pure validator core re-resolves the AccessPoint by slug
  // and re-verifies its type; the client dispatch is a UX choice,
  // never an authorization boundary.
  const submitDecoded = useCallback(
    async (decoded: string) => {
      const action =
        accessPointType === "MAIN_ENTRANCE"
          ? validateMainEntranceQrScan
          : validateRoomQrScan;
      try {
        const result = await action({
          rawToken: decoded,
          slug: accessPointSlug
        });
        setState({ kind: "result", result });
      } catch {
        // The server action should never throw for expected outcomes
        // (all denials come back as structured results). An actual
        // throw indicates a network/runtime problem — surface a
        // neutral error state, no internal details.
        setState({
          kind: "error",
          message: "La validation a échoué. Réessayez."
        });
      } finally {
        submittingRef.current = false;
      }
    },
    [accessPointSlug, accessPointType]
  );

  // Mount: start the camera. Unmount: cleanly stop it.
  useEffect(() => {
    void startScanner();
    return () => {
      void stopScanner();
    };
    // startScanner/stopScanner are stable useCallbacks; effect runs once
  }, [startScanner, stopScanner]);

  // "Reprendre" — clear the transient result state and resume scanning.
  const resume = useCallback(async () => {
    submittingRef.current = false;
    const inst = scannerRef.current;
    if (!inst) {
      await startScanner();
      return;
    }
    try {
      await inst.resume?.();
      setState({ kind: "scanning" });
    } catch {
      // Fall through to a fresh start if resume is not supported.
      await stopScanner();
      await startScanner();
    }
  }, [startScanner, stopScanner]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <section className="rounded-card border border-line bg-white p-4">
        <StateBadge
          state={state}
          type={accessPointType}
          name={accessPointName}
        />
        <div
          id={READER_ELEMENT_ID}
          className={cn(
            "mt-4 aspect-square w-full overflow-hidden rounded-lg bg-ink",
            // Hide the video area under refusal/result states so we do
            // not show an empty black square with no context.
            (state.kind === "permission-denied" ||
              state.kind === "no-camera" ||
              state.kind === "error" ||
              state.kind === "result") &&
              "hidden"
          )}
        />

        {state.kind === "permission-denied" && (
          <Panel
            tone="amber"
            title="Accès caméra refusé"
            body="Autorisez l'accès à la caméra dans les paramètres du navigateur, puis réessayez."
            action={{ label: "Réessayer", onClick: () => void startScanner() }}
          />
        )}
        {state.kind === "no-camera" && (
          <Panel
            tone="amber"
            title="Aucune caméra détectée"
            body="Connectez une caméra ou utilisez un appareil équipé, puis réessayez."
            action={{ label: "Réessayer", onClick: () => void startScanner() }}
          />
        )}
        {state.kind === "error" && (
          <Panel
            tone="amber"
            title="Erreur du scanner"
            body={state.message}
            action={{ label: "Réessayer", onClick: () => void startScanner() }}
          />
        )}

        {state.kind === "submitting" && (
          <Panel
            tone="cobalt"
            title="Validation en cours…"
            body="Merci de patienter, vérification du badge auprès du serveur."
          />
        )}

        {state.kind === "result" && (
          <ResultPanel
            result={state.result}
            onResume={() => void resume()}
          />
        )}
      </section>

      <aside className="grid gap-4">
        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Point d&apos;accès
          </p>
          <p className="mt-2 font-display text-lg font-black tracking-tight text-ink">
            {accessPointName}
          </p>
          <p className="mt-1 text-[11.5px] uppercase tracking-[0.16em] text-ink/55">
            {accessPointType === "MAIN_ENTRANCE"
              ? "Entrée principale"
              : "Salle"}
          </p>
        </div>
        <div className="rounded-card border border-dashed border-line bg-frost/60 p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Consignes
          </p>
          <ul className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-ink/70">
            <li className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cobalt"
              />
              <span>
                Centrez le QR du participant dans le cadre. Le scan se
                déclenche automatiquement.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cobalt"
              />
              <span>
                Le résultat s&apos;affiche dès que le serveur a validé
                le badge. Cliquez sur « Reprendre le scan » pour le
                participant suivant.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cobalt"
              />
              <span>
                Ne partagez jamais l&apos;URL de ce scanner en dehors du
                personnel autorisé.
              </span>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function StateBadge({
  state,
  type,
  name
}: {
  state: ScannerState;
  type: AccessPointType;
  name: string;
}) {
  const label = STATE_LABEL[state.kind];
  const tone = STATE_TONE[state.kind];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
          {type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle"} · {name}
        </p>
        <p className="mt-1 font-display text-lg font-black tracking-tight text-ink">
          {label}
        </p>
      </div>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em]",
          tone
        )}
      >
        <span
          aria-hidden
          className={cn("h-1.5 w-1.5 rounded-full", STATE_DOT[state.kind])}
        />
        {label}
      </span>
    </div>
  );
}

const STATE_LABEL: Record<ScannerState["kind"], string> = {
  idle: "Initialisation…",
  starting: "Démarrage caméra…",
  scanning: "Prêt à scanner",
  detected: "QR détecté",
  submitting: "Validation…",
  result: "Résultat",
  "permission-denied": "Caméra refusée",
  "no-camera": "Caméra indisponible",
  error: "Erreur",
  stopped: "Arrêté"
};

const STATE_TONE: Record<ScannerState["kind"], string> = {
  idle: "bg-ink/10 text-ink/60",
  starting: "bg-cobalt/15 text-cobalt",
  scanning: "bg-lime/25 text-ink",
  detected: "bg-cobalt/15 text-cobalt",
  submitting: "bg-cobalt/15 text-cobalt",
  result: "bg-ink/10 text-ink/70",
  "permission-denied": "bg-amber-100 text-amber-900",
  "no-camera": "bg-amber-100 text-amber-900",
  error: "bg-red-100 text-red-800",
  stopped: "bg-ink/10 text-ink/60"
};

const STATE_DOT: Record<ScannerState["kind"], string> = {
  idle: "bg-ink/40",
  starting: "bg-cobalt",
  scanning: "bg-lime-600",
  detected: "bg-cobalt",
  submitting: "bg-cobalt",
  result: "bg-ink/50",
  "permission-denied": "bg-amber-500",
  "no-camera": "bg-amber-500",
  error: "bg-red-600",
  stopped: "bg-ink/40"
};

// Result-specific tone map. Keeps the visual language stable across
// every server outcome — operators quickly learn "vert = passe, rouge
// = refus, ambre = ambigu (déjà entré)". Only the message text and
// tone come from the result — no internal fields are rendered.
const OUTCOME_TONE: Record<ScannerOutcome, "green" | "red" | "amber"> = {
  VALID: "green",
  ALREADY_CHECKED_IN: "amber",
  UNPAID: "red",
  CANCELLED: "red",
  PA_REVOKED: "red",
  PA_NOT_GRANTED: "red",
  BADGE_INVALID: "red",
  BADGE_REVOKED: "red",
  BADGE_EXPIRED: "red",
  ACCESS_POINT_INACTIVE: "red",
  ACCESS_POINT_WRONG_TYPE: "red",
  ACCESS_POINT_UNKNOWN: "red"
};

const OUTCOME_TITLE: Record<ScannerOutcome, string> = {
  VALID: "Accès autorisé",
  ALREADY_CHECKED_IN: "Déjà enregistré",
  UNPAID: "Paiement non confirmé",
  CANCELLED: "Inscription annulée",
  PA_REVOKED: "Accès refusé",
  PA_NOT_GRANTED: "Accès refusé",
  BADGE_INVALID: "Badge non reconnu",
  BADGE_REVOKED: "Badge révoqué",
  BADGE_EXPIRED: "Badge expiré",
  ACCESS_POINT_INACTIVE: "Point désactivé",
  ACCESS_POINT_WRONG_TYPE: "Mauvais point d'accès",
  ACCESS_POINT_UNKNOWN: "Point inconnu"
};

function ResultPanel({
  result,
  onResume
}: {
  result: ScannerValidationResult;
  onResume: () => void;
}) {
  const tone = OUTCOME_TONE[result.outcome];
  const title = OUTCOME_TITLE[result.outcome];
  const cls =
    tone === "green"
      ? "border-lime/40 bg-lime/[0.12]"
      : tone === "amber"
        ? "border-amber-300/60 bg-amber-50 text-amber-900"
        : "border-red-300/60 bg-red-50 text-red-900";
  const dot =
    tone === "green"
      ? "bg-lime-600"
      : tone === "amber"
        ? "bg-amber-500"
        : "bg-red-600";
  const btn =
    tone === "green"
      ? "bg-ink text-white hover:bg-ink/90"
      : tone === "amber"
        ? "bg-amber-700 text-white hover:bg-amber-800"
        : "bg-red-700 text-white hover:bg-red-800";

  return (
    <div className={cn("mt-4 rounded-lg border p-4", cls)}>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn("h-2 w-2 rounded-full", dot)}
        />
        <p className="font-display text-lg font-black tracking-tight">
          {title}
        </p>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed opacity-90">
        {result.message}
      </p>
      {result.participant && (
        <div className="mt-3 rounded-md border border-white/50 bg-white/70 px-3 py-2">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Participant
          </p>
          <p className="mt-1 font-display text-[15px] font-black tracking-tight text-ink">
            {result.participant.firstName} {result.participant.lastName}
          </p>
          {result.participant.tier && (
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink/60">
              {result.participant.tier}
            </p>
          )}
          {result.at && (
            <p className="mt-1 text-[11.5px] text-ink/60">
              {formatIsoTime(result.at)}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onResume}
        className={cn(
          "mt-4 inline-flex items-center rounded-btn px-3 py-1.5 text-[12px] font-bold transition-colors",
          btn
        )}
      >
        Reprendre le scan
      </button>
    </div>
  );
}

// Format an ISO timestamp as HH:MM in fr-FR. No external date library.
function formatIsoTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

function Panel({
  tone,
  title,
  body,
  action
}: {
  tone: "cobalt" | "amber";
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  const cls =
    tone === "cobalt"
      ? "border-cobalt/25 bg-cobalt/[0.06] text-ink"
      : "border-amber-300/60 bg-amber-50 text-amber-900";
  const btn =
    tone === "cobalt"
      ? "bg-cobalt text-white hover:bg-cobalt-700"
      : "bg-amber-700 text-white hover:bg-amber-800";
  return (
    <div className={cn("mt-4 rounded-lg border p-4", cls)}>
      <p className="font-display text-[15px] font-black tracking-tight">
        {title}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed opacity-90">
        {body}
      </p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            "mt-3 inline-flex items-center rounded-btn px-3 py-1.5 text-[12px] font-bold transition-colors",
            btn
          )}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { cn } from "@/lib/utils";
import type { AccessPointType } from "@prisma/client";
import {
  validateMainEntranceQrScan,
  validateRoomQrScan
} from "./actions";
import { TextFallback } from "./text-fallback";
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

// Module-level lock that serializes scanner teardown across mounts.
// React does not await async effect cleanups, so on client-side
// navigation between two scanner routes the outgoing instance's
// stop() is still in flight when the incoming instance calls
// getUserMedia — mobile browsers (iOS Safari, some Android Chromes)
// hold the previous stream and either hang the new request or return
// a black frame with no state change. Awaiting this promise inside
// startScanner ensures the browser has released the camera before we
// ask for it again. Refreshing the page always "fixed" it because a
// full document reload discards this whole runtime.
let pendingStop: Promise<void> = Promise.resolve();

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
  // Start with the camera closed. The operator opens it explicitly
  // via the "Démarrer la caméra" button. This preserves battery on
  // mobile devices and avoids the getUserMedia race that would leave
  // a black frame on client-side navigation between scanner routes.
  const [state, setState] = useState<ScannerState>({ kind: "stopped" });
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
    // Wait for any in-flight stop from a previous ScannerClient mount
    // to fully release the camera before we request it again. See the
    // comment on pendingStop above.
    try {
      await pendingStop;
    } catch {
      // A prior stop error is not actionable here — we only care that
      // the browser has had a chance to release the stream.
    }
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

  // Unmount: cleanly stop the camera if it was running. We do NOT
  // auto-start on mount — the operator opens the camera explicitly
  // via the "Démarrer la caméra" button.
  useEffect(() => {
    return () => {
      // Publish this stop to the module-level lock so the next
      // ScannerClient mount can await it before calling getUserMedia.
      // React does not await async cleanups itself.
      pendingStop = stopScanner();
    };
  }, [stopScanner]);

  // Operator-triggered close: fully tear down the html5-qrcode
  // instance so the next start allocates a fresh one. Nulling the ref
  // guarantees no stale library state (paused decoder, cached track)
  // survives across an open/close cycle.
  const closeCamera = useCallback(async () => {
    await stopScanner();
    scannerRef.current = null;
    submittingRef.current = false;
    lastAcceptedAtRef.current = 0;
    setState({ kind: "stopped" });
  }, [stopScanner]);

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

  const cameraLive =
    state.kind === "scanning" ||
    state.kind === "detected" ||
    state.kind === "starting";

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <section className="overflow-hidden rounded-card border border-line bg-white shadow-[0_1px_0_rgba(15,25,60,0.04),0_20px_50px_-30px_rgba(15,25,60,0.18)]">
        <StateHero
          state={state}
          type={accessPointType}
          name={accessPointName}
        />

        <div className="p-4 sm:p-5">
          <div
            className={cn(
              "relative w-full overflow-hidden rounded-xl bg-ink",
              // Hide the video area under refusal/result/stopped states
              // so we do not show an empty black square with no context.
              (state.kind === "permission-denied" ||
                state.kind === "no-camera" ||
                state.kind === "error" ||
                state.kind === "result" ||
                state.kind === "stopped") &&
                "hidden"
            )}
          >
            <div
              id={READER_ELEMENT_ID}
              className="aspect-square w-full [&_video]:!h-full [&_video]:!w-full [&_video]:object-cover"
            />
            {cameraLive && (
              <>
                {/* Corner-bracket viewfinder overlay. Purely
                    decorative — html5-qrcode's own qrbox indicator
                    remains in charge of the decode region. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-4 top-4 h-8 w-8 rounded-tl-md border-l-[3px] border-t-[3px] border-lime"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-4 top-4 h-8 w-8 rounded-tr-md border-r-[3px] border-t-[3px] border-lime"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-4 left-4 h-8 w-8 rounded-bl-md border-b-[3px] border-l-[3px] border-lime"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-4 right-4 h-8 w-8 rounded-br-md border-b-[3px] border-r-[3px] border-lime"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                  <span className="rounded-full bg-black/55 px-3 py-1 text-[11px] font-semibold text-white/90 backdrop-blur-sm">
                    Centrez le QR dans le cadre
                  </span>
                </div>
              </>
            )}
          </div>

          {cameraLive && (
            <button
              type="button"
              onClick={() => void closeCamera()}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-btn border border-line bg-white px-4 py-3 text-[13px] font-bold text-ink transition-colors hover:border-red-400 hover:text-red-700 sm:w-auto"
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
                <rect x="4" y="6" width="14" height="12" rx="2" />
                <line x1="20" y1="6" x2="20" y2="18" />
              </svg>
              Fermer la caméra
            </button>
          )}

          {state.kind === "stopped" && (
            <Panel
              tone="cobalt"
              title="Caméra fermée"
              body="Ouvrez la caméra pour scanner un badge. Fermez-la entre deux vagues de check-in pour préserver la batterie."
              action={{
                label: "Démarrer la caméra",
                onClick: () => void startScanner(),
                icon: (
                  <svg
                    aria-hidden
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                )
              }}
            />
          )}

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
              body="Vérification du badge auprès du serveur."
            />
          )}

          {state.kind === "result" && (
            <ResultPanel
              result={state.result}
              onResume={() => void resume()}
              onClose={() => void closeCamera()}
            />
          )}

          {/* Phase 19 — text-code fallback. Available whenever the
              camera is running, off, or has errored. Uses the same
              state.kind = "result" surface so the operator sees the
              same visual for both scan transports.

              The scanner and the fallback panel share the same
              re-entrancy guard: while an action is in flight, both
              paths are effectively disabled. */}
          <div className="mt-5 border-t border-line pt-5 print-hide">
            <TextFallback
              accessPointSlug={accessPointSlug}
              accessPointType={accessPointType}
              onResult={(r) => {
                // Pause camera if it is scanning, then present the
                // result the same way as a QR decode would.
                void scannerRef.current?.pause?.(true);
                submittingRef.current = false;
                setState({ kind: "result", result: r });
              }}
            />
          </div>
        </div>
      </section>

      <aside className="grid gap-4">
        <div className="rounded-card border border-line bg-white p-5">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Point d&apos;accès
          </p>
          <p className="mt-2 font-display text-xl font-black leading-tight tracking-tight text-ink">
            {accessPointName}
          </p>
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-frost px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink/70">
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                accessPointType === "MAIN_ENTRANCE" ? "bg-cobalt" : "bg-lime-600"
              )}
            />
            {accessPointType === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle"}
          </p>
        </div>
        <details className="group rounded-card border border-dashed border-line bg-frost/60 p-5 open:bg-frost/80">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/60 marker:hidden">
            Consignes
            <svg
              aria-hidden
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-transform group-open:rotate-180"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </summary>
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
                Le résultat s&apos;affiche dès que le serveur a validé le
                badge. Cliquez sur « Reprendre le scan » pour le suivant.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cobalt"
              />
              <span>
                Fermez la caméra entre deux vagues pour préserver la
                batterie. Ne partagez jamais l&apos;URL du scanner.
              </span>
            </li>
          </ul>
        </details>
      </aside>
    </div>
  );
}

// Full-width status hero at the top of the scanner card. Colour-coded
// so an operator can read the current state from across a booth, and
// uses a large-radius pulsing dot while the camera is live for a
// glanceable "the machine is on" cue.
function StateHero({
  state,
  type,
  name
}: {
  state: ScannerState;
  type: AccessPointType;
  name: string;
}) {
  const label = STATE_LABEL[state.kind];
  const hint = STATE_HINT[state.kind];
  const tone = STATE_HERO_TONE[state.kind];
  const pulse =
    state.kind === "scanning" ||
    state.kind === "starting" ||
    state.kind === "submitting" ||
    state.kind === "detected";

  return (
    <div className={cn("flex items-center justify-between gap-3 px-4 py-3 sm:px-5", tone.bg)}>
      <div className="min-w-0">
        <p className={cn("text-[10px] font-bold uppercase tracking-[0.22em]", tone.eyebrow)}>
          {type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle"} · {name}
        </p>
        <p className={cn("mt-1 font-display text-[17px] font-black leading-tight tracking-tight sm:text-lg", tone.text)}>
          {label}
        </p>
        {hint && (
          <p className={cn("mt-0.5 text-[11.5px] leading-snug", tone.text, "opacity-75")}>
            {hint}
          </p>
        )}
      </div>
      <span
        aria-hidden
        className={cn(
          "relative flex h-3 w-3 shrink-0 items-center justify-center rounded-full",
          tone.dotOuter
        )}
      >
        {pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-70",
              tone.dotPing
            )}
          />
        )}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", tone.dotCore)} />
      </span>
    </div>
  );
}

type HeroTone = {
  bg: string;
  eyebrow: string;
  text: string;
  dotOuter: string;
  dotPing: string;
  dotCore: string;
};

const STATE_HERO_TONE: Record<ScannerState["kind"], HeroTone> = {
  idle: {
    bg: "bg-ink/[0.04]",
    eyebrow: "text-ink/45",
    text: "text-ink",
    dotOuter: "bg-ink/10",
    dotPing: "bg-ink/40",
    dotCore: "bg-ink/60"
  },
  starting: {
    bg: "bg-cobalt/[0.10]",
    eyebrow: "text-cobalt",
    text: "text-ink",
    dotOuter: "bg-cobalt/25",
    dotPing: "bg-cobalt",
    dotCore: "bg-cobalt"
  },
  scanning: {
    bg: "bg-lime/[0.22]",
    eyebrow: "text-ink/70",
    text: "text-ink",
    dotOuter: "bg-lime/40",
    dotPing: "bg-lime-600",
    dotCore: "bg-lime-700"
  },
  detected: {
    bg: "bg-cobalt/[0.12]",
    eyebrow: "text-cobalt",
    text: "text-ink",
    dotOuter: "bg-cobalt/25",
    dotPing: "bg-cobalt",
    dotCore: "bg-cobalt"
  },
  submitting: {
    bg: "bg-cobalt/[0.12]",
    eyebrow: "text-cobalt",
    text: "text-ink",
    dotOuter: "bg-cobalt/25",
    dotPing: "bg-cobalt",
    dotCore: "bg-cobalt"
  },
  result: {
    bg: "bg-ink/[0.04]",
    eyebrow: "text-ink/50",
    text: "text-ink",
    dotOuter: "bg-ink/10",
    dotPing: "bg-ink/40",
    dotCore: "bg-ink/70"
  },
  "permission-denied": {
    bg: "bg-amber-100",
    eyebrow: "text-amber-900/70",
    text: "text-amber-900",
    dotOuter: "bg-amber-300/60",
    dotPing: "bg-amber-500",
    dotCore: "bg-amber-600"
  },
  "no-camera": {
    bg: "bg-amber-100",
    eyebrow: "text-amber-900/70",
    text: "text-amber-900",
    dotOuter: "bg-amber-300/60",
    dotPing: "bg-amber-500",
    dotCore: "bg-amber-600"
  },
  error: {
    bg: "bg-red-100",
    eyebrow: "text-red-800/80",
    text: "text-red-900",
    dotOuter: "bg-red-300/60",
    dotPing: "bg-red-500",
    dotCore: "bg-red-600"
  },
  stopped: {
    bg: "bg-frost",
    eyebrow: "text-ink/45",
    text: "text-ink",
    dotOuter: "bg-ink/10",
    dotPing: "bg-ink/40",
    dotCore: "bg-ink/50"
  }
};

const STATE_HINT: Record<ScannerState["kind"], string | null> = {
  idle: null,
  starting: "Autorisation caméra en cours…",
  scanning: "Placez le QR devant la caméra.",
  detected: "QR reçu, envoi au serveur.",
  submitting: "Validation en cours…",
  result: null,
  "permission-denied": "Le navigateur bloque la caméra.",
  "no-camera": "Aucun périphérique caméra trouvé.",
  error: null,
  stopped: "Appuyez pour démarrer la caméra."
};

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
  stopped: "Caméra fermée"
};

// Result-specific tone map. Keeps the visual language stable across
// every server outcome — operators quickly learn "vert = passe, rouge
// = refus, ambre = ambigu (déjà entré)". Only the message text and
// tone come from the result — no internal fields are rendered.
const OUTCOME_TONE: Record<ScannerOutcome, "green" | "red" | "amber"> = {
  VALID: "green",
  ALREADY_CHECKED_IN: "amber",
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
  onResume,
  onClose
}: {
  result: ScannerValidationResult;
  onResume: () => void;
  onClose: () => void;
}) {
  const tone = OUTCOME_TONE[result.outcome];
  const title = OUTCOME_TITLE[result.outcome];
  const cls =
    tone === "green"
      ? "border-lime/50 bg-gradient-to-br from-lime/[0.18] to-lime/[0.06] text-ink"
      : tone === "amber"
        ? "border-amber-300/70 bg-gradient-to-br from-amber-100 to-amber-50 text-amber-950"
        : "border-red-300/70 bg-gradient-to-br from-red-100 to-red-50 text-red-950";
  const iconBg =
    tone === "green"
      ? "bg-lime text-ink"
      : tone === "amber"
        ? "bg-amber-500 text-white"
        : "bg-red-600 text-white";
  const btn =
    tone === "green"
      ? "bg-ink text-white hover:bg-ink/90"
      : tone === "amber"
        ? "bg-amber-700 text-white hover:bg-amber-800"
        : "bg-red-700 text-white hover:bg-red-800";

  return (
    <div className={cn("mt-4 overflow-hidden rounded-xl border shadow-sm", cls)}>
      <div className="flex items-start gap-3 p-5">
        <span
          aria-hidden
          className={cn(
            "flex h-11 w-11 flex-none items-center justify-center rounded-full",
            iconBg
          )}
        >
          {tone === "green" ? (
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="5 12 10 17 19 8" />
            </svg>
          ) : tone === "amber" ? (
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          ) : (
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-xl font-black leading-tight tracking-tight sm:text-2xl">
            {title}
          </p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed opacity-80">
            {result.message}
          </p>
        </div>
      </div>

      {result.participant && (
        <div className="mx-4 rounded-lg border border-white/60 bg-white/85 px-4 py-3 backdrop-blur-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50">
            Participant
          </p>
          <p className="mt-1.5 font-display text-[20px] font-black leading-tight tracking-tight text-ink sm:text-2xl">
            {result.participant.firstName} {result.participant.lastName}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {result.participant.tier && (
              <span className="inline-flex items-center rounded-full bg-frost px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink/70">
                {result.participant.tier}
              </span>
            )}
            {result.at && (
              <span className="text-[11.5px] font-semibold text-ink/60">
                {formatIsoTime(result.at)}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 p-4 pt-0 sm:flex-row">
        <button
          type="button"
          onClick={onResume}
          className={cn(
            "inline-flex flex-1 items-center justify-center gap-2 rounded-btn px-4 py-3 text-[14px] font-bold transition-colors",
            btn
          )}
        >
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
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Reprendre le scan
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center gap-2 rounded-btn border border-line bg-white px-4 py-3 text-[13px] font-bold text-ink transition-colors hover:border-red-400 hover:text-red-700"
        >
          Fermer la caméra
        </button>
      </div>
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
  action?: {
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
  };
}) {
  const cls =
    tone === "cobalt"
      ? "border-cobalt/25 bg-gradient-to-br from-cobalt/[0.08] to-cobalt/[0.02] text-ink"
      : "border-amber-300/60 bg-gradient-to-br from-amber-100 to-amber-50 text-amber-950";
  const btn =
    tone === "cobalt"
      ? "bg-cobalt text-white hover:bg-cobalt-700"
      : "bg-amber-700 text-white hover:bg-amber-800";
  return (
    <div className={cn("mt-4 rounded-xl border p-5", cls)}>
      <p className="font-display text-lg font-black tracking-tight">
        {title}
      </p>
      <p className="mt-2 text-[13px] leading-relaxed opacity-85">
        {body}
      </p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            "mt-4 inline-flex w-full items-center justify-center gap-2 rounded-btn px-4 py-3 text-[14px] font-bold transition-colors sm:w-auto",
            btn
          )}
        >
          {action.icon}
          {action.label}
        </button>
      )}
    </div>
  );
}

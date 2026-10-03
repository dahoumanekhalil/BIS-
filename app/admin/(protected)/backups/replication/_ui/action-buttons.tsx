"use client";

// Client action islands for the Google Drive replication surface
// (Plan §P.4). Every button here calls a Server Action that re-checks
// authorization + validates input server-side. Any "disabled" or
// "hidden" state below is UX ONLY — never authorization.
//
// This file MUST NOT import from `lib/db`, `lib/admin/auth`, `next/headers`,
// or `lib/backup/replication/**`. §P.5 hard rule. Data comes via
// server-action results only.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  bootstrapDriveFolderAction,
  reconcileRemoteAction,
  restoreFromDriveAction,
  retryReplicationAction,
  verifyRemoteAction
} from "../actions";

type SafeError = { code: string; publicMessage: string; operationId: string };

function isFailure(r: unknown): r is SafeError {
  return (
    typeof r === "object" &&
    r !== null &&
    "ok" in r &&
    (r as { ok: unknown }).ok === false &&
    "code" in r &&
    "publicMessage" in r &&
    "operationId" in r
  );
}

function InlineError({ err }: { err: SafeError }) {
  return (
    <p
      role="alert"
      className="mt-2 text-[12px] leading-relaxed text-red-800"
    >
      <span className="font-semibold">Échec ({err.code})</span> — {err.publicMessage}
      <br />
      <span className="font-mono text-[11px] text-red-800/70">
        Op {err.operationId}
      </span>
    </p>
  );
}

function InlineSuccess({ msg, opId }: { msg: string; opId?: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="mt-2 text-[12px] leading-relaxed text-emerald-800"
    >
      <span className="font-semibold">Succès</span> — {msg}
      {opId && (
        <>
          <br />
          <span className="font-mono text-[11px] text-emerald-800/70">
            Op {opId}
          </span>
        </>
      )}
    </p>
  );
}

// ─── Retry ─────────────────────────────────────────────────────────────────

export function RetryReplicationButton({ backupId }: { backupId: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "err"; err: SafeError }
    | { kind: "ok"; msg: string; opId: string }
  >({ kind: "idle" });
  const router = useRouter();
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setState({ kind: "idle" });
            const r = await retryReplicationAction(backupId);
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              setState({
                kind: "ok",
                msg: `${r.previousStatus} → ${r.nextStatus}`,
                opId: r.operationId
              });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30 disabled:opacity-60"
      >
        {pending ? "Reprogrammation…" : "Réessayer la réplication"}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg={state.msg} opId={state.opId} />}
    </div>
  );
}

// ─── Verify (METADATA / FULL_SHA256) ──────────────────────────────────────

export function VerifyRemoteButton({
  backupId,
  level,
  label
}: {
  backupId: string;
  level: "METADATA" | "FULL_SHA256";
  label: string;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "err"; err: SafeError }
    | { kind: "ok"; msg: string; opId: string }
  >({ kind: "idle" });
  const router = useRouter();
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setState({ kind: "idle" });
            const r = await verifyRemoteAction(backupId, level);
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              setState({
                kind: "ok",
                msg: `${r.level} · ${r.outcome}${r.errorCode ? ` (${r.errorCode})` : ""}`,
                opId: r.operationId
              });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30 disabled:opacity-60"
      >
        {pending ? "Vérification…" : label}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg={state.msg} opId={state.opId} />}
    </div>
  );
}

// ─── Reconcile ────────────────────────────────────────────────────────────

export function ReconcileRemoteButton({ backupId }: { backupId: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "err"; err: SafeError }
    | { kind: "ok"; msg: string; opId: string }
  >({ kind: "idle" });
  const router = useRouter();
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setState({ kind: "idle" });
            const r = await reconcileRemoteAction(backupId);
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              setState({
                kind: "ok",
                msg: `${r.outcome}${r.errorCode ? ` (${r.errorCode})` : ""}`,
                opId: r.operationId
              });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30 disabled:opacity-60"
      >
        {pending ? "Réconciliation…" : "Réconcilier"}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg={state.msg} opId={state.opId} />}
    </div>
  );
}

// ─── Restore from Drive (two-key, phrase + password) ──────────────────────

export function RestoreFromDriveButton({ backupId }: { backupId: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "confirm"; phrase: string; password: string }
    | { kind: "err"; err: SafeError }
    | { kind: "ok"; opId: string; msg: string }
  >({ kind: "idle" });
  const router = useRouter();
  const expected = `RESTORE ${backupId.slice(0, 8)}`;

  if (state.kind === "confirm") {
    const ready = state.phrase === expected && state.password.length > 0;
    return (
      <div className="rounded-btn border border-amber-300 bg-amber-50 p-3">
        <p className="text-[12.5px] font-semibold text-amber-950">
          Restauration distante — nécessite la phrase{" "}
          <span className="font-mono">{expected}</span> ET votre mot de passe
          administrateur.
        </p>
        <p className="mt-1 text-[11.5px] text-amber-900/80">
          Le fichier chiffré est téléchargé depuis Google Drive, vérifié
          localement, puis remis à l’engin de restauration existant
          (instantané de sécurité, ré-authentification par mot de passe,
          etc.).
        </p>
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-950">
              Phrase de confirmation
            </span>
            <input
              type="text"
              autoComplete="off"
              value={state.phrase}
              onChange={(e) =>
                setState({ ...state, phrase: e.target.value })
              }
              placeholder={expected}
              className="mt-1 w-full rounded-btn border border-amber-300 bg-white px-2 py-1 font-mono text-[12px] text-ink"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-950">
              Mot de passe administrateur
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={state.password}
              onChange={(e) =>
                setState({ ...state, password: e.target.value })
              }
              className="mt-1 w-full rounded-btn border border-amber-300 bg-white px-2 py-1 text-[12px] text-ink"
            />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setState({ kind: "idle" })}
            className="rounded-btn border border-line bg-white px-2 py-1 text-[11.5px] font-semibold text-ink"
          >
            Annuler
          </button>
          <button
            type="button"
            disabled={!ready || pending}
            onClick={() =>
              start(async () => {
                const r = await restoreFromDriveAction({
                  backupId,
                  confirmationPhrase: state.phrase,
                  adminPassword: state.password
                });
                if (isFailure(r)) {
                  setState({ kind: "err", err: r });
                  return;
                }
                if (r.ok) {
                  setState({
                    kind: "ok",
                    opId: r.operationId,
                    msg: `Résultat : ${r.outcome}`
                  });
                  router.refresh();
                }
              })
            }
            className="rounded-btn bg-ink px-2 py-1 text-[11.5px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-50"
          >
            {pending ? "Restauration…" : "Confirmer la restauration"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          setState({ kind: "confirm", phrase: "", password: "" })
        }
        className="inline-flex items-center rounded-btn border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-semibold text-amber-900 transition-colors hover:bg-amber-50"
      >
        Télécharger &amp; restaurer depuis Drive…
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && (
        <InlineSuccess msg={state.msg} opId={state.opId} />
      )}
    </div>
  );
}

// ─── Bootstrap Drive folder ────────────────────────────────────────────────

export function BootstrapDriveFolderButton() {
  const [pending, start] = useTransition();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "err"; err: SafeError }
    | { kind: "ok"; msg: string; opId: string }
  >({ kind: "idle" });
  const router = useRouter();
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setState({ kind: "idle" });
            const r = await bootstrapDriveFolderAction();
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              // We deliberately DO NOT display the folder id in the
              // toast — the plan says the settings tab surfaces only
              // categorical status labels, not raw identifiers. The
              // audit row carries the id for operators to look up.
              setState({
                kind: "ok",
                msg:
                  r.audit === "bootstrap"
                    ? "Dossier initialisé"
                    : "Dossier redécouvert",
                opId: r.operationId
              });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-60"
      >
        {pending ? "Redécouverte…" : "Redécouvrir le dossier Drive"}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg={state.msg} opId={state.opId} />}
    </div>
  );
}

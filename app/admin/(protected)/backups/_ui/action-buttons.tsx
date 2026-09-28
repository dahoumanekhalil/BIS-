"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createBackupAction,
  verifyBackupAction,
  deleteBackupAction,
  runSchedulerTickAction,
  runRetentionAction
} from "../actions";

// ─── Client action islands (Phase 9) ────────────────────────────────────────
//
// Every button here calls a server action; the server action re-checks
// authorization AND validates input. UI-side "disabled" is UX only —
// hiding is not authorization.
//
// Displayed error messages come from the server's SafeResult shape
// (`publicMessage` + `code` + `operationId`). Nothing is ever rendered
// from a raw JS Error. `operationId` is shown so an operator can look up
// the full detail in the audit log.

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

// ─── Create backup ─────────────────────────────────────────────────────────

export function CreateBackupButton() {
  const [pending, start] = useTransition();
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "err"; err: SafeError } | { kind: "ok"; opId: string }
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
            const r = await createBackupAction();
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              setState({ kind: "ok", opId: r.operationId });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-60"
      >
        {pending ? "Création en cours…" : "Créer une sauvegarde"}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && (
        <InlineSuccess
          msg="Sauvegarde créée et vérifiée."
          opId={state.opId}
        />
      )}
    </div>
  );
}

// ─── Manual scheduler tick ─────────────────────────────────────────────────

export function ManualTickButton() {
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
            const r = await runSchedulerTickAction();
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              setState({
                kind: "ok",
                msg: `Résultat : ${r.outcome}${r.backupId ? ` · ${r.backupId.slice(0, 8)}…` : ""}`,
                opId: r.operationId
              });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-ink/30 disabled:opacity-60"
      >
        {pending ? "Exécution…" : "Exécuter un tick"}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg={state.msg} opId={state.opId} />}
    </div>
  );
}

// ─── Manual retention ─────────────────────────────────────────────────────

export function ManualRetentionButton() {
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
            const r = await runRetentionAction();
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              setState({
                kind: "ok",
                msg: `${r.deleted} supprimées · ${r.protectedCount} protégées · ${r.failures} échecs`,
                opId: r.operationId
              });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-ink/30 disabled:opacity-60"
      >
        {pending ? "Prune en cours…" : "Exécuter le prune"}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg={state.msg} opId={state.opId} />}
    </div>
  );
}

// ─── Verify a specific backup ─────────────────────────────────────────────

export function VerifyBackupButton({ backupId }: { backupId: string }) {
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
            const r = await verifyBackupAction(backupId);
            if (isFailure(r)) {
              setState({ kind: "err", err: r });
              return;
            }
            if (r.ok) {
              setState({
                kind: "ok",
                msg: `Résultat : ${r.outcome} (${r.code})`,
                opId: r.operationId
              });
              router.refresh();
            }
          })
        }
        className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30 disabled:opacity-60"
      >
        {pending ? "Vérification…" : "Vérifier"}
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg={state.msg} opId={state.opId} />}
    </div>
  );
}

// ─── Delete backup (with typed confirmation) ─────────────────────────────

export function DeleteBackupButton({ backupId }: { backupId: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "confirm"; value: string }
    | { kind: "err"; err: SafeError }
    | { kind: "ok" }
  >({ kind: "idle" });
  const router = useRouter();
  const expected = `DELETE ${backupId.slice(0, 8)}`;

  if (state.kind === "confirm") {
    return (
      <div className="rounded-btn border border-red-200 bg-red-50 p-3">
        <p className="text-[12.5px] font-semibold text-red-900">
          Tapez <span className="font-mono">{expected}</span> pour confirmer
        </p>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={state.value}
            onChange={(e) =>
              setState({ kind: "confirm", value: e.target.value })
            }
            className="min-w-0 flex-1 rounded-btn border border-red-200 bg-white px-2 py-1 font-mono text-[12px] text-ink"
            placeholder={expected}
            aria-label="Confirmation phrase"
          />
          <button
            type="button"
            onClick={() => setState({ kind: "idle" })}
            className="rounded-btn border border-line bg-white px-2 py-1 text-[11.5px] font-semibold text-ink"
          >
            Annuler
          </button>
          <button
            type="button"
            disabled={state.value !== expected || pending}
            onClick={() =>
              start(async () => {
                const r = await deleteBackupAction(backupId);
                if (isFailure(r)) {
                  setState({ kind: "err", err: r });
                  return;
                }
                if (r.ok) {
                  setState({ kind: "ok" });
                  router.refresh();
                }
              })
            }
            className="rounded-btn bg-red-600 px-2 py-1 text-[11.5px] font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {pending ? "Suppression…" : "Confirmer la suppression"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setState({ kind: "confirm", value: "" })}
        className="inline-flex items-center rounded-btn border border-red-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-red-700 transition-colors hover:bg-red-50"
      >
        Supprimer…
      </button>
      {state.kind === "err" && <InlineError err={state.err} />}
      {state.kind === "ok" && <InlineSuccess msg="Sauvegarde supprimée." />}
    </div>
  );
}

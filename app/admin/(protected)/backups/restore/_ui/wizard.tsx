"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreBackupAction, verifyBackupAction } from "../../actions";

// ─── Restore wizard (Phase 9) ───────────────────────────────────────────────
//
// Three explicit steps. Every step's control flow lives here in the
// browser — but every security-sensitive check is server-side:
//
//   Step 1: pick a backup from the server-provided allowlist.
//   Step 2: run a fresh verify against the chosen backup. This is a
//           pre-flight preview only; the destructive path re-verifies
//           inside `runRestore` again. Never trust the UI to short-circuit.
//   Step 3: collect confirmation phrase (`RESTORE <first-8>`) + admin
//           password. Both are ONLY sent to the server action; the
//           server does timing-safe compare + scrypt re-auth.
//
// SUPER_ADMIN callers may check "Force" to authorize a restore against a
// schema-incompatible backup. Non-super users see the checkbox disabled
// and the server enforces the role gate independently.
//
// The wizard survives page refresh in the sense that it never carries
// state that the server does not already own. The `RestoreOperation`
// row IS the source of truth: refreshing the page re-fetches
// `activeRestore` from the server and the wizard rehydrates to a
// consistent view.

interface RestorableBackup {
  id: string;
  status: string;
  kind: string;
  startedAt: string;
  sizeBytes: string | null;
  appVersion: string;
}

interface ActiveRestore {
  id: string;
  status: string;
  backupId: string;
  startedAt: string;
}

interface CurrentUser {
  id: string;
  role: string;
  name: string;
}

type SafeError = {
  ok: false;
  code: string;
  publicMessage: string;
  operationId: string;
};

export function RestoreWizard({
  backups,
  activeRestore,
  currentUser
}: {
  backups: RestorableBackup[];
  activeRestore: ActiveRestore | null;
  currentUser: CurrentUser;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");
  const [phraseLocked, setPhraseLocked] = useState(true);
  const [password, setPassword] = useState("");
  const [force, setForce] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    | null
    | { ok: true; outcome: string; code: string; stage: string; totalRows?: number; schemaCompatible?: boolean; operationId: string }
    | SafeError
  >(null);
  const [restoreResult, setRestoreResult] = useState<null | {
    ok: boolean;
    code: string;
    publicMessage: string;
    operationId: string;
    restoreOperationId?: string;
    safetyBackupId?: string;
  }>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  if (activeRestore) {
    return (
      <div className="rounded-card border border-cobalt/40 bg-cobalt/[0.04] p-5">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
          Restauration en cours
        </p>
        <p className="mt-3 text-[13.5px]">
          Une restauration est déjà active :{" "}
          <span className="font-mono">{activeRestore.id.slice(0, 8)}…</span> ·{" "}
          {activeRestore.status} · démarrée le{" "}
          {new Date(activeRestore.startedAt).toLocaleString("fr-FR")}. Une seule
          opération de restauration peut être en cours à la fois.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      {/* Stepper rail */}
      <ol className="space-y-2">
        <StepRow index={1} current={step} label="Choisir une sauvegarde" />
        <StepRow index={2} current={step} label="Aperçu de la vérification" />
        <StepRow index={3} current={step} label="Confirmer + lancer" />
      </ol>

      <div className="rounded-card border border-line bg-white p-5">
        {step === 1 && (
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Étape 1 · Sauvegarde source
            </p>
            <p className="mt-2 text-[13px] text-ink/65">
              Sélectionnez une sauvegarde <em>vérifiée</em> ou{" "}
              <em>complétée</em> à restaurer.
            </p>
            <fieldset className="mt-4 divide-y divide-line rounded-btn border border-line">
              <legend className="sr-only">Liste des sauvegardes restaurables</legend>
              {backups.length === 0 && (
                <p className="p-4 text-[12.5px] text-ink/60">
                  Aucune sauvegarde restaurable disponible.
                </p>
              )}
              {backups.map((b) => (
                <label
                  key={b.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-ink/[0.02]"
                >
                  <input
                    type="radio"
                    name="backup"
                    value={b.id}
                    checked={selectedId === b.id}
                    onChange={() => setSelectedId(b.id)}
                    className="h-4 w-4"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[12.5px]">{b.id.slice(0, 12)}…</p>
                    <p className="text-[11.5px] text-ink/60">
                      {b.kind} · {b.status} · {formatSize(b.sizeBytes)} · {b.appVersion} ·{" "}
                      {new Date(b.startedAt).toLocaleString("fr-FR")}
                    </p>
                  </div>
                </label>
              ))}
            </fieldset>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                disabled={!selectedId}
                onClick={() => {
                  setStep(2);
                  setVerifyResult(null);
                }}
                className="inline-flex items-center rounded-btn bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-50"
              >
                Continuer →
              </button>
            </div>
          </div>
        )}

        {step === 2 && selectedId && (
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Étape 2 · Aperçu de la vérification
            </p>
            <p className="mt-2 text-[13px] text-ink/65">
              Cette vérification n&apos;est qu&apos;un aperçu. Le moteur de
              restauration relance systématiquement la vérification complète
              avant toute action destructive.
            </p>
            <div className="mt-4 space-y-3">
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await verifyBackupAction(selectedId);
                    setVerifyResult(r as typeof verifyResult);
                  })
                }
                className="inline-flex items-center rounded-btn border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-ink/30 disabled:opacity-60"
              >
                {pending ? "Vérification…" : "Lancer la vérification"}
              </button>
              {verifyResult && verifyResult.ok === false && (
                <p role="alert" className="text-[12.5px] text-red-800">
                  Échec ({verifyResult.code}) — {verifyResult.publicMessage}
                  <br />
                  <span className="font-mono text-[11px] text-red-800/70">
                    Op {verifyResult.operationId}
                  </span>
                </p>
              )}
              {verifyResult && verifyResult.ok === true && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-btn border border-emerald-200 bg-emerald-50 p-3 text-[12.5px] text-emerald-900"
                >
                  <p>
                    Résultat : <strong>{verifyResult.outcome}</strong> —{" "}
                    <span className="font-mono">
                      {verifyResult.code}
                    </span>{" "}
                    (stage <span className="font-mono">{verifyResult.stage}</span>)
                  </p>
                  {typeof verifyResult.totalRows === "number" && (
                    <p className="mt-1">
                      {verifyResult.totalRows.toLocaleString("fr-FR")} lignes attendues.
                    </p>
                  )}
                  {verifyResult.schemaCompatible === false && (
                    <p className="mt-1 text-amber-900">
                      Attention : schéma incompatible avec l&apos;application
                      actuelle. Un opérateur SUPER_ADMIN doit cocher
                      &ldquo;Forcer&rdquo; à l&apos;étape suivante pour continuer.
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="mt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="text-[12.5px] font-semibold text-ink/60 hover:text-ink"
              >
                ← Retour
              </button>
              <button
                type="button"
                disabled={!verifyResult || verifyResult.ok === false}
                onClick={() => {
                  setPhrase("");
                  setPhraseLocked(true);
                  setStep(3);
                }}
                className="inline-flex items-center rounded-btn bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-ink/85 disabled:opacity-50"
              >
                Continuer →
              </button>
            </div>
          </div>
        )}

        {step === 3 && selectedId && (
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Étape 3 · Confirmation et lancement
            </p>
            <p className="mt-2 text-[13px] text-ink/65">
              Vous vous apprêtez à remplacer la base par la sauvegarde{" "}
              <span className="font-mono">{selectedId.slice(0, 12)}…</span>.
              Cette action est irréversible sans la sauvegarde de sécurité.
            </p>
            <p className="mt-1 text-[12px] text-ink/55">
              Compte connecté : <strong>{currentUser.name}</strong> · rôle{" "}
              <span className="font-mono">{currentUser.role}</span>.
            </p>

            <form
              className="mt-5 grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                start(async () => {
                  const r = await restoreBackupAction({
                    backupId: selectedId,
                    confirmationPhrase: phrase,
                    adminPassword: password,
                    force
                  });
                  setRestoreResult({
                    ok: r.ok,
                    code: r.code,
                    publicMessage: r.publicMessage,
                    operationId: r.operationId,
                    restoreOperationId: r.restoreOperationId,
                    safetyBackupId: r.safetyBackupId
                  });
                  if (r.ok) {
                    // Successful restore invalidated our session — server
                    // will bounce us to /admin/login on next navigation.
                    router.refresh();
                  }
                });
              }}
            >
              <label className="block text-[12.5px]">
                <span className="font-semibold text-ink">
                  Phrase de confirmation
                </span>
                <p className="mt-1 text-[11.5px] text-ink/60">
                  Tapez <span className="font-mono">{`RESTORE ${selectedId.slice(0, 8)}`}</span>
                </p>
                <input
                  type="text"
                  name="restore-confirmation-phrase"
                  value={phrase}
                  placeholder={`RESTORE ${selectedId.slice(0, 8)}`}
                  readOnly={phraseLocked}
                  onFocus={() => setPhraseLocked(false)}
                  onChange={(e) => setPhrase(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore
                  data-form-type="other"
                  className="mt-2 w-full rounded-btn border border-line bg-white px-3 py-1.5 font-mono text-[13px]"
                  required
                />
                {phrase.length > 0 &&
                  phrase !== `RESTORE ${selectedId.slice(0, 8)}` && (
                    <p className="mt-1 text-[11.5px] text-amber-800">
                      La phrase ne correspond pas encore exactement.{" "}
                      <span className="font-mono">
                        {describePhraseMismatch(
                          phrase,
                          `RESTORE ${selectedId.slice(0, 8)}`
                        )}
                      </span>
                    </p>
                  )}
              </label>

              <label className="block text-[12.5px]">
                <span className="font-semibold text-ink">
                  Mot de passe administrateur
                </span>
                <p className="mt-1 text-[11.5px] text-ink/60">
                  Vérifié côté serveur (scrypt) — jamais stocké en clair.
                </p>
                <input
                  type="password"
                  name="restore-admin-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="mt-2 w-full rounded-btn border border-line bg-white px-3 py-1.5 text-[13px]"
                  required
                />
              </label>

              <label className="flex items-start gap-3 text-[12.5px] text-ink/75">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  disabled={currentUser.role !== "SUPER_ADMIN"}
                  className="mt-1"
                />
                <span>
                  <strong>Forcer</strong> — autoriser la restauration même en
                  cas de schéma incompatible (SUPER_ADMIN uniquement).
                  {currentUser.role !== "SUPER_ADMIN" && (
                    <span className="text-ink/40"> (indisponible pour ce rôle)</span>
                  )}
                </span>
              </label>

              {restoreResult && (
                <div
                  role="alert"
                  className={
                    restoreResult.ok
                      ? "rounded-btn border border-emerald-200 bg-emerald-50 p-3 text-[12.5px] text-emerald-900"
                      : "rounded-btn border border-red-200 bg-red-50 p-3 text-[12.5px] text-red-800"
                  }
                >
                  <p>
                    {restoreResult.ok ? "Succès" : "Échec"} — {restoreResult.publicMessage}
                  </p>
                  <p className="mt-1 font-mono text-[11px] opacity-80">
                    Code {restoreResult.code} · Op {restoreResult.operationId}
                    {restoreResult.restoreOperationId
                      ? ` · Restore ${restoreResult.restoreOperationId.slice(0, 8)}…`
                      : ""}
                    {restoreResult.safetyBackupId
                      ? ` · Safety ${restoreResult.safetyBackupId.slice(0, 8)}…`
                      : ""}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="text-[12.5px] font-semibold text-ink/60 hover:text-ink"
                >
                  ← Retour
                </button>
                <button
                  type="submit"
                  disabled={pending || !phrase || !password}
                  className="inline-flex items-center rounded-btn bg-red-600 px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {pending ? "Restauration en cours…" : "Lancer la restauration"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({
  index,
  current,
  label
}: {
  index: 1 | 2 | 3;
  current: 1 | 2 | 3;
  label: string;
}) {
  const state =
    index < current ? "done" : index === current ? "active" : "todo";
  return (
    <li
      className={`flex items-center gap-3 rounded-btn border px-3 py-2 text-[12.5px] ${
        state === "active"
          ? "border-cobalt bg-cobalt/[0.04] font-semibold text-cobalt"
          : state === "done"
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : "border-line bg-white text-ink/55"
      }`}
    >
      <span
        aria-hidden
        className={`flex h-6 w-6 items-center justify-center rounded-full text-[11.5px] font-bold ${
          state === "active"
            ? "bg-cobalt text-white"
            : state === "done"
              ? "bg-emerald-600 text-white"
              : "bg-ink/10 text-ink/60"
        }`}
      >
        {state === "done" ? "✓" : index}
      </span>
      {label}
    </li>
  );
}

function describePhraseMismatch(typed: string, expected: string): string {
  const a = Array.from(typed);
  const b = Array.from(expected);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const head = `Saisi : ${a.length} car. · attendu : ${b.length} car.`;
  if (i >= a.length) return `${head} · la saisie est trop courte.`;
  const cp = a[i].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
  return `${head} · 1er écart à la position ${i + 1} (caractère U+${cp}).`;
}

function formatSize(size: string | null): string {
  if (!size) return "—";
  const n = Number(size);
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

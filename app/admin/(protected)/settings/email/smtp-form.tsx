"use client";

import { useState, useTransition } from "react";
import {
  saveSmtpConfigAction,
  testSmtpConnectionAction,
  sendTestEmailAction,
  runEmailWorkerAction,
  type SaveState,
  type TestConnectionState,
  type SendTestState,
  type RunWorkerState
} from "./actions";
import type { SmtpConfigView } from "@/lib/email/config";

type Msg = { tone: "success" | "error"; text: string } | null;

// SMTP settings form. Client-side ONLY collects & submits input; the browser
// never receives the plaintext password (SmtpConfigView shape omits it and
// only exposes `passwordSet` + `passwordFingerprint`).
export function SmtpForm({ initial }: { initial: SmtpConfigView }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [testResult, setTestResult] = useState<Msg>(null);
  const [testSendResult, setTestSendResult] = useState<Msg>(null);
  const [workerResult, setWorkerResult] = useState<Msg>(null);
  const [clearPassword, setClearPassword] = useState(false);

  const [encryption, setEncryption] = useState<SmtpConfigView["encryption"]>(
    initial.encryption
  );
  const [authEnabled, setAuthEnabled] = useState(initial.authEnabled);
  const [mode, setMode] = useState<SmtpConfigView["mode"]>(initial.mode);

  return (
    <div className="grid gap-6">
      <form
        action={(fd) =>
          startTransition(async () => {
            const res: SaveState = await saveSmtpConfigAction(
              { status: "idle" },
              fd
            );
            if (res.status === "success") setMsg({ tone: "success", text: res.message });
            else if (res.status === "error") setMsg({ tone: "error", text: res.message });
          })
        }
        className="space-y-6"
      >
        <fieldset className="grid gap-4 rounded-[16px] border border-line bg-white p-6">
          <Legend title="Serveur SMTP" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Host" name="host" defaultValue={initial.host} required />
            <Field
              label="Port"
              name="port"
              type="number"
              min={1}
              max={65535}
              defaultValue={String(initial.port)}
              required
            />
            <label className="text-[12px] font-semibold text-ink/70">
              Chiffrement
              <select
                name="encryption"
                value={encryption}
                onChange={(e) =>
                  setEncryption(e.currentTarget.value as SmtpConfigView["encryption"])
                }
                className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
              >
                <option value="none">Aucun</option>
                <option value="starttls">STARTTLS</option>
                <option value="ssl">SSL / TLS</option>
              </select>
            </label>
            <label className="flex items-center gap-2 pt-6 text-[12.5px] font-semibold text-ink">
              <input
                type="checkbox"
                name="authEnabled"
                checked={authEnabled}
                onChange={(e) => setAuthEnabled(e.currentTarget.checked)}
              />
              Authentification activée
            </label>
          </div>
        </fieldset>

        <fieldset
          className="grid gap-4 rounded-[16px] border border-line bg-white p-6"
          disabled={!authEnabled}
        >
          <Legend title="Identifiants" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Nom d'utilisateur"
              name="username"
              defaultValue={initial.username ?? ""}
              autoComplete="off"
            />
            <div>
              <Field
                label={
                  initial.passwordSet
                    ? "Mot de passe (laisser vide pour conserver)"
                    : "Mot de passe"
                }
                name="password"
                type="password"
                autoComplete="new-password"
                defaultValue=""
              />
              {initial.passwordSet && (
                <p className="mt-2 text-[11.5px] text-ink/55">
                  Mot de passe configuré ({initial.passwordFingerprint}).
                  Cochez « effacer » pour le supprimer.
                </p>
              )}
              <label className="mt-2 flex items-center gap-2 text-[11.5px] text-ink/70">
                <input
                  type="checkbox"
                  name="clearPassword"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.currentTarget.checked)}
                />
                Effacer le mot de passe stocké
              </label>
            </div>
          </div>
        </fieldset>

        <fieldset className="grid gap-4 rounded-[16px] border border-line bg-white p-6">
          <Legend title="Identité d'expéditeur" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Nom d'expéditeur"
              name="fromName"
              defaultValue={initial.fromName}
              required
            />
            <Field
              label="Email d'expéditeur"
              name="fromEmail"
              type="email"
              defaultValue={initial.fromEmail}
              required
            />
            <Field
              label="Reply-To (optionnel)"
              name="replyTo"
              type="email"
              defaultValue={initial.replyTo ?? ""}
            />
            <Field
              label="Destinataire du formulaire de contact"
              name="contactRecipient"
              type="email"
              defaultValue={initial.contactRecipient ?? ""}
            />
          </div>
        </fieldset>

        <fieldset className="grid gap-4 rounded-[16px] border border-line bg-white p-6">
          <Legend title="Fiabilité & environnement" />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Timeout connexion (ms)"
              name="connectionTimeoutMs"
              type="number"
              min={1000}
              max={120000}
              defaultValue={String(initial.connectionTimeoutMs)}
            />
            <Field
              label="Timeout auth (ms)"
              name="authTimeoutMs"
              type="number"
              min={1000}
              max={120000}
              defaultValue={String(initial.authTimeoutMs)}
            />
            <Field
              label="Nombre max de tentatives"
              name="maxAttempts"
              type="number"
              min={1}
              max={20}
              defaultValue={String(initial.maxAttempts)}
            />
            <label className="text-[12px] font-semibold text-ink/70">
              Mode
              <select
                name="mode"
                value={mode}
                onChange={(e) => setMode(e.currentTarget.value as SmtpConfigView["mode"])}
                className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
              >
                <option value="off">OFF — bloquer tous les envois</option>
                <option value="log-only">Log-only (dev)</option>
                <option value="live">Live — envoyer via SMTP</option>
              </select>
            </label>
            <div className="sm:col-span-2">
              <Field
                label="Domaines autorisés (dev uniquement, séparés par des virgules)"
                name="allowlistDomains"
                defaultValue={initial.allowlistDomains.join(", ")}
              />
            </div>
          </div>
          {mode === "log-only" && (
            <p className="text-[12px] text-amber-800">
              Mode log-only : les messages sont rendus et stockés, mais aucun
              envoi SMTP réel n'est effectué.
            </p>
          )}
        </fieldset>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-btn bg-ink px-4 py-2 text-[13px] font-bold text-lime disabled:opacity-60"
          >
            {pending ? "Enregistrement…" : "Enregistrer la configuration"}
          </button>
          {msg && <StatusPill tone={msg.tone} text={msg.text} />}
        </div>
      </form>

      <div className="grid gap-4 rounded-[16px] border border-line bg-white p-6">
        <Legend title="Diagnostic" />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res: TestConnectionState = await testSmtpConnectionAction();
                setTestResult({
                  tone: res.status === "success" ? "success" : "error",
                  text: res.status === "idle" ? "" : res.message
                });
              })
            }
            className="rounded-btn border border-ink px-3 py-2 text-[12.5px] font-bold text-ink"
          >
            Tester la connexion
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res: RunWorkerState = await runEmailWorkerAction();
                setWorkerResult({
                  tone: res.status === "success" ? "success" : "error",
                  text: res.status === "idle" ? "" : res.message
                });
              })
            }
            className="rounded-btn border border-line px-3 py-2 text-[12.5px] font-bold text-ink"
          >
            Traiter la file d'attente maintenant
          </button>
        </div>
        {testResult && <StatusPill tone={testResult.tone} text={testResult.text} />}
        {workerResult && <StatusPill tone={workerResult.tone} text={workerResult.text} />}

        <form
          action={(fd) =>
            startTransition(async () => {
              const res: SendTestState = await sendTestEmailAction(
                { status: "idle" },
                fd
              );
              setTestSendResult({
                tone: res.status === "success" ? "success" : "error",
                text: res.status === "idle" ? "" : res.message
              });
            })
          }
          className="flex flex-wrap items-end gap-3"
        >
          <div className="flex-1 min-w-[240px]">
            <label className="text-[12px] font-semibold text-ink/70">
              Envoyer un email de test à
              <input
                type="email"
                name="recipient"
                required
                className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
                placeholder="ops@example.com"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-btn bg-lime px-3 py-2 text-[12.5px] font-bold text-ink"
          >
            Envoyer
          </button>
        </form>
        {testSendResult && (
          <StatusPill tone={testSendResult.tone} text={testSendResult.text} />
        )}
      </div>
    </div>
  );
}

function Legend({ title }: { title: string }) {
  return (
    <legend className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
      {title}
    </legend>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  defaultValue,
  autoComplete,
  min,
  max
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  autoComplete?: string;
  min?: number;
  max?: number;
}) {
  return (
    <label className="text-[12px] font-semibold text-ink/70">
      {label}
      <input
        type={type}
        name={name}
        required={required}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        min={min}
        max={max}
        className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
      />
    </label>
  );
}

function StatusPill({ tone, text }: { tone: "success" | "error"; text: string }) {
  if (!text) return null;
  return (
    <p
      className={
        tone === "success"
          ? "rounded-btn bg-lime/20 px-3 py-2 text-[12.5px] font-semibold text-ink"
          : "rounded-btn bg-red-100 px-3 py-2 text-[12.5px] font-semibold text-red-800"
      }
    >
      {text}
    </p>
  );
}

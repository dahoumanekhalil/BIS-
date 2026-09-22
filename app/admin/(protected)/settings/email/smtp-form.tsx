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

// ─── Provider presets ────────────────────────────────────────────────────
//
// Client-side convenience only — the backend still validates every field
// authoritatively via smtpFormSchema, so bad preset data cannot bypass
// validation. Presets only fill the transport fields (host / port /
// encryption / auth / provider); user-specific fields (username, from
// address, contact recipient) stay whatever the operator typed.
type PresetKey =
  | "custom"
  | "gmail"
  | "resend-api"
  | "resend-smtp"
  | "microsoft365"
  | "sendgrid"
  | "mailgun"
  | "brevo"
  | "ses"
  | "hostinger";

type Preset = {
  label: string;
  provider: SmtpConfigView["provider"];
  host: string;
  port: number;
  encryption: SmtpConfigView["encryption"];
  authEnabled: boolean;
  hint?: string;
};

const PRESETS: Record<PresetKey, Preset> = {
  custom: {
    label: "Personnalisé",
    provider: "smtp",
    host: "",
    port: 587,
    encryption: "starttls",
    authEnabled: true
  },
  gmail: {
    label: "Gmail",
    provider: "smtp",
    host: "smtp.gmail.com",
    port: 587,
    encryption: "starttls",
    authEnabled: true,
    hint: "Utilisez un mot de passe d'application Google (2FA requis)."
  },
  "resend-api": {
    label: "Resend (HTTPS API — recommandé)",
    provider: "resend",
    host: "",
    port: 587,
    encryption: "starttls",
    authEnabled: false,
    hint: "Ajoutez la clé API dans la section Resend ci-dessous."
  },
  "resend-smtp": {
    label: "Resend (SMTP)",
    provider: "smtp",
    host: "smtp.resend.com",
    port: 465,
    encryption: "ssl",
    authEnabled: true,
    hint: "Nom d'utilisateur : « resend » — mot de passe : votre clé API."
  },
  microsoft365: {
    label: "Microsoft 365",
    provider: "smtp",
    host: "smtp.office365.com",
    port: 587,
    encryption: "starttls",
    authEnabled: true
  },
  sendgrid: {
    label: "SendGrid (SMTP)",
    provider: "smtp",
    host: "smtp.sendgrid.net",
    port: 587,
    encryption: "starttls",
    authEnabled: true,
    hint: "Nom d'utilisateur : « apikey » — mot de passe : votre clé API SendGrid."
  },
  mailgun: {
    label: "Mailgun (SMTP)",
    provider: "smtp",
    host: "smtp.mailgun.org",
    port: 587,
    encryption: "starttls",
    authEnabled: true
  },
  brevo: {
    label: "Brevo / Sendinblue",
    provider: "smtp",
    host: "smtp-relay.brevo.com",
    port: 587,
    encryption: "starttls",
    authEnabled: true
  },
  ses: {
    label: "Amazon SES (SMTP)",
    provider: "smtp",
    host: "email-smtp.eu-west-1.amazonaws.com",
    port: 587,
    encryption: "starttls",
    authEnabled: true,
    hint: "Adaptez la région dans le host (email-smtp.<region>.amazonaws.com)."
  },
  hostinger: {
    label: "Hostinger",
    provider: "smtp",
    host: "smtp.hostinger.com",
    port: 465,
    encryption: "ssl",
    authEnabled: true
  }
};

// Best-effort guess so the dropdown reflects the currently-saved config on
// first render. Falls back to "custom" when no preset matches.
function detectInitialPreset(v: SmtpConfigView): PresetKey {
  if (v.provider === "resend") return "resend-api";
  const host = v.host.toLowerCase();
  for (const [key, p] of Object.entries(PRESETS) as [PresetKey, Preset][]) {
    if (
      key !== "custom" &&
      p.provider === "smtp" &&
      p.host &&
      host === p.host.toLowerCase() &&
      p.port === v.port &&
      p.encryption === v.encryption
    ) {
      return key;
    }
  }
  return "custom";
}

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
  const [provider, setProvider] = useState<SmtpConfigView["provider"]>(
    initial.provider
  );
  const [clearResendApiKey, setClearResendApiKey] = useState(false);
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState<number>(initial.port);
  const [preset, setPreset] = useState<PresetKey>(detectInitialPreset(initial));

  // Apply a preset — driven purely from the client, purely a UX shortcut.
  // The server re-validates every field via smtpFormSchema regardless of
  // which preset was picked, so a tampered preset value cannot bypass
  // backend rules.
  function applyPreset(next: PresetKey) {
    setPreset(next);
    if (next === "custom") return;
    const p = PRESETS[next];
    setProvider(p.provider);
    setHost(p.host);
    setPort(p.port);
    setEncryption(p.encryption);
    setAuthEnabled(p.authEnabled);
  }

  // If the operator manually edits host/port/encryption/auth/provider after
  // choosing a preset, quietly drop back to "custom" so the dropdown doesn't
  // misrepresent the current state.
  function bumpToCustomIfDivergent(next: Partial<Preset>) {
    if (preset === "custom") return;
    const current = PRESETS[preset];
    const merged = { ...current, ...next };
    if (
      merged.host !== current.host ||
      merged.port !== current.port ||
      merged.encryption !== current.encryption ||
      merged.authEnabled !== current.authEnabled ||
      merged.provider !== current.provider
    ) {
      setPreset("custom");
    }
  }

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
          <Legend title="Fournisseur email" />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-[12px] font-semibold text-ink/70">
              Préréglage
              <select
                value={preset}
                onChange={(e) => applyPreset(e.currentTarget.value as PresetKey)}
                className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
              >
                {(Object.entries(PRESETS) as [PresetKey, Preset][]).map(
                  ([key, p]) => (
                    <option key={key} value={key}>
                      {p.label}
                    </option>
                  )
                )}
              </select>
            </label>
            <label className="text-[12px] font-semibold text-ink/70">
              Transport
              <select
                name="provider"
                value={provider}
                onChange={(e) => {
                  const v = e.currentTarget.value as SmtpConfigView["provider"];
                  setProvider(v);
                  bumpToCustomIfDivergent({ provider: v });
                }}
                className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
              >
                <option value="smtp">SMTP (nodemailer)</option>
                <option value="resend">Resend (HTTPS API)</option>
              </select>
            </label>
          </div>
          {PRESETS[preset].hint && (
            <p className="text-[11.5px] text-ink/70">
              <span className="font-semibold text-cobalt">Astuce : </span>
              {PRESETS[preset].hint}
            </p>
          )}
          <p className="text-[11.5px] text-ink/55">
            Le préréglage remplit uniquement l'hôte / port / chiffrement /
            authentification. Les identifiants et l'adresse d'expéditeur
            restent à saisir manuellement.
          </p>
        </fieldset>

        {provider === "resend" && (
          <fieldset className="grid gap-4 rounded-[16px] border border-line bg-white p-6">
            <Legend title="Resend" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Field
                  label={
                    initial.resendApiKeySet
                      ? "Clé API (laisser vide pour conserver)"
                      : "Clé API"
                  }
                  name="resendApiKey"
                  type="password"
                  autoComplete="new-password"
                  defaultValue=""
                />
                {initial.resendApiKeySet && (
                  <p className="mt-2 text-[11.5px] text-ink/55">
                    Clé API configurée ({initial.resendApiKeyFingerprint}).
                    Cochez « effacer » pour la supprimer.
                  </p>
                )}
                <label className="mt-2 flex items-center gap-2 text-[11.5px] text-ink/70">
                  <input
                    type="checkbox"
                    name="clearResendApiKey"
                    checked={clearResendApiKey}
                    onChange={(e) => setClearResendApiKey(e.currentTarget.checked)}
                  />
                  Effacer la clé API stockée
                </label>
              </div>
              <p className="text-[11.5px] text-ink/55 sm:pt-6">
                La clé API est chiffrée au repos (AES-256-GCM). Elle n'est
                jamais renvoyée au navigateur après enregistrement. Utilisez
                de préférence une clé « sending-only » restreinte à votre
                domaine vérifié.
              </p>
            </div>
          </fieldset>
        )}

        <fieldset
          className="grid gap-4 rounded-[16px] border border-line bg-white p-6"
          disabled={provider === "resend"}
        >
          <Legend title="Serveur SMTP" />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-[12px] font-semibold text-ink/70">
              Host
              <input
                name="host"
                value={host}
                required={provider === "smtp"}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setHost(v);
                  bumpToCustomIfDivergent({ host: v });
                }}
                className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
              />
            </label>
            <label className="text-[12px] font-semibold text-ink/70">
              Port
              <input
                name="port"
                type="number"
                min={1}
                max={65535}
                value={port}
                required={provider === "smtp"}
                onChange={(e) => {
                  const n = Number(e.currentTarget.value);
                  setPort(Number.isFinite(n) ? n : 0);
                  if (Number.isFinite(n)) bumpToCustomIfDivergent({ port: n });
                }}
                className="mt-1 w-full rounded-btn border border-line bg-white px-3 py-2 text-[13px] text-ink"
              />
            </label>
            <label className="text-[12px] font-semibold text-ink/70">
              Chiffrement
              <select
                name="encryption"
                value={encryption}
                onChange={(e) => {
                  const v = e.currentTarget.value as SmtpConfigView["encryption"];
                  setEncryption(v);
                  bumpToCustomIfDivergent({ encryption: v });
                }}
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
                onChange={(e) => {
                  const v = e.currentTarget.checked;
                  setAuthEnabled(v);
                  bumpToCustomIfDivergent({ authEnabled: v });
                }}
              />
              Authentification activée
            </label>
          </div>
        </fieldset>

        <fieldset
          className="grid gap-4 rounded-[16px] border border-line bg-white p-6"
          disabled={provider === "resend" || !authEnabled}
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

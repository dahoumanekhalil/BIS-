import "server-only";

import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  decryptSecret,
  encryptSecret,
  looksEncrypted,
  secretFingerprint
} from "./crypto";

// ─── Configuration layer ─────────────────────────────────────────────────
//
// Two audiences:
//
//   1. The email service / worker — call `getSmtpConfig()` to obtain a
//      fully-resolved, secret-bearing config OR null if the deployment is
//      not configured. Never surface any of these fields to the browser.
//
//   2. The admin settings UI — call `getSmtpConfigView()` for a shape that
//      is safe to embed in a server component and pass down to a client
//      component: the password is replaced with a boolean + fingerprint,
//      and any secret-flavoured field is omitted entirely.
//
// Precedence (spec §22): ENV overrides DB. If any SMTP_* env var is set,
// the ENV block is treated as the source of truth for that field; the DB
// value is only consulted for fields ENV does not carry. This is what lets
// deployments store the password in a real secrets manager (env) while
// still allowing admins to change the friendly fields (From name / reply-
// to / contact recipient) at runtime.

/* ------------------------------ SHAPES ------------------------------ */

export type SmtpEncryption = "none" | "starttls" | "ssl";

export type EmailMode = "off" | "log-only" | "live";

// Provider selection. Adding a new provider requires:
//   1. a case in the provider dispatcher (lib/email/providers/index.ts)
//   2. any provider-specific fields on SmtpConfig + SmtpConfigView
//   3. schema entries in smtpFormSchema for admin UI validation
export type EmailProvider = "smtp" | "resend";

export type SmtpConfig = {
  // Selected transport provider. "smtp" preserves the historic behaviour.
  provider: EmailProvider;

  // ─── SMTP fields (used when provider === "smtp") ─────────────────
  host: string;
  port: number;
  encryption: SmtpEncryption;
  authEnabled: boolean;
  username: string | null;
  password: string | null; // decrypted plaintext — server-only

  // ─── Resend fields (used when provider === "resend") ─────────────
  resendApiKey: string | null; // decrypted plaintext — server-only

  // ─── Provider-agnostic fields ────────────────────────────────────
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  connectionTimeoutMs: number;
  authTimeoutMs: number;
  maxAttempts: number;
  contactRecipient: string | null;
  mode: EmailMode; // "off" | "log-only" | "live"
  allowlistDomains: string[]; // active in non-production only
};

// Client-safe view — never carries plaintext credentials.
export type SmtpConfigView = {
  configured: boolean;
  source: "env+db" | "env" | "db" | "none";
  provider: EmailProvider;
  host: string;
  port: number;
  encryption: SmtpEncryption;
  authEnabled: boolean;
  username: string | null;
  passwordSet: boolean;
  passwordFingerprint: string | null;
  // Resend — same treatment as the SMTP password: never expose the raw key.
  resendApiKeySet: boolean;
  resendApiKeyFingerprint: string | null;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  connectionTimeoutMs: number;
  authTimeoutMs: number;
  maxAttempts: number;
  contactRecipient: string | null;
  mode: EmailMode;
  allowlistDomains: string[];
  // Whether the deployment is currently in dev-safe "log-only" — surfaced
  // in the admin UI to prevent operators from thinking real sends work.
  logOnly: boolean;
};

/* ------------------------------ CONSTANTS ------------------------------ */

const SITE_CONTENT_KEY = "email.smtp";

const DEFAULT_CONFIG = {
  provider: "smtp" as EmailProvider,
  host: "",
  port: 587,
  encryption: "starttls" as SmtpEncryption,
  authEnabled: true,
  username: null as string | null,
  passwordEnvelope: null as string | null,
  resendApiKeyEnvelope: null as string | null,
  fromEmail: "",
  fromName: "BIS 2026",
  replyTo: null as string | null,
  connectionTimeoutMs: 15000,
  authTimeoutMs: 15000,
  maxAttempts: 5,
  contactRecipient: null as string | null,
  mode: "log-only" as EmailMode,
  allowlistDomains: [] as string[]
};

/* ------------------------------ VALIDATION ------------------------------ */

export const smtpFormSchema = z.object({
  // Provider selection — the rest of the SMTP fields become optional when the
  // active provider is Resend. Validation of "at least one usable transport"
  // happens in the save handler so it can produce a targeted error message.
  provider: z.enum(["smtp", "resend"]).default("smtp"),
  host: z
    .string()
    .trim()
    .max(255)
    .optional()
    .default("")
    .transform((v) => v ?? ""),
  port: z.coerce.number().int().min(1, "Port invalide").max(65535).default(587),
  encryption: z.enum(["none", "starttls", "ssl"]).default("starttls"),
  authEnabled: z.boolean(),
  username: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  // `password` is optional at the form layer — the admin may re-save the
  // config without rotating the password. A special sentinel below marks a
  // "clear" action explicitly.
  password: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  clearPassword: z.boolean().optional().default(false),
  // Resend — same "leave empty to preserve" + explicit clear semantics as the
  // SMTP password so the value can be rotated without ever hitting the wire.
  resendApiKey: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v && v.length > 0 ? v.trim() : null)),
  clearResendApiKey: z.boolean().optional().default(false),
  fromEmail: z.string().trim().email("Email d'expéditeur invalide"),
  fromName: z.string().trim().min(1, "Nom d'expéditeur requis").max(120),
  replyTo: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null))
    .refine(
      (v) => v == null || z.string().email().safeParse(v).success,
      "Reply-To invalide"
    ),
  connectionTimeoutMs: z.coerce.number().int().min(1000).max(120_000),
  authTimeoutMs: z.coerce.number().int().min(1000).max(120_000),
  maxAttempts: z.coerce.number().int().min(1).max(20),
  contactRecipient: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null))
    .refine(
      (v) => v == null || z.string().email().safeParse(v).success,
      "Adresse contact invalide"
    ),
  mode: z.enum(["off", "log-only", "live"]),
  allowlistDomains: z
    .string()
    .max(1024)
    .optional()
    .default("")
    .transform((v) =>
      (v ?? "")
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s))
    )
});

export type SmtpFormInput = z.input<typeof smtpFormSchema>;
export type SmtpFormParsed = z.output<typeof smtpFormSchema>;

/* ------------------------------ ENV OVERLAY ------------------------------ */

// Parse process.env once per call so tests can mutate env between calls.
function readEnvOverlay(): Partial<SmtpConfig> {
  const env = process.env;
  const out: Partial<SmtpConfig> = {};
  if (env.EMAIL_PROVIDER) {
    const v = env.EMAIL_PROVIDER.trim().toLowerCase();
    if (v === "smtp" || v === "resend") out.provider = v;
  }
  // NOTE: the raw RESEND_API_KEY env var is a *server-only* secret. It is
  // deliberately never surfaced via SmtpConfigView (only `resendApiKeySet`
  // is), so this branch cannot leak the key to the browser.
  if (env.RESEND_API_KEY !== undefined) {
    out.resendApiKey = env.RESEND_API_KEY || null;
  }
  if (env.SMTP_HOST) out.host = env.SMTP_HOST.trim();
  if (env.SMTP_PORT) {
    const n = Number(env.SMTP_PORT);
    if (Number.isInteger(n) && n > 0 && n < 65536) out.port = n;
  }
  if (env.SMTP_ENCRYPTION) {
    const v = env.SMTP_ENCRYPTION.trim().toLowerCase();
    if (v === "none" || v === "starttls" || v === "ssl") out.encryption = v;
  }
  if (env.SMTP_AUTH_ENABLED) {
    out.authEnabled = /^(1|true|yes|on)$/i.test(env.SMTP_AUTH_ENABLED.trim());
  }
  if (env.SMTP_USERNAME !== undefined) out.username = env.SMTP_USERNAME || null;
  if (env.SMTP_PASSWORD !== undefined) out.password = env.SMTP_PASSWORD || null;
  if (env.SMTP_FROM_EMAIL) out.fromEmail = env.SMTP_FROM_EMAIL.trim();
  if (env.SMTP_FROM_NAME) out.fromName = env.SMTP_FROM_NAME.trim();
  if (env.SMTP_REPLY_TO) out.replyTo = env.SMTP_REPLY_TO.trim();
  if (env.SMTP_CONNECTION_TIMEOUT_MS) {
    const n = Number(env.SMTP_CONNECTION_TIMEOUT_MS);
    if (Number.isFinite(n) && n >= 1000 && n <= 120_000) out.connectionTimeoutMs = n;
  }
  if (env.SMTP_AUTH_TIMEOUT_MS) {
    const n = Number(env.SMTP_AUTH_TIMEOUT_MS);
    if (Number.isFinite(n) && n >= 1000 && n <= 120_000) out.authTimeoutMs = n;
  }
  if (env.EMAIL_MAX_ATTEMPTS) {
    const n = Number(env.EMAIL_MAX_ATTEMPTS);
    if (Number.isInteger(n) && n >= 1 && n <= 20) out.maxAttempts = n;
  }
  if (env.EMAIL_MODE) {
    const v = env.EMAIL_MODE.trim().toLowerCase();
    if (v === "off" || v === "log-only" || v === "live") out.mode = v;
  }
  if (env.EMAIL_ALLOWLIST !== undefined) {
    out.allowlistDomains = (env.EMAIL_ALLOWLIST ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
  if (env.EMAIL_CONTACT_RECIPIENT) out.contactRecipient = env.EMAIL_CONTACT_RECIPIENT.trim();
  // Provider-specific From overrides applied LAST so they win over the
  // generic SMTP_FROM_* pair, but only when the resolved provider matches.
  // A stray RESEND_FROM_EMAIL with EMAIL_PROVIDER=smtp is a no-op.
  if (out.provider === "resend") {
    if (env.RESEND_FROM_EMAIL) out.fromEmail = env.RESEND_FROM_EMAIL.trim();
    if (env.RESEND_FROM_NAME) out.fromName = env.RESEND_FROM_NAME.trim();
  }
  return out;
}

/* ------------------------------ STORE / LOAD ------------------------------ */

type DbBlob = {
  // `provider` was added in the Resend integration. Existing rows without
  // this field are treated as "smtp" by the loader — a safe default that
  // preserves the historic behaviour and does not require a data migration.
  provider?: EmailProvider;
  host: string;
  port: number;
  encryption: SmtpEncryption;
  authEnabled: boolean;
  username: string | null;
  passwordEnvelope: string | null;
  // Optional so existing SMTP-only rows deserialize without a migration.
  resendApiKeyEnvelope?: string | null;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  connectionTimeoutMs: number;
  authTimeoutMs: number;
  maxAttempts: number;
  contactRecipient: string | null;
  mode: EmailMode;
  allowlistDomains: string[];
};

function isDbBlob(value: unknown): value is DbBlob {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.host === "string" &&
    typeof v.port === "number" &&
    typeof v.encryption === "string" &&
    typeof v.authEnabled === "boolean" &&
    typeof v.fromEmail === "string" &&
    typeof v.fromName === "string"
  );
}

async function readDbBlob(): Promise<DbBlob | null> {
  const row = await prisma.siteContent.findUnique({
    where: { key: SITE_CONTENT_KEY }
  });
  if (!row) return null;
  if (!isDbBlob(row.value)) return null;
  return row.value;
}

/**
 * Fully-resolved server-side config. Returns `null` when neither the DB nor
 * the ENV supplies a usable host / from address. Callers must treat `null`
 * as "email is not configured" and NOT attempt to send.
 */
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const db = await readDbBlob();
  const env = readEnvOverlay();

  const provider: EmailProvider =
    env.provider ?? db?.provider ?? DEFAULT_CONFIG.provider;

  const merged: SmtpConfig = {
    provider,
    host: env.host ?? db?.host ?? DEFAULT_CONFIG.host,
    port: env.port ?? db?.port ?? DEFAULT_CONFIG.port,
    encryption: env.encryption ?? db?.encryption ?? DEFAULT_CONFIG.encryption,
    authEnabled:
      env.authEnabled ?? db?.authEnabled ?? DEFAULT_CONFIG.authEnabled,
    username: env.username ?? db?.username ?? null,
    password: env.password ?? (db?.passwordEnvelope ? safeDecrypt(db.passwordEnvelope) : null),
    resendApiKey:
      env.resendApiKey ??
      (db?.resendApiKeyEnvelope ? safeDecrypt(db.resendApiKeyEnvelope) : null),
    fromEmail: env.fromEmail ?? db?.fromEmail ?? DEFAULT_CONFIG.fromEmail,
    fromName: env.fromName ?? db?.fromName ?? DEFAULT_CONFIG.fromName,
    replyTo: env.replyTo ?? db?.replyTo ?? null,
    connectionTimeoutMs:
      env.connectionTimeoutMs ??
      db?.connectionTimeoutMs ??
      DEFAULT_CONFIG.connectionTimeoutMs,
    authTimeoutMs:
      env.authTimeoutMs ?? db?.authTimeoutMs ?? DEFAULT_CONFIG.authTimeoutMs,
    maxAttempts:
      env.maxAttempts ?? db?.maxAttempts ?? DEFAULT_CONFIG.maxAttempts,
    contactRecipient:
      env.contactRecipient ?? db?.contactRecipient ?? null,
    mode: env.mode ?? db?.mode ?? DEFAULT_CONFIG.mode,
    allowlistDomains:
      env.allowlistDomains ?? db?.allowlistDomains ?? []
  };

  // "Configured" now depends on the active provider:
  //   • SMTP  → need a host + from-email
  //   • Resend → need an API key + from-email
  if (!merged.fromEmail) return null;
  if (provider === "smtp" && !merged.host) return null;
  if (provider === "resend" && !merged.resendApiKey) return null;
  return merged;
}

/**
 * Safe view for the admin UI. NEVER returns the plaintext password. The
 * `passwordFingerprint` lets the UI show "password rotated" between two
 * config saves without leaking the value itself.
 */
export async function getSmtpConfigView(): Promise<SmtpConfigView> {
  const db = await readDbBlob();
  const env = readEnvOverlay();

  const passwordFromDb = db?.passwordEnvelope ?? null;
  const passwordFromEnv = env.password ?? null;
  const passwordSet = Boolean(passwordFromDb) || Boolean(passwordFromEnv);
  const passwordFingerprint = passwordFromEnv
    ? "env"
    : passwordFromDb
    ? secretFingerprint(passwordFromDb)
    : null;

  const resendKeyFromDb = db?.resendApiKeyEnvelope ?? null;
  const resendKeyFromEnv = env.resendApiKey ?? null;
  const resendApiKeySet = Boolean(resendKeyFromDb) || Boolean(resendKeyFromEnv);
  const resendApiKeyFingerprint = resendKeyFromEnv
    ? "env"
    : resendKeyFromDb
    ? secretFingerprint(resendKeyFromDb)
    : null;

  const source: SmtpConfigView["source"] =
    db && Object.keys(env).length > 0
      ? "env+db"
      : db
      ? "db"
      : Object.keys(env).length > 0
      ? "env"
      : "none";

  const provider: EmailProvider =
    env.provider ?? db?.provider ?? DEFAULT_CONFIG.provider;

  const merged = {
    provider,
    host: env.host ?? db?.host ?? DEFAULT_CONFIG.host,
    port: env.port ?? db?.port ?? DEFAULT_CONFIG.port,
    encryption: env.encryption ?? db?.encryption ?? DEFAULT_CONFIG.encryption,
    authEnabled: env.authEnabled ?? db?.authEnabled ?? DEFAULT_CONFIG.authEnabled,
    username: env.username ?? db?.username ?? null,
    fromEmail: env.fromEmail ?? db?.fromEmail ?? DEFAULT_CONFIG.fromEmail,
    fromName: env.fromName ?? db?.fromName ?? DEFAULT_CONFIG.fromName,
    replyTo: env.replyTo ?? db?.replyTo ?? null,
    connectionTimeoutMs:
      env.connectionTimeoutMs ??
      db?.connectionTimeoutMs ??
      DEFAULT_CONFIG.connectionTimeoutMs,
    authTimeoutMs:
      env.authTimeoutMs ?? db?.authTimeoutMs ?? DEFAULT_CONFIG.authTimeoutMs,
    maxAttempts:
      env.maxAttempts ?? db?.maxAttempts ?? DEFAULT_CONFIG.maxAttempts,
    contactRecipient: env.contactRecipient ?? db?.contactRecipient ?? null,
    mode: env.mode ?? db?.mode ?? DEFAULT_CONFIG.mode,
    allowlistDomains: env.allowlistDomains ?? db?.allowlistDomains ?? []
  };

  const configured =
    Boolean(merged.fromEmail) &&
    (provider === "smtp" ? Boolean(merged.host) : resendApiKeySet);

  return {
    configured,
    source,
    passwordSet,
    passwordFingerprint,
    resendApiKeySet,
    resendApiKeyFingerprint,
    logOnly: merged.mode === "log-only",
    ...merged
  };
}

function safeDecrypt(envelope: string): string | null {
  try {
    return decryptSecret(envelope);
  } catch (err) {
    // Fail closed. A ciphertext that does not decrypt (rotated key,
    // corruption, wrong deployment) MUST NOT be silently treated as
    // an empty password — that would attempt SMTP without auth.
    // eslint-disable-next-line no-console
    console.error(
      "[email.config] Failed to decrypt SMTP password from DB. " +
        "Verify EMAIL_SECRET_ENCRYPTION_KEY matches the key used to encrypt.",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Persist an admin-supplied config. Encrypts the password before storage.
 * When the operator submits an empty password AND does not tick `clearPassword`,
 * the existing envelope is preserved (so re-saving the friendly fields does
 * not accidentally wipe the credential).
 *
 * Callers MUST perform their own RBAC check before invoking this.
 */
export async function saveSmtpConfig(input: SmtpFormParsed): Promise<void> {
  const existing = await readDbBlob();

  let passwordEnvelope: string | null;
  if (input.clearPassword) {
    passwordEnvelope = null;
  } else if (input.password && input.password.length > 0) {
    // Refuse to accidentally re-encrypt a value that already looks like an
    // envelope — this would happen if a client-side JS bug echoed the
    // fingerprint back into the field.
    if (looksEncrypted(input.password)) {
      throw new Error("Refuse to encrypt what already looks like a v1 envelope.");
    }
    passwordEnvelope = encryptSecret(input.password);
  } else {
    passwordEnvelope = existing?.passwordEnvelope ?? null;
  }

  // Same three-state handling as the SMTP password so operators can rotate
  // the Resend API key or wipe it without ever putting the raw value back
  // into the browser.
  let resendApiKeyEnvelope: string | null;
  if (input.clearResendApiKey) {
    resendApiKeyEnvelope = null;
  } else if (input.resendApiKey && input.resendApiKey.length > 0) {
    if (looksEncrypted(input.resendApiKey)) {
      throw new Error("Refuse to encrypt what already looks like a v1 envelope.");
    }
    resendApiKeyEnvelope = encryptSecret(input.resendApiKey);
  } else {
    resendApiKeyEnvelope = existing?.resendApiKeyEnvelope ?? null;
  }

  const blob: DbBlob = {
    provider: input.provider,
    host: input.host,
    port: input.port,
    encryption: input.encryption,
    authEnabled: input.authEnabled,
    username: input.username,
    passwordEnvelope,
    resendApiKeyEnvelope,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    replyTo: input.replyTo,
    connectionTimeoutMs: input.connectionTimeoutMs,
    authTimeoutMs: input.authTimeoutMs,
    maxAttempts: input.maxAttempts,
    contactRecipient: input.contactRecipient,
    mode: input.mode,
    allowlistDomains: input.allowlistDomains
  };

  await prisma.siteContent.upsert({
    where: { key: SITE_CONTENT_KEY },
    create: { key: SITE_CONTENT_KEY, value: blob as unknown as object },
    update: { value: blob as unknown as object }
  });
}

/**
 * Non-production allowlist gate. Returns true if the recipient may receive
 * a real SMTP send in the current environment. In production, always true.
 * In dev / test, only true when the recipient's domain is explicitly listed
 * in `allowlistDomains`. Prevents accidental production email delivery from
 * a developer machine that happens to have live SMTP credentials.
 */
export function isRecipientAllowedInEnvironment(
  recipient: string,
  cfg: Pick<SmtpConfig, "mode" | "allowlistDomains">
): boolean {
  if (process.env.NODE_ENV === "production") return true;
  if (cfg.allowlistDomains.length === 0) return false;
  const at = recipient.lastIndexOf("@");
  if (at < 0) return false;
  const domain = recipient.slice(at + 1).toLowerCase();
  return cfg.allowlistDomains.includes(domain);
}

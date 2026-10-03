import "server-only";

import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

import {
  assertGoogleDriveEnabled,
  loadGoogleDriveConfig
} from "./config";
import { classifyGoogleError } from "./classifier";
import { GoogleDriveOperationError } from "./errors";

// ─── Google Drive OAuth2 client + access-token cache (Layers B + D) ────────
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §B, §D, §R.
//
// Responsibilities:
//   • Construct exactly ONE `OAuth2Client` per Node process, bound to
//     the operator's refresh token (loaded from env via `loadGoogleDriveConfig()`).
//   • Serve access tokens from an in-process cache with a 60s pre-expiry
//     refresh window (§D.1).
//   • Serialize concurrent refresh requests via a single in-flight
//     Promise (§D.1) so N parallel Drive calls never trigger N refresh
//     hits against `oauth2.googleapis.com/token`.
//   • Never enable googleapis debug logging. Route every thrown error
//     through `classifyGoogleError` so no request URL, header, or body
//     ever bubbles up.
//
// Absolute rules (Layer R restated):
//   * The refresh token is never returned from any exported function.
//     Only the `OAuth2Client` instance itself holds it, and only the
//     internal `google.drive({ auth: ... })` factory consumes it.
//   * `getGoogleDriveAccessToken()` returns the bare access-token
//     string — its ONLY legitimate use is as a bearer credential in an
//     Authorization header. Callers MUST NOT log it, JSON-serialize it,
//     or attach it to an audit row / server-action response.
//   * On a refresh failure, the cached token AND the in-flight promise
//     are cleared so the next call re-attempts (and if the failure is
//     REVOKED_AUTHORIZATION, that next call immediately re-throws the
//     same classified error — the caller decides how to escalate).
//
// Test seam:
//   • `_setOAuth2ClientFactoryForTesting()` swaps the OAuth2 client
//     constructor for a fake. Tests exercise cache + serialization
//     behaviour without any real network I/O.

// ─── Configuration constants (Layer B.1) ───────────────────────────────────

/**
 * Least-privilege Drive scope. NEVER broaden to `.../auth/drive` or
 * `.../auth/drive.readonly`. The `drive.file` scope grants read/write
 * access only to files the application itself created — precisely the
 * subset the backup replication worker needs.
 */
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Only OAuth mode the loader recognizes. Mirrored from §C.2. */
export const GOOGLE_DRIVE_AUTH_MODE = "oauth_refresh_token";

/**
 * Loopback redirect URI (Google's supported replacement for OOB).
 * Referenced by `scripts/google-drive-authorize.ts`. Kept here so the
 * two sides of the OAuth handshake can never drift apart.
 */
export const GOOGLE_DRIVE_LOOPBACK_REDIRECT =
  "http://127.0.0.1:53682/oauth2callback";

/**
 * Proactive refresh window. If the cached access token expires in
 * ≤ 60 s, refresh it now rather than watching it expire mid-call
 * (§D.1). Applied consistently by all readers.
 */
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

/**
 * Fallback lifetime when the OAuth2Client does not report an
 * `expiry_date`. Google's token lifetime is normally 3600s; we hedge
 * to 3300s so we always refresh at least 5 minutes before Google's own
 * cutoff.
 */
const FALLBACK_ACCESS_TOKEN_LIFETIME_MS = 3_300_000;

// ─── Types + module-scoped state ───────────────────────────────────────────

type AccessTokenEntry = {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/**
 * Minimal shape the drive-client needs from an OAuth2 client. Any real
 * `OAuth2Client` from `google-auth-library` satisfies this. Fakes used
 * in tests only need to implement these two hooks.
 */
export type OAuth2ClientLike = {
  getAccessToken(): Promise<{ token?: string | null }>;
  credentials: { expiry_date?: number | null };
  setCredentials?: (creds: { refresh_token?: string }) => void;
};

export type OAuth2ClientFactory = (opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  httpTimeoutMs: number;
}) => OAuth2ClientLike;

let cachedClient: OAuth2ClientLike | null = null;
let cachedToken: AccessTokenEntry | null = null;
// Shared refresh promise: N parallel callers await the same fetch.
// Cleared in a `finally` so a failed refresh never poisons subsequent
// callers with a rejected promise.
let inFlightRefresh: Promise<AccessTokenEntry> | null = null;
let clientFactory: OAuth2ClientFactory = defaultOAuth2ClientFactory;

// ─── Default factory (production path) ─────────────────────────────────────

function defaultOAuth2ClientFactory(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  httpTimeoutMs: number;
}): OAuth2ClientLike {
  // Deliberately do NOT set `redirect_uri` — the runtime never
  // performs an authorization-code exchange. The loopback URI is used
  // only by `scripts/google-drive-authorize.ts` during operator setup.
  const client = new google.auth.OAuth2({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret
  });
  client.setCredentials({ refresh_token: opts.refreshToken });
  // NOTE (G2 finding M1): the previous revision called
  // `google.options({ timeout: opts.httpTimeoutMs })` here, which
  // mutated the process-wide `googleapis` module. That coupled our
  // timeout policy to every other consumer of the same `google`
  // singleton (present or future). We deliberately do NOT mutate the
  // global anymore — per-call timeouts are Layer G's responsibility.
  // The value survives as `getResolvedGoogleDriveHttpTimeoutMs()` for
  // Layer G to apply on its own gaxios request options.
  resolvedHttpTimeoutMs = opts.httpTimeoutMs;
  return client;
}

/**
 * Layer G accessor: the operator-configured HTTP timeout that Layer G
 * must apply to every gaxios request it makes. `null` before the first
 * `getGoogleDriveOAuth2Client()` call. Never a secret.
 */
let resolvedHttpTimeoutMs: number | null = null;

export function getResolvedGoogleDriveHttpTimeoutMs(): number | null {
  return resolvedHttpTimeoutMs;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns the process-wide `OAuth2Client` (or the test-injected fake).
 * Throws `GoogleDriveConfigError("DISABLED" | "MISSING" | "MALFORMED")`
 * before any Drive I/O ever occurs.
 *
 * Do NOT export the return value into any log / audit / response
 * surface. It holds the refresh token in memory.
 */
export function getGoogleDriveOAuth2Client(): OAuth2ClientLike {
  assertGoogleDriveEnabled();
  if (cachedClient !== null) return cachedClient;
  const cfg = loadGoogleDriveConfig();
  cachedClient = clientFactory({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    refreshToken: cfg.refreshToken,
    httpTimeoutMs: cfg.httpTimeoutMs
  });
  return cachedClient;
}

/**
 * Acquire a valid access token. Uses the in-process cache. Refresh is
 * proactive (60 s pre-expiry) and serialized (concurrent callers await
 * a single in-flight refresh).
 *
 * Every failure is routed through `classifyGoogleError` and re-thrown
 * as `GoogleDriveOperationError` with a sanitized message. Callers
 * MUST NOT log or expose the returned token.
 *
 * `now` and `clientProvider` are optional injection seams for tests;
 * production callers pass neither.
 */
export async function getGoogleDriveAccessToken(
  now: number = Date.now(),
  clientProvider: () => OAuth2ClientLike = getGoogleDriveOAuth2Client
): Promise<string> {
  const cache = cachedToken;
  if (cache !== null && cache.expiresAt - now > TOKEN_REFRESH_LEEWAY_MS) {
    return cache.accessToken;
  }
  if (inFlightRefresh !== null) {
    const t = await inFlightRefresh;
    return t.accessToken;
  }
  inFlightRefresh = refreshNow(clientProvider).finally(() => {
    // Regardless of success/failure, release the in-flight slot so the
    // next request can retry. A failed refresh must not leave a
    // rejected promise cached for the lifetime of the process.
    inFlightRefresh = null;
  });
  try {
    const entry = await inFlightRefresh;
    return entry.accessToken;
  } catch (err) {
    // Ensure the token cache is cleared on any refresh failure. This
    // is what makes a subsequent `getGoogleDriveAccessToken` retry
    // rather than serve a stale token.
    cachedToken = null;
    throw err;
  }
}

async function refreshNow(
  clientProvider: () => OAuth2ClientLike
): Promise<AccessTokenEntry> {
  const auth = clientProvider();
  let raw: { token?: string | null };
  try {
    raw = await auth.getAccessToken();
  } catch (err) {
    const c = classifyGoogleError(err);
    throw new GoogleDriveOperationError(
      c.code,
      c.sanitizedMessage,
      c.httpStatus,
      c.retryable
    );
  }
  if (typeof raw?.token !== "string" || raw.token.length === 0) {
    // Some google-auth-library versions return `{ token: null }` when
    // the refresh silently fails. Treat that as a classified failure
    // so callers get a consistent error shape.
    throw new GoogleDriveOperationError(
      "AUTHENTICATION_ERROR",
      "AUTHENTICATION_ERROR: Google returned no access token"
    );
  }
  const expiryRaw = auth.credentials?.expiry_date;
  const expiresAt =
    typeof expiryRaw === "number" && Number.isFinite(expiryRaw) && expiryRaw > 0
      ? expiryRaw
      : Date.now() + FALLBACK_ACCESS_TOKEN_LIFETIME_MS;
  const entry: AccessTokenEntry = { accessToken: raw.token, expiresAt };
  cachedToken = entry;
  return entry;
}

/**
 * Convenience: a `drive_v3.Drive` bound to the process-wide OAuth2
 * client. Layer E/F/G will call this. Callers must have already
 * ensured `assertGoogleDriveEnabled()` succeeds — this function
 * re-asserts as a belt-and-braces.
 *
 * When a test factory has been injected (via
 * `_setOAuth2ClientFactoryForTesting`), this throws instead of
 * returning `null` (G2 finding M5). Returning `null` there would
 * silently NPE any caller that forgot the null-check; a hard throw
 * makes accidental test-seam activation loudly diagnostic.
 */
export function getGoogleDriveClient(): drive_v3.Drive {
  const auth = getGoogleDriveOAuth2Client();
  if (clientFactory !== defaultOAuth2ClientFactory) {
    throw new GoogleDriveOperationError(
      "CONFIGURATION_ERROR",
      "CONFIGURATION_ERROR: getGoogleDriveClient called while test-only OAuth2 factory is active"
    );
  }
  // `google.drive({ auth })` requires a real OAuth2Client — the
  // structural check on `getAccessToken` + interceptor plumbing that
  // fakes do not implement.
  return google.drive({ version: "v3", auth: auth as OAuth2Client });
}

// ─── Test seams (never call from production code) ──────────────────────────

/**
 * Test-only: reset every module-scoped cache and restore the default
 * production factory. Call this in `beforeEach` when your test toggles
 * env or swaps the factory.
 */
export function _resetGoogleDriveClientState(): void {
  cachedClient = null;
  cachedToken = null;
  inFlightRefresh = null;
  clientFactory = defaultOAuth2ClientFactory;
}

/**
 * Test-only: swap the OAuth2 client factory. Pass `null` to restore
 * the production factory. Every swap clears the cached client so the
 * new factory is invoked on the next `getGoogleDriveOAuth2Client()`.
 *
 * The leading underscore signals "not for production import". Layer C+Q
 * uses the same convention on `_resetGoogleDriveConfigCache`.
 */
export function _setOAuth2ClientFactoryForTesting(
  factory: OAuth2ClientFactory | null
): void {
  clientFactory = factory ?? defaultOAuth2ClientFactory;
  cachedClient = null;
  cachedToken = null;
  inFlightRefresh = null;
}

/**
 * Test-only introspection: is a token currently cached, and what is its
 * remaining lifetime? Returns `null` when the cache is empty. Never
 * exposes the token itself.
 */
export function _peekCachedTokenExpiryForTesting(): number | null {
  return cachedToken?.expiresAt ?? null;
}

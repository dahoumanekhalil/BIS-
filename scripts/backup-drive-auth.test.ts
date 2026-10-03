// Layers B + D tests — Google Drive OAuth2 client + token cache +
// refresh classifier + error sanitizer.
// Run with:
//   npm run test:backup-drive-auth
//
// Every test runs against a mock OAuth2 client injected via
// `_setOAuth2ClientFactoryForTesting`. NO real network I/O occurs.
// This suite verifies:
//   * Access token caching + proactive refresh window (§D.1)
//   * Serialized refresh across concurrent callers (§D.1)
//   * Every entry in the §D.3 refresh-failure truth table:
//       invalid_grant  → REVOKED_AUTHORIZATION  (non-retryable)
//       invalid_client → CONFIGURATION_ERROR    (non-retryable)
//       invalid_scope  → CONFIGURATION_ERROR    (non-retryable)
//       401            → AUTHENTICATION_ERROR   (retryable)
//       403 rate-limit → RATE_LIMITED           (retryable)
//       403 quota      → QUOTA_EXCEEDED         (non-retryable)
//       403 other      → AUTHORIZATION_ERROR    (non-retryable)
//       404            → DESTINATION_NOT_FOUND  (non-retryable)
//       410            → UPLOAD_SESSION_EXPIRED (retryable)
//       429            → RATE_LIMITED           (retryable)
//       5xx            → SERVER_ERROR           (retryable)
//       ECONNRESET     → NETWORK_ERROR          (retryable)
//       ETIMEDOUT      → TIMEOUT                (retryable)
//   * Malformed / missing config surfaces the correct code.
//   * Secret non-disclosure: no error message, class name, status
//     surface, or test output contains the fake refresh token / client
//     secret used in the tests.
//   * The default Drive scope is `drive.file` — no accidental
//     broadening.

import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  _resetGoogleDriveConfigCache
} from "../lib/backup/replication/config";
import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_DRIVE_AUTH_MODE,
  GOOGLE_DRIVE_LOOPBACK_REDIRECT,
  _peekCachedTokenExpiryForTesting,
  _resetGoogleDriveClientState,
  _setOAuth2ClientFactoryForTesting,
  getGoogleDriveAccessToken,
  getGoogleDriveOAuth2Client,
  type OAuth2ClientFactory,
  type OAuth2ClientLike
} from "../lib/backup/replication/drive-client";
import { classifyGoogleError } from "../lib/backup/replication/classifier";
import {
  GoogleDriveOperationError,
  extractGoogleReason,
  extractHttpStatus,
  extractOAuthErrorCode,
  extractSystemErrorCode,
  sanitizeGoogleError
} from "../lib/backup/replication/errors";
import { GoogleDriveConfigError } from "../lib/backup/replication/config";

// ─── Env fixture ───────────────────────────────────────────────────────────

const ENV_KEYS = [
  "GOOGLE_DRIVE_BACKUP_ENABLED",
  "GOOGLE_DRIVE_AUTH_MODE",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_DRIVE_UPLOAD_CHUNK_MIB",
  "GOOGLE_DRIVE_HTTP_TIMEOUT_MS"
] as const;

const FAKE = {
  CLIENT_ID: "fake-drive-auth-test-client-id.apps.googleusercontent.com",
  CLIENT_SECRET: "fake-drive-auth-test-client-secret",
  REFRESH_TOKEN: "1//fake-drive-auth-test-refresh-token-xyz"
} as const;

let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): void {
  originalEnv = {};
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetGoogleDriveConfigCache();
  _resetGoogleDriveClientState();
}

function setGoodEnv(): void {
  process.env.GOOGLE_DRIVE_BACKUP_ENABLED = "true";
  process.env.GOOGLE_DRIVE_CLIENT_ID = FAKE.CLIENT_ID;
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = FAKE.CLIENT_SECRET;
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = FAKE.REFRESH_TOKEN;
  delete process.env.GOOGLE_DRIVE_AUTH_MODE;
  delete process.env.GOOGLE_DRIVE_FOLDER_ID;
  delete process.env.GOOGLE_DRIVE_UPLOAD_CHUNK_MIB;
  delete process.env.GOOGLE_DRIVE_HTTP_TIMEOUT_MS;
  _resetGoogleDriveConfigCache();
  _resetGoogleDriveClientState();
}

before(() => {
  snapshotEnv();
});
after(() => {
  restoreEnv();
});
beforeEach(() => {
  setGoodEnv();
});
afterEach(() => {
  _resetGoogleDriveClientState();
  _resetGoogleDriveConfigCache();
});

// ─── Fake OAuth2 client ────────────────────────────────────────────────────

type Scripted = {
  token?: string | null;
  expiryOffsetMs?: number | null;
  throwSync?: unknown;
  throwAsync?: unknown;
};

/**
 * Build a factory that yields a fake OAuth2Client whose behaviour is
 * scripted per call. The factory records how many times it was
 * instantiated (to prove the module singleton is honoured) and how
 * many times each fake's `getAccessToken` was invoked (to prove the
 * in-flight serialization holds).
 */
function makeScriptedFactory(script: Scripted[]): {
  factory: OAuth2ClientFactory;
  instantiations: number;
  calls: number;
  refreshTokenSeen: string | null;
  clientSecretSeen: string | null;
  lastClient: OAuth2ClientLike | null;
  metrics: () => { instantiations: number; calls: number };
} {
  const state = {
    instantiations: 0,
    calls: 0,
    refreshTokenSeen: null as string | null,
    clientSecretSeen: null as string | null,
    lastClient: null as OAuth2ClientLike | null
  };
  const factory: OAuth2ClientFactory = (opts) => {
    state.instantiations += 1;
    // Track that the loader actually passed us the env values (so
    // negative tests below can prove they were NEVER passed).
    state.refreshTokenSeen = opts.refreshToken;
    state.clientSecretSeen = opts.clientSecret;
    const creds: { expiry_date?: number | null } = {};
    const client: OAuth2ClientLike = {
      credentials: creds,
      async getAccessToken() {
        const step = script[state.calls] ?? script[script.length - 1] ?? {};
        state.calls += 1;
        if (step.throwSync !== undefined) throw step.throwSync;
        if (step.throwAsync !== undefined) {
          await Promise.resolve();
          throw step.throwAsync;
        }
        if (step.expiryOffsetMs !== undefined) {
          creds.expiry_date =
            step.expiryOffsetMs === null
              ? null
              : Date.now() + step.expiryOffsetMs;
        }
        return { token: step.token === undefined ? "fake-access-token" : step.token };
      },
      setCredentials(_creds) {
        // no-op — the factory already knows the refresh token
      }
    };
    state.lastClient = client;
    return client;
  };
  return {
    factory,
    get instantiations() {
      return state.instantiations;
    },
    get calls() {
      return state.calls;
    },
    get refreshTokenSeen() {
      return state.refreshTokenSeen;
    },
    get clientSecretSeen() {
      return state.clientSecretSeen;
    },
    get lastClient() {
      return state.lastClient;
    },
    metrics: () => ({
      instantiations: state.instantiations,
      calls: state.calls
    })
  };
}

// ─── Secret-leak hygiene helper ────────────────────────────────────────────

function assertNoSecretLeak(subject: unknown): void {
  const text = typeof subject === "string" ? subject : JSON.stringify(subject);
  for (const [k, v] of [
    ["CLIENT_ID", FAKE.CLIENT_ID],
    ["CLIENT_SECRET", FAKE.CLIENT_SECRET],
    ["REFRESH_TOKEN", FAKE.REFRESH_TOKEN]
  ] as const) {
    assert.ok(
      !text.includes(v),
      `secret hygiene: value for ${k} must never appear in a status/error surface`
    );
  }
}

// ─── Compile-time / runtime configuration invariants ──────────────────────

describe("compile-time constants (Layer B.1)", () => {
  test("Drive scope is the least-privilege drive.file scope", () => {
    // Locking this string prevents an accidental broadening to
    // `.../auth/drive` or `.../auth/drive.readonly` in a future edit.
    assert.equal(
      GOOGLE_DRIVE_SCOPE,
      "https://www.googleapis.com/auth/drive.file"
    );
  });

  test("only supported OAuth mode is oauth_refresh_token", () => {
    assert.equal(GOOGLE_DRIVE_AUTH_MODE, "oauth_refresh_token");
  });

  test("loopback redirect URI is bound to 127.0.0.1", () => {
    assert.equal(
      GOOGLE_DRIVE_LOOPBACK_REDIRECT,
      "http://127.0.0.1:53682/oauth2callback"
    );
    // Never bound to a public interface.
    assert.ok(!GOOGLE_DRIVE_LOOPBACK_REDIRECT.includes("0.0.0.0"));
    assert.ok(!GOOGLE_DRIVE_LOOPBACK_REDIRECT.startsWith("https://"));
  });
});

// ─── Config-gate wiring ────────────────────────────────────────────────────

describe("getGoogleDriveOAuth2Client — config gate", () => {
  test("throws GoogleDriveConfigError('DISABLED') when flag is off", () => {
    process.env.GOOGLE_DRIVE_BACKUP_ENABLED = "false";
    _resetGoogleDriveConfigCache();
    _resetGoogleDriveClientState();
    try {
      getGoogleDriveOAuth2Client();
      assert.fail("expected DISABLED throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveConfigError);
      assert.equal((err as GoogleDriveConfigError).code, "DISABLED");
      assertNoSecretLeak((err as Error).message);
    }
  });

  test("throws GoogleDriveConfigError('MISSING') when a required env is empty", () => {
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    _resetGoogleDriveConfigCache();
    _resetGoogleDriveClientState();
    try {
      getGoogleDriveOAuth2Client();
      assert.fail("expected MISSING throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveConfigError);
      assert.equal((err as GoogleDriveConfigError).code, "MISSING");
      assertNoSecretLeak((err as Error).message);
    }
  });

  test("memoizes the client — same reference on repeat calls", () => {
    const scripted = makeScriptedFactory([{ expiryOffsetMs: 3_600_000 }]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);
    const a = getGoogleDriveOAuth2Client();
    const b = getGoogleDriveOAuth2Client();
    assert.equal(a, b, "must return the same cached client instance");
    assert.equal(scripted.instantiations, 1);
  });
});

// ─── Access token cache + refresh window ───────────────────────────────────

describe("getGoogleDriveAccessToken — cache + refresh window", () => {
  test("first call fetches, subsequent calls within window return cache", async () => {
    const scripted = makeScriptedFactory([
      { token: "access-1", expiryOffsetMs: 3_600_000 }
    ]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);

    const t1 = await getGoogleDriveAccessToken();
    const t2 = await getGoogleDriveAccessToken();
    const t3 = await getGoogleDriveAccessToken();

    assert.equal(t1, "access-1");
    assert.equal(t2, "access-1");
    assert.equal(t3, "access-1");
    assert.equal(scripted.calls, 1, "only ONE upstream fetch across 3 reads");
  });

  test("refreshes when cached token expires within 60s leeway", async () => {
    const scripted = makeScriptedFactory([
      { token: "access-1", expiryOffsetMs: 3_600_000 },
      { token: "access-2", expiryOffsetMs: 3_600_000 }
    ]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);

    const t1 = await getGoogleDriveAccessToken();
    assert.equal(t1, "access-1");

    // Simulate 'now' inside the leeway window — the cached token
    // should be considered stale and a refresh triggered.
    const expiry = _peekCachedTokenExpiryForTesting();
    assert.ok(expiry !== null && expiry > 0);
    const nearlyExpired = expiry! - 30_000; // 30s before expiry (< 60s leeway)
    const t2 = await getGoogleDriveAccessToken(nearlyExpired);
    assert.equal(t2, "access-2");
    assert.equal(scripted.calls, 2);
  });

  test("uses fallback expiry when the client reports none", async () => {
    const scripted = makeScriptedFactory([
      { token: "access-fallback", expiryOffsetMs: null }
    ]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);
    const t = await getGoogleDriveAccessToken();
    assert.equal(t, "access-fallback");
    const expiry = _peekCachedTokenExpiryForTesting();
    assert.ok(expiry !== null);
    // Fallback lifetime is bounded (< 1h) so a broken clock can't cache
    // a token for an eternity.
    const now = Date.now();
    assert.ok(expiry! > now, "fallback expiry is in the future");
    assert.ok(
      expiry! - now <= 3_500_000,
      "fallback expiry is <= 1h (bounded lifetime)"
    );
  });
});

// ─── Serialized concurrent refresh ─────────────────────────────────────────

describe("getGoogleDriveAccessToken — concurrent refresh serialization", () => {
  test("10 parallel callers trigger exactly ONE upstream refresh", async () => {
    type FetchResolver = (val: { token?: string }) => void;
    // Use a mutable object box so the callback-side assignment survives
    // TypeScript's control-flow narrowing.
    const gate: { resolver: FetchResolver | null } = { resolver: null };
    const factory: OAuth2ClientFactory = () => {
      const creds: { expiry_date?: number | null } = {};
      let getAccessTokenCalls = 0;
      return {
        credentials: creds,
        async getAccessToken() {
          getAccessTokenCalls += 1;
          // The first call blocks until we let it proceed; if
          // serialization is broken, we would see multiple concurrent
          // calls here.
          assert.equal(
            getAccessTokenCalls,
            1,
            "getAccessToken must be called EXACTLY once under concurrent load"
          );
          return await new Promise<{ token: string }>((resolve) => {
            gate.resolver = (val) => {
              creds.expiry_date = Date.now() + 3_600_000;
              resolve({ token: val.token ?? "concurrent-token" });
            };
          });
        }
      };
    };
    _setOAuth2ClientFactoryForTesting(factory);

    // Fire 10 concurrent requests.
    const promises = Array.from({ length: 10 }, () =>
      getGoogleDriveAccessToken()
    );

    // Wait a tick so all 10 have entered the refresh path.
    await Promise.resolve();
    await Promise.resolve();

    // Release the single upstream fetch.
    assert.ok(gate.resolver !== null, "the single fetch must have been queued");
    gate.resolver({ token: "concurrent-token" });

    const results = await Promise.all(promises);
    assert.deepEqual(results, Array(10).fill("concurrent-token"));
  });

  test("failed refresh clears the in-flight slot and cache", async () => {
    const scripted = makeScriptedFactory([
      {
        throwAsync: buildOAuthError({ status: 400, error: "invalid_grant" })
      },
      { token: "recovered", expiryOffsetMs: 3_600_000 }
    ]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);

    let first: unknown = null;
    try {
      await getGoogleDriveAccessToken();
      assert.fail("expected refresh to throw");
    } catch (err) {
      first = err;
    }
    assert.ok(first instanceof GoogleDriveOperationError);
    assert.equal(
      (first as GoogleDriveOperationError).code,
      "REVOKED_AUTHORIZATION"
    );
    // Cache must be cleared.
    assert.equal(_peekCachedTokenExpiryForTesting(), null);

    // Second attempt should re-enter the factory — the fake's second
    // scripted step returns a valid token.
    const t = await getGoogleDriveAccessToken();
    assert.equal(t, "recovered");
    assert.equal(scripted.calls, 2);
  });
});

// ─── Refresh failure classification (§D.3 truth table) ─────────────────────

type OAuthErrorShape = Error & {
  status: number;
  response: {
    status: number;
    data: {
      error?: string;
      error_description?: string;
      errors?: Array<{ reason?: string }>;
    };
  };
  errors?: Array<{ reason?: string }>;
};

function buildOAuthError(opts: {
  status: number;
  error?: string;
  reason?: string;
}): OAuthErrorShape {
  // Shape gaxios/google-auth-library uses. We deliberately embed the
  // sensitive-looking `error_description` field with the FAKE
  // REFRESH_TOKEN inside it to prove that:
  //   (a) the classifier does NOT read `error_description`
  //   (b) the sanitized message NEVER contains it
  const err = new Error("oauth-token-exchange-failed") as OAuthErrorShape;
  err.status = opts.status;
  const data: {
    error?: string;
    error_description?: string;
    errors?: Array<{ reason?: string }>;
  } = {};
  if (opts.error !== undefined) data.error = opts.error;
  data.error_description = `token=${FAKE.REFRESH_TOKEN} rejected`;
  if (opts.reason !== undefined) {
    // Some Google endpoints surface reason under the top-level
    // `errors` array; others nest it under `response.data.errors`.
    // Populate both so the extractor works either way in tests.
    data.errors = [{ reason: opts.reason }];
    err.errors = [{ reason: opts.reason }];
  }
  err.response = {
    status: opts.status,
    data
  };
  return err;
}

function buildNetworkError(code: string): Error {
  const e = new Error("network") as Error & { code?: string };
  e.code = code;
  return e;
}

describe("classifyGoogleError — Layer D.3 truth table", () => {
  const cases: Array<{
    name: string;
    err: () => unknown;
    code: string;
    retryable: boolean;
  }> = [
    {
      name: "invalid_grant → REVOKED_AUTHORIZATION (non-retryable)",
      err: () => buildOAuthError({ status: 400, error: "invalid_grant" }),
      code: "REVOKED_AUTHORIZATION",
      retryable: false
    },
    {
      name: "invalid_client → CONFIGURATION_ERROR (non-retryable)",
      err: () => buildOAuthError({ status: 400, error: "invalid_client" }),
      code: "CONFIGURATION_ERROR",
      retryable: false
    },
    {
      name: "invalid_scope → CONFIGURATION_ERROR (non-retryable)",
      err: () => buildOAuthError({ status: 400, error: "invalid_scope" }),
      code: "CONFIGURATION_ERROR",
      retryable: false
    },
    {
      name: "unauthorized_client → CONFIGURATION_ERROR (non-retryable)",
      err: () => buildOAuthError({ status: 400, error: "unauthorized_client" }),
      code: "CONFIGURATION_ERROR",
      retryable: false
    },
    {
      name: "401 → AUTHENTICATION_ERROR (retryable, escalation done at call site)",
      err: () => buildOAuthError({ status: 401 }),
      code: "AUTHENTICATION_ERROR",
      retryable: true
    },
    {
      name: "403 userRateLimitExceeded → RATE_LIMITED (retryable)",
      err: () =>
        buildOAuthError({ status: 403, reason: "userRateLimitExceeded" }),
      code: "RATE_LIMITED",
      retryable: true
    },
    {
      name: "403 storageQuotaExceeded → QUOTA_EXCEEDED (non-retryable)",
      err: () =>
        buildOAuthError({ status: 403, reason: "storageQuotaExceeded" }),
      code: "QUOTA_EXCEEDED",
      retryable: false
    },
    {
      name: "403 generic → AUTHORIZATION_ERROR (non-retryable)",
      err: () => buildOAuthError({ status: 403 }),
      code: "AUTHORIZATION_ERROR",
      retryable: false
    },
    {
      name: "404 → DESTINATION_NOT_FOUND (non-retryable)",
      err: () => buildOAuthError({ status: 404 }),
      code: "DESTINATION_NOT_FOUND",
      retryable: false
    },
    {
      name: "410 → UPLOAD_SESSION_EXPIRED (retryable)",
      err: () => buildOAuthError({ status: 410 }),
      code: "UPLOAD_SESSION_EXPIRED",
      retryable: true
    },
    {
      name: "429 → RATE_LIMITED (retryable)",
      err: () => buildOAuthError({ status: 429 }),
      code: "RATE_LIMITED",
      retryable: true
    },
    {
      name: "500 → SERVER_ERROR (retryable)",
      err: () => buildOAuthError({ status: 500 }),
      code: "SERVER_ERROR",
      retryable: true
    },
    {
      name: "503 → SERVER_ERROR (retryable)",
      err: () => buildOAuthError({ status: 503 }),
      code: "SERVER_ERROR",
      retryable: true
    },
    {
      name: "ECONNRESET → NETWORK_ERROR (retryable)",
      err: () => buildNetworkError("ECONNRESET"),
      code: "NETWORK_ERROR",
      retryable: true
    },
    {
      name: "ETIMEDOUT → TIMEOUT (retryable)",
      err: () => buildNetworkError("ETIMEDOUT"),
      code: "TIMEOUT",
      retryable: true
    },
    {
      name: "ENOTFOUND → NETWORK_ERROR (retryable)",
      err: () => buildNetworkError("ENOTFOUND"),
      code: "NETWORK_ERROR",
      retryable: true
    },
    {
      name: "random string thrown → UNKNOWN (non-retryable)",
      err: () => "unexpected string error",
      code: "UNKNOWN",
      retryable: false
    }
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = classifyGoogleError(c.err());
      assert.equal(result.code, c.code);
      assert.equal(result.retryable, c.retryable);
      // Sanitized message hygiene — no secret ever leaks through.
      assertNoSecretLeak(result.sanitizedMessage);
      // Bounded well under the 512-char column cap.
      assert.ok(result.sanitizedMessage.length < 200);
    });
  }
});

// ─── Refresh failures flow through getGoogleDriveAccessToken ───────────────

describe("getGoogleDriveAccessToken — refresh error flow", () => {
  test("invalid_grant surfaces as GoogleDriveOperationError(REVOKED_AUTHORIZATION)", async () => {
    const scripted = makeScriptedFactory([
      {
        throwAsync: buildOAuthError({ status: 400, error: "invalid_grant" })
      }
    ]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);
    try {
      await getGoogleDriveAccessToken();
      assert.fail("expected REVOKED_AUTHORIZATION throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "REVOKED_AUTHORIZATION");
      assert.equal(e.retryable, false);
      assert.equal(e.httpStatus, 400);
      assertNoSecretLeak(e.message);
      assertNoSecretLeak(e.stack ?? "");
    }
  });

  test("transient 500 surfaces as SERVER_ERROR (retryable)", async () => {
    const scripted = makeScriptedFactory([
      { throwAsync: buildOAuthError({ status: 500 }) }
    ]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);
    try {
      await getGoogleDriveAccessToken();
      assert.fail("expected SERVER_ERROR throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "SERVER_ERROR");
      assert.equal(e.retryable, true);
    }
  });

  test("empty token response surfaces as AUTHENTICATION_ERROR", async () => {
    const scripted = makeScriptedFactory([
      { token: null, expiryOffsetMs: 3_600_000 }
    ]);
    _setOAuth2ClientFactoryForTesting(scripted.factory);
    try {
      await getGoogleDriveAccessToken();
      assert.fail("expected AUTHENTICATION_ERROR throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      assert.equal(
        (err as GoogleDriveOperationError).code,
        "AUTHENTICATION_ERROR"
      );
    }
  });
});

// ─── Sanitizer / extractor hygiene ─────────────────────────────────────────

describe("sanitizeGoogleError + field extractors", () => {
  test("sanitizeGoogleError returns name only, never err.message", () => {
    const err = buildOAuthError({ status: 400, error: "invalid_grant" });
    const s = sanitizeGoogleError(err);
    // name + status only
    assert.equal(s.name, "Error");
    assert.equal(s.httpStatus, 400);
    // no other keys leak through
    assert.deepEqual(Object.keys(s).sort(), ["httpStatus", "name"]);
    assertNoSecretLeak(JSON.stringify(s));
  });

  test("extractOAuthErrorCode picks up canonical enums only", () => {
    assert.equal(
      extractOAuthErrorCode(buildOAuthError({ status: 400, error: "invalid_grant" })),
      "invalid_grant"
    );
    assert.equal(
      extractOAuthErrorCode(buildOAuthError({ status: 500 })),
      null
    );
    assert.equal(extractOAuthErrorCode(null), null);
    assert.equal(extractOAuthErrorCode("string-error"), null);
    // Injection attempt: a value that looks like a URL or contains
    // non-snake-case must be rejected outright.
    const weird = new Error() as Error & {
      response?: { data?: { error?: string } };
    };
    weird.response = { data: { error: "https://evil.example/hello" } };
    assert.equal(extractOAuthErrorCode(weird), null);
  });

  test("extractSystemErrorCode picks up ALL_CAPS_UNDERSCORE only", () => {
    assert.equal(extractSystemErrorCode(buildNetworkError("ECONNRESET")), "ECONNRESET");
    assert.equal(extractSystemErrorCode(buildNetworkError("ETIMEDOUT")), "ETIMEDOUT");
    // Reject lower-case or arbitrary strings.
    const weird = new Error() as Error & { code?: string };
    weird.code = "someLowercase";
    assert.equal(extractSystemErrorCode(weird), null);
  });

  test("extractHttpStatus reads status without touching messages", () => {
    assert.equal(extractHttpStatus(buildOAuthError({ status: 429 })), 429);
    // Nested response.status shape
    const nested = new Error() as Error & { response?: { status: number } };
    nested.response = { status: 502 };
    assert.equal(extractHttpStatus(nested), 502);
  });

  test("extractGoogleReason ignores non-alpha reasons (injection defense)", () => {
    assert.equal(
      extractGoogleReason(
        buildOAuthError({ status: 403, reason: "storageQuotaExceeded" })
      ),
      "storageQuotaExceeded"
    );
    const bad = new Error() as Error & {
      errors?: Array<{ reason?: string }>;
    };
    bad.errors = [{ reason: "hello@world" }];
    assert.equal(extractGoogleReason(bad), null);
  });
});

// ─── Global no-secret-leak sanity check ────────────────────────────────────
//
// Buffer stdout + stderr for the whole suite and, at the very end,
// assert that neither ever contained our fake refresh token or client
// secret. This is our belt-and-braces guarantee that even a stray
// console.log from a future edit will fail the suite loudly.
//
// Implementation: we install a Writable proxy in `before()` and let
// each test still write freely (test output flows through). The final
// `after()` asserts on the accumulated buffer.

const capturedStdout: string[] = [];
const capturedStderr: string[] = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

before(() => {
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string") capturedStdout.push(chunk);
    else if (chunk instanceof Buffer) capturedStdout.push(chunk.toString("utf8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalStdoutWrite as any)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string") capturedStderr.push(chunk);
    else if (chunk instanceof Buffer) capturedStderr.push(chunk.toString("utf8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalStderrWrite as any)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

after(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  const out = capturedStdout.join("");
  const err = capturedStderr.join("");
  const combined = out + "\n" + err;
  for (const [k, v] of [
    ["CLIENT_SECRET", FAKE.CLIENT_SECRET],
    ["REFRESH_TOKEN", FAKE.REFRESH_TOKEN]
  ] as const) {
    assert.ok(
      !combined.includes(v),
      `no test output line may contain the fake ${k} value`
    );
  }
});

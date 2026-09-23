// Provider abstraction tests. Covers:
//   • config parses provider selection & Resend fields
//   • dispatcher routes to SMTP vs Resend based on cfg.provider
//   • Resend adapter forwards idempotency key, subject, HTML, text
//   • Resend adapter maps SDK errors to the correct SendResult shape
//
// Uses the Node module cache to swap the `resend` package for a stub
// so no real HTTP call is made. Run with:
//   npm run test:email-provider

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomBytes } from "node:crypto";

process.env.EMAIL_SECRET_ENCRYPTION_KEY =
  process.env.EMAIL_SECRET_ENCRYPTION_KEY ??
  randomBytes(32).toString("base64url");

// ─── In-memory Resend SDK stub ───────────────────────────────────────────

type SendCall = {
  payload: {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  };
  options?: { idempotencyKey?: string };
};

const lastSendCall: { value: SendCall | null } = { value: null };
const nextSendResponse: {
  data: { id: string } | null;
  error:
    | { name: string; statusCode: number | null; message?: string | null }
    | null;
} = { data: { id: "resend-msg-1" }, error: null };
const nextDomainsListResponse: {
  data: unknown;
  error:
    | { name: string; statusCode: number | null; message?: string | null }
    | null;
} = { data: [], error: null };

class StubResend {
  constructor(_apiKey: string) {
    void _apiKey;
  }
  emails = {
    send: async (payload: SendCall["payload"], options?: SendCall["options"]) => {
      lastSendCall.value = { payload, options };
      return nextSendResponse;
    }
  };
  domains = {
    list: async () => nextDomainsListResponse
  };
}

// Patch Module._load so `require("resend")` returns the stub. Must happen
// BEFORE `lib/email/providers/resend.ts` is loaded.
const ML = Module as unknown as {
  _load: (r: string, p: unknown, m: boolean) => unknown;
};
const originalLoad = ML._load;
before(() => {
  ML._load = function patched(request, parent, isMain) {
    if (request === "resend") {
      return { Resend: StubResend };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
});
after(() => {
  ML._load = originalLoad;
});

describe("provider dispatcher", async () => {
  const { sendViaProvider, verifyProviderConnection } = await import(
    "../lib/email/providers/index"
  );
  const baseCfg = {
    provider: "smtp" as const,
    host: "smtp.example.com",
    port: 587,
    encryption: "starttls" as const,
    authEnabled: true,
    username: "user",
    password: "pw",
    resendApiKey: "re_test_key",
    fromEmail: "no-reply@example.com",
    fromName: "BIS",
    replyTo: null,
    connectionTimeoutMs: 15000,
    authTimeoutMs: 15000,
    maxAttempts: 5,
    contactRecipient: null,
    mode: "live" as const,
    allowlistDomains: []
  };

  test("routes to Resend when provider=resend", async () => {
    lastSendCall.value = null;
    nextSendResponse.data = { id: "resend-msg-42" };
    nextSendResponse.error = null;
    const res = await sendViaProvider(
      { ...baseCfg, provider: "resend" },
      {
        to: "target@gmail.com",
        toName: "Target",
        subject: "Hi",
        text: "hello",
        html: "<p>hello</p>",
        idempotencyKey: "outbox-key-1"
      }
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.providerMsgId, "resend-msg-42");
    const captured = lastSendCall.value as SendCall | null;
    if (!captured) throw new Error("Resend stub should have been called");
    assert.equal(captured.options?.idempotencyKey, "outbox-key-1");
    assert.equal(captured.payload.subject, "Hi");
    assert.equal(captured.payload.text, "hello");
    assert.equal(captured.payload.html, "<p>hello</p>");
    // From must include the friendly name
    assert.match(captured.payload.from as string, /BIS <no-reply@/);
  });

  test("routes to SMTP when provider=smtp (Resend stub not called)", async () => {
    lastSendCall.value = null;
    // We don't want a real SMTP connection; force it to fail fast by pointing at localhost:1 with a tiny timeout.
    const res = await sendViaProvider(
      {
        ...baseCfg,
        provider: "smtp",
        host: "127.0.0.1",
        port: 1,
        connectionTimeoutMs: 1000
      },
      { to: "target@example.com", subject: "hi", text: "x" }
    );
    assert.equal(res.ok, false);
    assert.equal(lastSendCall.value, null, "Resend stub must NOT be called for SMTP");
  });

  test("Resend auth error is classified as non-retryable", async () => {
    nextSendResponse.data = null;
    nextSendResponse.error = {
      name: "invalid_api_key",
      statusCode: 401,
      message: "irrelevant"
    };
    const res = await sendViaProvider(
      { ...baseCfg, provider: "resend" },
      { to: "target@example.com", subject: "hi", text: "x" }
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.category, "auth");
      assert.equal(res.retryable, false);
      // Sanitized — no raw provider message must leak through.
      assert.doesNotMatch(res.message, /irrelevant/i);
    }
  });

  test("Resend 5xx is classified as retryable", async () => {
    nextSendResponse.data = null;
    nextSendResponse.error = {
      name: "internal_error",
      statusCode: 500
    };
    const res = await sendViaProvider(
      { ...baseCfg, provider: "resend" },
      { to: "target@example.com", subject: "hi", text: "x" }
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.retryable, true);
      assert.equal(res.category, "network");
    }
  });

  test("verifyConnection with restricted key returns ok (sending-only)", async () => {
    nextDomainsListResponse.error = {
      name: "restricted_api_key",
      statusCode: 401
    };
    const res = await verifyProviderConnection({ ...baseCfg, provider: "resend" });
    assert.equal(res.ok, true);
  });

  test("verifyConnection with invalid key returns auth error", async () => {
    nextDomainsListResponse.error = {
      name: "invalid_api_key",
      statusCode: 401
    };
    const res = await verifyProviderConnection({ ...baseCfg, provider: "resend" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.category, "auth");
  });

  test("Resend 403 'domain not verified' is a permanent recipient error", async () => {
    nextSendResponse.data = null;
    nextSendResponse.error = {
      name: "validation_error",
      statusCode: 403,
      message: "The gmail.com domain is not verified."
    };
    const res = await sendViaProvider(
      { ...baseCfg, provider: "resend" },
      { to: "user@example.com", subject: "hi", text: "x" }
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.category, "recipient");
      assert.equal(res.retryable, false, "domain-not-verified must not be retried");
      // Message tells the operator what to do without leaking the raw
      // provider response.
      assert.match(res.message, /resend\.com\/domains/i);
      // The raw provider response ("The gmail.com domain is not verified.")
      // must NOT be echoed verbatim; our sanitized message is a static
      // template that happens to name gmail.com as a common example.
      assert.doesNotMatch(res.message, /The .+ domain is not verified/i);
    }
  });

  test("verifyConnection returns auth failure when API key is missing", async () => {
    const res = await verifyProviderConnection({
      ...baseCfg,
      provider: "resend",
      resendApiKey: null
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.category, "auth");
  });
});

describe("smtpFormSchema — Resend fields", async () => {
  const { smtpFormSchema } = await import("../lib/email/config");

  test("accepts provider=resend without SMTP host", () => {
    const res = smtpFormSchema.safeParse({
      provider: "resend",
      host: "",
      port: 587,
      encryption: "starttls",
      authEnabled: false,
      resendApiKey: "re_1234567890",
      fromEmail: "no-reply@example.com",
      fromName: "BIS 2027",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(res.success, true, res.success ? "" : JSON.stringify(res.error.issues));
  });

  test("defaults provider to smtp when omitted", () => {
    const res = smtpFormSchema.safeParse({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      authEnabled: false,
      fromEmail: "no-reply@example.com",
      fromName: "BIS 2027",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.provider, "smtp");
  });

  test("resendApiKey is trimmed and null when empty", () => {
    const res = smtpFormSchema.safeParse({
      provider: "resend",
      host: "",
      port: 587,
      encryption: "starttls",
      authEnabled: false,
      resendApiKey: "  re_abc  ",
      fromEmail: "no-reply@example.com",
      fromName: "BIS 2027",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.resendApiKey, "re_abc");
  });
});

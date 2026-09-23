// Tests for lib/email/config validation + env overlay precedence.
//   npm run test:email-config
// Pure — no DB required (only tests validation + env overlay logic).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { smtpFormSchema } from "../lib/email/config";

describe("smtpFormSchema", () => {
  test("accepts a minimal live config with STARTTLS + auth", () => {
    const res = smtpFormSchema.safeParse({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      authEnabled: true,
      username: "user@example.com",
      password: "hunter2",
      fromEmail: "no-reply@example.com",
      fromName: "BIS 2027",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(res.success, true);
  });

  test("rejects invalid ports", () => {
    for (const port of [0, 65536, -1, 999999]) {
      const res = smtpFormSchema.safeParse({
        host: "smtp.example.com",
        port,
        encryption: "starttls",
        authEnabled: false,
        fromEmail: "no-reply@example.com",
        fromName: "BIS 2027",
        connectionTimeoutMs: 15000,
        authTimeoutMs: 15000,
        maxAttempts: 5,
        mode: "live"
      });
      assert.equal(res.success, false, `port ${port} should be rejected`);
    }
  });

  test("rejects invalid fromEmail", () => {
    const res = smtpFormSchema.safeParse({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      authEnabled: false,
      fromEmail: "not-an-email",
      fromName: "BIS 2027",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(res.success, false);
  });

  test("parses contactRecipient when set, empty string becomes null", () => {
    const withRecipient = smtpFormSchema.safeParse({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      authEnabled: false,
      fromEmail: "no-reply@example.com",
      fromName: "BIS 2027",
      contactRecipient: "ops@example.com",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(withRecipient.success, true);
    if (withRecipient.success) {
      assert.equal(withRecipient.data.contactRecipient, "ops@example.com");
    }
    const empty = smtpFormSchema.safeParse({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      authEnabled: false,
      fromEmail: "no-reply@example.com",
      fromName: "BIS 2027",
      contactRecipient: "",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(empty.success, true);
    if (empty.success) {
      assert.equal(empty.data.contactRecipient, null);
    }
  });

  test("rejects an invalid contactRecipient", () => {
    const res = smtpFormSchema.safeParse({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      authEnabled: false,
      fromEmail: "no-reply@example.com",
      fromName: "BIS 2027",
      contactRecipient: "not-an-email",
      connectionTimeoutMs: 15000,
      authTimeoutMs: 15000,
      maxAttempts: 5,
      mode: "live"
    });
    assert.equal(res.success, false);
  });

  test("allowlistDomains splits + filters + normalizes", () => {
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
      mode: "live",
      allowlistDomains: "Example.com,  bis-ops.dev, garbage, tld-only"
    });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.allowlistDomains, [
        "example.com",
        "bis-ops.dev"
      ]);
    }
  });

  test("clearPassword flag defaults false", () => {
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
    if (res.success) {
      assert.equal(res.data.clearPassword, false);
    }
  });
});

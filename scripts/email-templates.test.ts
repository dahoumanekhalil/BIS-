// Tests for lib/admin/email-templates — asserts every trigger references a
// registered template. Pure — no DB required.
//   npm run test:email-templates

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EMAIL_TEMPLATES } from "../lib/admin/email-templates";

const REQUIRED_KEYS = [
  // pre-existing
  "welcome",
  "payment-confirmed",
  "payment-reminder",
  "ticket-delivered",
  "gate-assigned",
  "day-before",
  "check-in-morning",
  "post-event-thanks",
  "cancellation",
  "waitlist-promotion",
  "registration-visitor-received",
  "registration-company-received",
  "application-sponsor-received",
  "application-partner-received",
  "application-speaker-received",
  "application-creator-received",
  // added by Email Infrastructure phase
  "auth-email-verify",
  "auth-password-reset",
  "auth-password-changed",
  "room-registration-free-confirmed",
  "room-registration-pending-payment",
  "room-registration-paid",
  "room-registration-refunded",
  "room-registration-cancelled",
  "contact-form-relay",
  "admin-test-email"
];

describe("email templates catalog", () => {
  test("every required template is registered", () => {
    const registered = new Set(EMAIL_TEMPLATES.map((t) => t.key));
    for (const key of REQUIRED_KEYS) {
      assert.equal(
        registered.has(key),
        true,
        `template ${key} missing from EMAIL_TEMPLATES`
      );
    }
  });

  test("no duplicate template keys", () => {
    const seen = new Set<string>();
    for (const t of EMAIL_TEMPLATES) {
      assert.equal(seen.has(t.key), false, `duplicate template key: ${t.key}`);
      seen.add(t.key);
    }
  });

  test("every template has a subject and at least one paragraph", () => {
    for (const t of EMAIL_TEMPLATES) {
      assert.ok(t.subject && t.subject.length > 0, `${t.key} missing subject`);
      assert.ok(
        Array.isArray(t.content.paragraphs) && t.content.paragraphs.length > 0,
        `${t.key} missing paragraphs`
      );
    }
  });
});

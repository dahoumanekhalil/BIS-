// Tests for the email template management system.
//
// Covers:
//   • sanitize.ts   — dangerous-tag stripping + JS URL rejection
//   • registry.ts   — placeholder extraction + unknown-var detection
//   • service.ts    — validateTemplatePayload + resolveTemplate + fallback
//   • db-render.ts  — full render with substitution + header/footer wrap
//
// DB-dependent — hits the app database via prisma. Run with:
//   npm run test:email-template-service

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.EMAIL_SECRET_ENCRYPTION_KEY =
  process.env.EMAIL_SECRET_ENCRYPTION_KEY ??
  randomBytes(32).toString("base64url");
process.env.EMAIL_MODE = process.env.EMAIL_MODE ?? "log-only";

let cleanupKeys: string[] = [];

describe("template sanitizer", async () => {
  const { sanitizeTemplateHtml, detectDangerousPatterns } = await import(
    "../lib/email/templates/sanitize"
  );

  test("strips <script>", () => {
    const out = sanitizeTemplateHtml("<p>Hi</p><script>alert(1)</script>");
    assert.ok(!/script/i.test(out), out);
    assert.match(out, /<p>Hi<\/p>/);
  });

  test("strips <iframe>", () => {
    const out = sanitizeTemplateHtml('<iframe src="https://x"></iframe><p>Hi</p>');
    assert.ok(!/iframe/i.test(out), out);
  });

  test("strips on* event handlers", () => {
    const out = sanitizeTemplateHtml('<a href="https://ok" onclick="steal()">go</a>');
    assert.ok(!/onclick/i.test(out), out);
    assert.match(out, /href="https:\/\/ok"/);
  });

  test("blocks javascript: URLs", () => {
    const out = sanitizeTemplateHtml('<a href="javascript:alert(1)">x</a>');
    assert.ok(!/javascript:/i.test(out), out);
  });

  test("adds rel=noopener + target=_blank to anchors", () => {
    const out = sanitizeTemplateHtml('<a href="https://example.com">go</a>');
    assert.match(out, /rel="noopener noreferrer"/);
    assert.match(out, /target="_blank"/);
  });

  test("preserves {{variable}} tokens intact", () => {
    const out = sanitizeTemplateHtml("<p>Hi {{firstName}}!</p>");
    assert.match(out, /\{\{firstName\}\}/);
  });

  test("detectDangerousPatterns catches script + onload + javascript:", () => {
    const findings = detectDangerousPatterns(
      '<script>x</script><img onload="y"><a href="javascript:z">z</a>'
    );
    assert.equal(findings.length >= 3, true, `expected >=3 findings, got ${findings.length}`);
  });
});

describe("variable registry", async () => {
  const { extractPlaceholders, unknownPlaceholders, isKnownVariable } =
    await import("../lib/email/templates/registry");

  test("extracts all placeholder names", () => {
    const found = extractPlaceholders("Hi {{firstName}} and {{lastName}}, code={{ticketCode}}");
    assert.deepEqual(new Set(found), new Set(["firstName", "lastName", "ticketCode"]));
  });

  test("unknownPlaceholders flags names not in the registry", () => {
    const bad = unknownPlaceholders("Hi {{firstName}} and {{customer_name}}");
    assert.deepEqual(bad, ["customer_name"]);
  });

  test("isKnownVariable is case-sensitive", () => {
    assert.equal(isKnownVariable("firstName"), true);
    assert.equal(isKnownVariable("firstname"), false);
  });
});

describe("service.validateTemplatePayload", async () => {
  const { validateTemplatePayload } = await import("../lib/email/templates/service");

  test("rejects empty subject", () => {
    const errs = validateTemplatePayload({
      subject: "",
      htmlBody: "<p>hi</p>",
      textBody: "hi"
    });
    assert.ok(errs.some((e) => e.code === "subject-empty"));
  });

  test("rejects dangerous HTML with a targeted reason", () => {
    const errs = validateTemplatePayload({
      subject: "hi",
      htmlBody: "<p>hi</p><script>alert(1)</script>",
      textBody: "hi"
    });
    assert.ok(errs.some((e) => e.code === "html-dangerous" && /script/i.test(e.message)));
  });

  test("rejects unknown variables in subject / html / text", () => {
    const errs = validateTemplatePayload({
      subject: "hi {{unknown_var}}",
      htmlBody: "<p>hi {{firstName}}</p>",
      textBody: "hi {{another_bad}}"
    });
    const unknowns = errs.filter((e) => e.code === "unknown-variable");
    assert.equal(unknowns.length, 2);
  });

  test("valid payload → zero errors", () => {
    const errs = validateTemplatePayload({
      subject: "Bonjour {{firstName}}",
      htmlBody: "<p>Bonjour {{firstName}} — <a href=\"https://ok\">go</a></p>",
      textBody: "Bonjour {{firstName}}"
    });
    assert.deepEqual(errs, []);
  });
});

describe("DB template render", async () => {
  const { renderDbTemplate } = await import("../lib/email/templates/db-render");
  const { defaultBranding } = await import("../lib/email/templates/branding");

  test("substitutes variables and wraps with header/footer", () => {
    const out = renderDbTemplate({
      subject: "Hi {{firstName}}",
      preheader: "Preview for {{firstName}}",
      htmlBody: "<p>Hello <strong>{{firstName}}</strong></p>",
      textBody: "Hello {{firstName}}",
      useHeader: true,
      useFooter: true,
      branding: defaultBranding(),
      vars: { firstName: "Fatima" }
    });
    assert.equal(out.subject, "Hi Fatima");
    assert.match(out.html, /Hello <strong>Fatima<\/strong>/);
    // Preheader lives in the hidden preview-text block
    assert.match(out.html, /Preview for Fatima/);
    assert.match(out.text, /Hello Fatima/);
    // Header + footer visible
    assert.match(out.html, /background:#111827/); // header background
  });

  test("HTML-escapes user-controlled vars (no XSS via values)", () => {
    const out = renderDbTemplate({
      subject: "s",
      preheader: null,
      htmlBody: "<p>Hi {{firstName}}</p>",
      textBody: "hi",
      useHeader: false,
      useFooter: false,
      branding: defaultBranding(),
      vars: { firstName: "<script>bad()</script>" }
    });
    assert.ok(!/<script>bad/i.test(out.html), out.html);
    // The literal escaped form must appear
    assert.match(out.html, /&lt;script&gt;/);
  });

  test("javascript: URLs in variable values are stripped from href", () => {
    // Admin template puts {{contactMessage}} inside href — a hostile user
    // supplies "javascript:alert(1)". The double-sanitize pass must
    // strip the anchor entirely (or drop the href scheme).
    const out = renderDbTemplate({
      subject: "s",
      preheader: null,
      htmlBody: '<p>Click: <a href="{{contactMessage}}">link</a></p>',
      textBody: "hi",
      useHeader: false,
      useFooter: false,
      branding: defaultBranding(),
      vars: { contactMessage: "javascript:alert(1)" }
    });
    assert.ok(!/javascript:/i.test(out.html), out.html);
  });

  test("CSS url() reconstituted through a variable is rejected", () => {
    // Admin puts {{contactMessage}} inside style. User supplies a CSS url()
    // to try to fire an external request from the email. The post-substitute
    // sanitize must reject the reconstituted url(...) style value.
    const out = renderDbTemplate({
      subject: "s",
      preheader: null,
      htmlBody: '<div style="background:{{contactMessage}}">x</div>',
      textBody: "hi",
      useHeader: false,
      useFooter: false,
      branding: defaultBranding(),
      vars: { contactMessage: "url(https://tracker.example/p.gif)" }
    });
    assert.ok(!/tracker\.example/.test(out.html), out.html);
  });

  test("useHeader=false / useFooter=false omits the branding chrome", () => {
    const out = renderDbTemplate({
      subject: "s",
      preheader: null,
      htmlBody: "<p>Body</p>",
      textBody: "Body",
      useHeader: false,
      useFooter: false,
      branding: defaultBranding(),
      vars: {}
    });
    // No header/footer bars → the ink background band should not appear.
    // (The container still has borders, but the dark bar with the event
    // name should be absent.)
    assert.ok(
      !new RegExp("background:#111827; padding:28px 32px").test(out.html),
      "expected header/footer bar to be absent"
    );
  });

  test("empty textBody generates a text fallback (never empty)", () => {
    const out = renderDbTemplate({
      subject: "Hello",
      preheader: null,
      htmlBody: "<p>x</p>",
      textBody: "   ",
      useHeader: true,
      useFooter: true,
      branding: defaultBranding(),
      vars: {}
    });
    assert.ok(out.text.length > 0);
    assert.match(out.text, /Hello/);
  });
});

describe("service.resolveTemplate + queue integration", async () => {
  const { prisma } = await import("../lib/db");
  const { resolveTemplate } = await import("../lib/email/templates/service");
  const { queueTemplatedEmail } = await import("../lib/email/queue");

  after(async () => {
    if (cleanupKeys.length > 0) {
      await prisma.emailTemplate.deleteMany({ where: { key: { in: cleanupKeys } } });
    }
    await prisma.emailMessage.deleteMany({
      where: { idempotencyKey: { startsWith: "test-template-svc:" } }
    });
    await prisma.$disconnect();
  });

  test("resolveTemplate returns code source when no DB row exists", async () => {
    const res = await resolveTemplate("auth-email-verify");
    assert.ok(res, "expected a code-catalog fallback for auth-email-verify");
    assert.equal(res!.kind, "code");
  });

  test("resolveTemplate prefers active DB row over code catalog", async () => {
    const key = "auth-email-verify";
    await prisma.emailTemplate.upsert({
      where: { key },
      update: {
        subject: "DB override subject",
        htmlBody: "<p>DB override</p>",
        textBody: "DB override",
        isActive: true
      },
      create: {
        key,
        name: "Verify (override)",
        category: "auth",
        subject: "DB override subject",
        htmlBody: "<p>DB override</p>",
        textBody: "DB override",
        isSystem: true,
        isActive: true
      }
    });
    cleanupKeys.push(key);

    const res = await resolveTemplate(key);
    assert.ok(res);
    assert.equal(res!.kind, "db");

    // queueTemplatedEmail should now use the DB body.
    const q = await queueTemplatedEmail({
      templateKey: key,
      to: "test@example.com",
      idempotencyKey: `test-template-svc:${Date.now()}:1`,
      vars: {
        firstName: "F",
        lastName: "Z",
        fullName: "F Z",
        email: "t@e",
        verificationUrl: "https://ok/verify",
        expiresInHours: "24"
      }
    });
    assert.equal(q.ok, true, JSON.stringify(q));
    if (q.ok) {
      const row = await prisma.emailMessage.findUnique({ where: { id: q.id } });
      assert.ok(row);
      assert.match(row!.subject, /DB override subject/);
      assert.match(row!.html ?? "", /DB override/);
      assert.match(row!.body, /DB override/);
    }
  });

  test("deactivating the DB row falls back to the code catalog", async () => {
    const key = "auth-email-verify";
    await prisma.emailTemplate.update({
      where: { key },
      data: { isActive: false }
    });
    const res = await resolveTemplate(key);
    assert.ok(res);
    assert.equal(res!.kind, "code");
  });
});

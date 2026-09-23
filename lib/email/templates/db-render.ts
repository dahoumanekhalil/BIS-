import "server-only";

import { EMAIL_COLORS, EMAIL_FONT_STACK, EMAIL_CONTAINER_WIDTH } from "../tokens";
import type { EmailBranding } from "./branding";
import { sanitizeTemplateHtml } from "./sanitize";

// ─── Renderer for admin-authored DB templates ────────────────────────────
//
// Structurally parallel to `lib/email/render.ts` (the code-catalog
// renderer), but consumes raw admin HTML instead of the structured
// EmailContent block model. Header and footer are composed from the
// EmailBranding row so the whole email system can be re-branded from
// one place.
//
// SECURITY: `htmlBody` is sanitized ONCE MORE at render time, on top of
// the sanitize-on-save that happens in the admin action. This is a
// deliberate belt-and-braces guard against any future codepath that
// might insert into `EmailTemplate.htmlBody` without going through the
// admin action.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function esc(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^(https?:|mailto:|tel:)/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Substitute {{name}} tokens with HTML-escaped values in a source string.
 * Escaping every value here is what makes it safe to interpolate user-
 * controlled data into admin-authored HTML — a `<script>` payload in
 * `firstName` becomes `&lt;script&gt;` after escape.
 */
function substituteInHtml(
  source: string,
  vars: Record<string, string>
): string {
  return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v == null ? "" : esc(v);
  });
}

/**
 * Same idea for plain text — no escaping needed, but preserve the
 * "missing → empty" semantics.
 */
function substituteInText(
  source: string,
  vars: Record<string, string>
): string {
  return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v == null ? "" : v;
  });
}

function renderHeader(branding: EmailBranding): string {
  const logo = safeUrl(branding.logoUrl);
  const logoBlock = logo
    ? `<img src="${esc(logo)}" alt="${esc(branding.eventName)}" style="display:block; max-height:48px; max-width:220px; height:auto;">`
    : `<div style="font-family:${EMAIL_FONT_STACK}; font-size:11px; font-weight:800; letter-spacing:0.28em; text-transform:uppercase; color:rgba(248,250,249,0.72);">${esc(branding.eventName)}</div>
       <div style="margin-top:6px; font-family:${EMAIL_FONT_STACK}; font-size:26px; font-weight:900; letter-spacing:-0.02em; color:${EMAIL_COLORS.white};">${esc(branding.editionLabel)}</div>`;
  return `
    <tr>
      <td style="background:${EMAIL_COLORS.ink}; padding:28px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td>${logoBlock}</td>
            <td align="right" style="vertical-align:top; font-family:${EMAIL_FONT_STACK}; font-size:10px; font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color:rgba(248,250,249,0.55);">
              ${esc(branding.eventDate)}<br>${esc(branding.eventVenue)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderFooter(branding: EmailBranding): string {
  const links: string[] = [];
  const pushLink = (label: string, url: string | null | undefined) => {
    const safe = safeUrl(url);
    if (!safe) return;
    links.push(
      `<a href="${esc(safe)}" style="color:${EMAIL_COLORS.lime}; text-decoration:none; font-weight:700;">${esc(label)}</a>`
    );
  };
  pushLink("Site", branding.siteUrl);
  pushLink("Contact", branding.contactUrl);
  pushLink("Confidentialité", branding.privacyUrl);
  pushLink("CGU", branding.termsUrl);

  const socialLinks: string[] = [];
  const pushSocial = (label: string, url: string) => {
    const safe = safeUrl(url);
    if (!safe) return;
    socialLinks.push(
      `<a href="${esc(safe)}" style="color:${EMAIL_COLORS.lime}; text-decoration:none; font-weight:700;">${esc(label)}</a>`
    );
  };
  pushSocial("LinkedIn", branding.socialLinkedIn);
  pushSocial("Instagram", branding.socialInstagram);
  pushSocial("Facebook", branding.socialFacebook);
  pushSocial("X", branding.socialX);
  pushSocial("YouTube", branding.socialYouTube);

  const sep = `&nbsp;&nbsp;<span style="color:rgba(248,250,249,0.35);">·</span>&nbsp;&nbsp;`;
  return `
    <tr>
      <td style="background:${EMAIL_COLORS.ink}; padding:28px 32px; font-family:${EMAIL_FONT_STACK};">
        <div style="font-size:12px; font-weight:800; letter-spacing:0.26em; text-transform:uppercase; color:${EMAIL_COLORS.white};">${esc(branding.editionLabel)}</div>
        <div style="margin-top:8px; font-size:12px; color:${EMAIL_COLORS.frostOnDark}; line-height:1.6;">${esc(branding.eventDate)} · ${esc(branding.eventVenue)} · ${esc(branding.eventCity)}</div>
        ${links.length ? `<div style="margin-top:18px; font-size:12px;">${links.join(sep)}</div>` : ""}
        ${socialLinks.length ? `<div style="margin-top:10px; font-size:12px;">${socialLinks.join(sep)}</div>` : ""}
        <div style="margin-top:22px; height:1px; background:rgba(248,250,249,0.12);"></div>
        <div style="margin-top:14px; font-size:11px; color:${EMAIL_COLORS.frostOnDarkMuted};">${esc(branding.footerNote)}</div>
      </td>
    </tr>
  `;
}

function renderPreheader(preheader: string): string {
  if (!preheader.trim()) return "";
  // Hidden preview text — most clients pull this as the snippet shown in
  // the inbox list before the user opens the message.
  return `<div style="display:none; overflow:hidden; visibility:hidden; opacity:0; height:0; width:0; color:transparent; font-size:1px; line-height:1px;">${esc(preheader)}</div>`;
}

export type DbRenderInput = {
  subject: string;
  preheader: string | null;
  htmlBody: string;
  textBody: string;
  useHeader: boolean;
  useFooter: boolean;
  branding: EmailBranding;
  vars: Record<string, string>;
};

export type DbRenderResult = { html: string; text: string; subject: string };

export function renderDbTemplate(input: DbRenderInput): DbRenderResult {
  const subject = substituteInText(input.subject, input.vars).trim() ||
    input.branding.editionLabel;
  const preheader = input.preheader
    ? substituteInText(input.preheader, input.vars)
    : "";

  // Sanitize → substitute → sanitize AGAIN. The first sanitize strips
  // the admin's raw HTML. Substitution HTML-escapes each variable value,
  // but an admin who wrote `<a href="{{contactMessage}}">` can still let a
  // user-supplied `javascript:...` string slip through the scheme
  // allowlist (which only ran on the pre-substitution string). Running
  // the sanitizer a second time on the substituted output closes that
  // gap — the URL-scheme allowlist re-evaluates every final attribute
  // value, and any `style="background:url(…)"` pattern that variables
  // reconstituted is also re-inspected.
  const sanitizedBody = sanitizeTemplateHtml(input.htmlBody);
  const substitutedBody = sanitizeTemplateHtml(
    substituteInHtml(sanitizedBody, input.vars)
  );

  const header = input.useHeader ? renderHeader(input.branding) : "";
  const footer = input.useFooter ? renderFooter(input.branding) : "";

  const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${esc(subject)}</title>
</head>
<body style="margin:0; padding:0; background:${EMAIL_COLORS.frost}; font-family:${EMAIL_FONT_STACK}; -webkit-font-smoothing:antialiased;">
  ${renderPreheader(preheader)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_COLORS.frost};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="${EMAIL_CONTAINER_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="max-width:${EMAIL_CONTAINER_WIDTH}px; width:100%; background:${EMAIL_COLORS.white}; border-radius:14px; overflow:hidden; box-shadow:0 20px 60px -30px rgba(15,25,60,0.15);">
          ${header}
          <tr>
            <td style="padding:36px 32px 24px 32px; font-family:${EMAIL_FONT_STACK}; font-size:15px; line-height:1.65; color:${EMAIL_COLORS.inkSoft};">
              ${substitutedBody}
            </td>
          </tr>
          ${footer}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Plain-text: substitute the admin's textBody. If the operator left it
  // empty, generate a minimal fallback so we never send an HTML-only
  // message.
  let text = substituteInText(input.textBody, input.vars).trim();
  if (!text) {
    text = [
      subject,
      "",
      "Ce message ne peut être affiché en texte brut. Ouvrez-le dans un client email compatible HTML.",
      "",
      `${input.branding.editionLabel} · ${input.branding.eventDate} · ${input.branding.eventVenue}`
    ].join("\n");
  }
  return { html, text, subject };
}

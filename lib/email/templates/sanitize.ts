import "server-only";

import sanitizeHtmlLib from "sanitize-html";

// ─── Admin-authored HTML sanitizer ───────────────────────────────────────
//
// Templates authored in the admin editor contain raw HTML written by an
// operator. Even though the operator is trusted (they hold
// `settings.email.templates`), an untrusted paste or a compromised admin
// account could try to smuggle a payload that lands in every recipient's
// mailbox. Sanitize BEFORE persistence, sanitize again at render time as
// a belt-and-braces guard.
//
// Design goals:
//   • Zero JavaScript execution surface (no <script>, no javascript:
//     URLs, no on* event handlers).
//   • Reasonable formatting freedom (headings, lists, links, images,
//     tables) so operators can build rich messages.
//   • Inline styling only from an allowlist. Prevents CSS-based
//     exfiltration or click-jacking via absolute positioning.

const SAFE_TAGS = [
  "a", "b", "blockquote", "br", "code", "div", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p",
  "pre", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "u", "ul"
];

// Attributes are locked down per-tag rather than globally. `style` is
// permitted broadly because email HTML is inline-style-driven, but the
// value is filtered through `allowedStyles` below.
const SAFE_ATTRS: sanitizeHtmlLib.IOptions["allowedAttributes"] = {
  a: ["href", "name", "target", "rel", "style", "title"],
  img: ["src", "alt", "width", "height", "style", "title"],
  table: ["role", "cellpadding", "cellspacing", "border", "width", "style"],
  td: ["align", "valign", "colspan", "rowspan", "width", "style", "bgcolor"],
  th: ["align", "valign", "colspan", "rowspan", "width", "style", "bgcolor"],
  tr: ["align", "valign", "style", "bgcolor"],
  div: ["style", "align"],
  span: ["style"],
  p: ["style", "align"],
  h1: ["style"], h2: ["style"], h3: ["style"], h4: ["style"], h5: ["style"], h6: ["style"],
  ul: ["style"], ol: ["style"], li: ["style"],
  blockquote: ["style"],
  hr: ["style"]
};

// Style-property allowlist. Absolute/fixed positioning, expressions, and
// `-webkit-` behaviours are excluded so CSS cannot be weaponised.
const ALLOWED_STYLES: sanitizeHtmlLib.IOptions["allowedStyles"] = {
  "*": {
    color: [/^.*$/],
    "background-color": [/^.*$/],
    "background": [/^(?!.*url\().*$/i],
    "font-family": [/^.*$/],
    "font-size": [/^\d+(px|pt|em|rem|%)$/],
    "font-weight": [/^(normal|bold|\d{3})$/],
    "font-style": [/^(normal|italic)$/],
    "line-height": [/^[\d.]+(px|em|rem|%|)$/],
    "letter-spacing": [/^-?[\d.]+(px|em|rem)$/],
    "text-align": [/^(left|right|center|justify)$/],
    "text-decoration": [/^(none|underline|line-through)$/],
    "text-transform": [/^(none|uppercase|lowercase|capitalize)$/],
    "padding": [/^[\d.\s]+(px|em|rem|%)$/],
    "padding-top": [/^[\d.]+(px|em|rem|%)$/],
    "padding-right": [/^[\d.]+(px|em|rem|%)$/],
    "padding-bottom": [/^[\d.]+(px|em|rem|%)$/],
    "padding-left": [/^[\d.]+(px|em|rem|%)$/],
    "margin": [/^[\d.\s]+(px|em|rem|%|auto)$/],
    "margin-top": [/^-?[\d.]+(px|em|rem|%|auto)$/],
    "margin-right": [/^-?[\d.]+(px|em|rem|%|auto)$/],
    "margin-bottom": [/^-?[\d.]+(px|em|rem|%|auto)$/],
    "margin-left": [/^-?[\d.]+(px|em|rem|%|auto)$/],
    "border": [/^[\d]+px\s+(solid|dashed|dotted)\s+.+$/],
    "border-top": [/^[\d]+px\s+(solid|dashed|dotted)\s+.+$/],
    "border-radius": [/^[\d.]+(px|em|rem|%)$/],
    "width": [/^([\d.]+(px|em|rem|%)|auto)$/],
    "max-width": [/^([\d.]+(px|em|rem|%)|none)$/],
    "min-width": [/^[\d.]+(px|em|rem|%)$/],
    "height": [/^([\d.]+(px|em|rem|%)|auto)$/],
    "display": [/^(block|inline|inline-block|table|table-cell|none)$/]
  }
};

const OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: SAFE_TAGS,
  allowedAttributes: SAFE_ATTRS,
  allowedStyles: ALLOWED_STYLES,
  // Only http/https/mailto/tel. `javascript:` is blocked by default but
  // enumerating the safe set is explicit-is-better.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto", "tel"],
    img: ["http", "https", "data"] // data: images allowed for base64 logos
  },
  // Preserve the {{variable}} placeholder syntax — dampen this and vars
  // like {{firstName}} would be corrupted into text nodes.
  parser: { decodeEntities: false },
  // Every anchor gets `rel="noopener noreferrer"` and `target="_blank"`
  // added — cheap defence against tabnabbing.
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: "_blank",
        rel: "noopener noreferrer"
      }
    })
  },
  // NOTE: `sanitize-html` already strips <script>, <style>, on* attribute
  // handlers, and javascript: URLs by default. The declarative allowlists
  // above just narrow the surface further.
  disallowedTagsMode: "discard"
};

/**
 * Sanitize an admin-authored HTML body. Applied on save AND on render
 * (belt-and-braces) so a poisoned DB row cannot slip past even if a
 * future migration bypasses the save path.
 */
export function sanitizeTemplateHtml(input: string): string {
  if (typeof input !== "string") return "";
  return sanitizeHtmlLib(input, OPTIONS);
}

/**
 * Detect specific patterns we always want to reject at validation time,
 * with human-readable reasons. Called BEFORE sanitize so the operator
 * gets a targeted error rather than a silently-stripped payload.
 */
export function detectDangerousPatterns(input: string): string[] {
  const findings: string[] = [];
  if (/<\s*script/i.test(input)) findings.push("balise <script> interdite");
  if (/<\s*iframe/i.test(input)) findings.push("balise <iframe> interdite");
  if (/<\s*object/i.test(input)) findings.push("balise <object> interdite");
  if (/<\s*embed/i.test(input)) findings.push("balise <embed> interdite");
  if (/\son\w+\s*=/i.test(input)) findings.push("gestionnaire d'événement JS (onclick, onload…) interdit");
  if (/javascript\s*:/i.test(input)) findings.push("URL 'javascript:' interdite");
  if (/vbscript\s*:/i.test(input)) findings.push("URL 'vbscript:' interdite");
  if (/expression\s*\(/i.test(input)) findings.push("CSS expression() interdite");
  return findings;
}

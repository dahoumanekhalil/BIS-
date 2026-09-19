import {
  EMAIL_BRAND,
  EMAIL_COLORS,
  EMAIL_CONTAINER_WIDTH,
  EMAIL_FONT_STACK
} from "./tokens";

/* ------------------------------ SECURITY ------------------------------ */

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

// Only http(s) and mailto: URLs allowed. Anything else is dropped.
function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^(https?:|mailto:)/i.test(trimmed)) return null;
  return trimmed;
}

/* ------------------------------ VARIABLES ------------------------------ */

export type EmailVars = Record<string, string>;

export function resolveVars(source: string, vars: EmailVars): string {
  return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v == null || v === "" ? "" : v;
  });
}

/* ------------------------------ BLOCK MODEL ------------------------------ */

export type InfoCardRow = { label: string; value: string };
export type InfoCard = { title?: string; rows: InfoCardRow[] };
export type EmailCta = { label: string; url: string };
export type EmailContent = {
  eyebrow?: string; // e.g. "BIS 2026 · Inscription"
  heading?: string;
  paragraphs: string[]; // rich rendering with \n → <br>
  infoCard?: InfoCard;
  cta?: EmailCta;
  note?: string;
  ticketBlock?: {
    ticketCode: string;
    tier?: string;
    gate?: string;
    date?: string;
    venue?: string;
  };
};

/* ------------------------------ SIGNATURE / FOOTER ------------------------------ */

function renderSignature(): string {
  return `
    <tr>
      <td style="padding:32px 0 8px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td style="border-top:1px solid ${EMAIL_COLORS.line}; padding-top:20px; font-family:${EMAIL_FONT_STACK}; font-size:14px; line-height:1.6; color:${EMAIL_COLORS.inkSoft};">
              Bien cordialement,<br />
              <span style="font-weight:700; color:${EMAIL_COLORS.ink};">L'équipe BIS 2026</span>
            </td>
            <td align="right" style="vertical-align:top;">
              <span style="display:inline-block; padding:6px 10px; background:${EMAIL_COLORS.ink}; color:${EMAIL_COLORS.lime}; font-family:${EMAIL_FONT_STACK}; font-size:10px; font-weight:800; letter-spacing:0.24em; text-transform:uppercase; border-radius:6px;">BIS 2026</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderHeader(): string {
  return `
    <tr>
      <td style="background:${EMAIL_COLORS.ink}; padding:28px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td>
              <div style="font-family:${EMAIL_FONT_STACK}; font-size:11px; font-weight:800; letter-spacing:0.28em; text-transform:uppercase; color:rgba(248,250,249,0.72);">${esc(EMAIL_BRAND.eventName)}</div>
              <div style="margin-top:6px; font-family:${EMAIL_FONT_STACK}; font-size:26px; font-weight:900; letter-spacing:-0.02em; color:${EMAIL_COLORS.white};">
                ${esc(EMAIL_BRAND.editionLabel)}
              </div>
              <div style="height:2px; width:44px; background:${EMAIL_COLORS.lime}; margin-top:16px; border-radius:2px;"></div>
            </td>
            <td align="right" style="vertical-align:top;">
              <div style="font-family:${EMAIL_FONT_STACK}; font-size:10px; font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color:rgba(248,250,249,0.55);">
                ${esc(EMAIL_BRAND.eventDate)}
              </div>
              <div style="margin-top:4px; font-family:${EMAIL_FONT_STACK}; font-size:10px; font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color:rgba(248,250,249,0.55);">
                ${esc(EMAIL_BRAND.eventVenue)}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderFooter(): string {
  const site = safeUrl(EMAIL_BRAND.siteUrl);
  const contact = safeUrl(EMAIL_BRAND.contactUrl);
  const programme = safeUrl(EMAIL_BRAND.programmeUrl);
  const links = [
    site ? `<a href="${site}" style="color:${EMAIL_COLORS.lime}; text-decoration:none; font-weight:700;">Site</a>` : "",
    contact ? `<a href="${contact}" style="color:${EMAIL_COLORS.lime}; text-decoration:none; font-weight:700;">Contact</a>` : "",
    programme ? `<a href="${programme}" style="color:${EMAIL_COLORS.lime}; text-decoration:none; font-weight:700;">Programme</a>` : ""
  ]
    .filter(Boolean)
    .join(`&nbsp;&nbsp;<span style="color:rgba(248,250,249,0.35);">·</span>&nbsp;&nbsp;`);

  return `
    <tr>
      <td style="background:${EMAIL_COLORS.ink}; padding:28px 32px; font-family:${EMAIL_FONT_STACK};">
        <div style="font-size:12px; font-weight:800; letter-spacing:0.26em; text-transform:uppercase; color:${EMAIL_COLORS.white};">
          ${esc(EMAIL_BRAND.eventName)} 2026
        </div>
        <div style="margin-top:8px; font-size:12px; color:${EMAIL_COLORS.frostOnDark}; line-height:1.6;">
          ${esc(EMAIL_BRAND.eventDate)} · ${esc(EMAIL_BRAND.eventVenue)} · ${esc(EMAIL_BRAND.eventCity)}
        </div>
        ${links ? `<div style="margin-top:18px; font-size:12px;">${links}</div>` : ""}
        <div style="margin-top:22px; height:1px; background:rgba(248,250,249,0.12);"></div>
        <div style="margin-top:14px; font-size:11px; color:${EMAIL_COLORS.frostOnDarkMuted};">
          © 2026 ${esc(EMAIL_BRAND.legalName)}. Tous droits réservés.
        </div>
      </td>
    </tr>
  `;
}

/* ------------------------------ CONTENT BLOCKS ------------------------------ */

function renderEyebrow(text: string): string {
  return `
    <tr>
      <td style="padding:0 0 12px 0; font-family:${EMAIL_FONT_STACK}; font-size:11px; font-weight:800; letter-spacing:0.24em; text-transform:uppercase; color:${EMAIL_COLORS.cobalt};">
        ${esc(text)}
      </td>
    </tr>
  `;
}

function renderHeading(text: string): string {
  return `
    <tr>
      <td style="padding:0 0 16px 0; font-family:${EMAIL_FONT_STACK}; font-size:30px; line-height:1.15; font-weight:900; letter-spacing:-0.02em; color:${EMAIL_COLORS.ink};">
        ${esc(text)}
      </td>
    </tr>
  `;
}

function renderParagraph(text: string): string {
  // Escape then convert literal newlines within a "paragraph" into <br>.
  const html = esc(text).replace(/\n/g, "<br />");
  return `
    <tr>
      <td style="padding:0 0 16px 0; font-family:${EMAIL_FONT_STACK}; font-size:15px; line-height:1.65; color:${EMAIL_COLORS.inkSoft};">
        ${html}
      </td>
    </tr>
  `;
}

function renderInfoCard(card: InfoCard): string {
  const rows = card.rows
    .map(
      (r, i) => `
        <tr>
          <td style="padding:${i === 0 ? "0" : "14px"} 0 0 0;">
            <div style="font-family:${EMAIL_FONT_STACK}; font-size:10px; font-weight:800; letter-spacing:0.22em; text-transform:uppercase; color:${EMAIL_COLORS.inkMuted};">${esc(r.label)}</div>
            <div style="margin-top:4px; font-family:${EMAIL_FONT_STACK}; font-size:15px; font-weight:700; color:${EMAIL_COLORS.ink};">${esc(r.value)}</div>
          </td>
        </tr>
      `
    )
    .join("");

  return `
    <tr>
      <td style="padding:12px 0 24px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; background:${EMAIL_COLORS.frost}; border:1px solid ${EMAIL_COLORS.line}; border-radius:12px;">
          <tr>
            <td style="padding:20px 22px;">
              ${card.title ? `<div style="margin-bottom:14px; font-family:${EMAIL_FONT_STACK}; font-size:11px; font-weight:800; letter-spacing:0.22em; text-transform:uppercase; color:${EMAIL_COLORS.cobalt};">${esc(card.title)}</div>` : ""}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                ${rows}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderTicketBlock(t: NonNullable<EmailContent["ticketBlock"]>): string {
  return `
    <tr>
      <td style="padding:12px 0 24px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; background:${EMAIL_COLORS.ink}; border-radius:14px;">
          <tr>
            <td style="padding:26px 26px 22px 26px;">
              <div style="font-family:${EMAIL_FONT_STACK}; font-size:10px; font-weight:800; letter-spacing:0.24em; text-transform:uppercase; color:${EMAIL_COLORS.lime};">Pass digital BIS 2026</div>
              <div style="margin-top:14px; font-family:${EMAIL_FONT_STACK}; font-size:32px; font-weight:900; letter-spacing:0.12em; color:${EMAIL_COLORS.white};">
                ${esc(t.ticketCode)}
              </div>
              <div style="margin-top:6px; font-family:${EMAIL_FONT_STACK}; font-size:11px; color:rgba(248,250,249,0.5);">Présentez ce code à l'entrée</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; margin-top:22px;">
                ${["Tier", "Gate", "Date", "Venue"]
                  .map((label, i) => {
                    const val = [t.tier, t.gate, t.date, t.venue][i] ?? "—";
                    return `
                      <tr>
                        <td width="45%" style="padding:8px 0; font-family:${EMAIL_FONT_STACK}; font-size:11px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:rgba(248,250,249,0.6);">${label}</td>
                        <td style="padding:8px 0; font-family:${EMAIL_FONT_STACK}; font-size:13px; font-weight:700; color:${EMAIL_COLORS.white}; text-align:right;">${esc(val)}</td>
                      </tr>
                    `;
                  })
                  .join("")}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderCta(cta: EmailCta): string {
  const url = safeUrl(cta.url);
  if (!url) return "";
  return `
    <tr>
      <td style="padding:8px 0 8px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
          <tr>
            <td bgcolor="${EMAIL_COLORS.lime}" style="border-radius:8px; background:${EMAIL_COLORS.lime};">
              <a href="${url}" target="_blank" rel="noopener" style="display:inline-block; padding:14px 22px; font-family:${EMAIL_FONT_STACK}; font-size:14px; font-weight:800; color:${EMAIL_COLORS.ink}; text-decoration:none; border-radius:8px;">
                ${esc(cta.label)} &nbsp;→
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderNote(text: string): string {
  return `
    <tr>
      <td style="padding:16px 0 0 0; font-family:${EMAIL_FONT_STACK}; font-size:12.5px; line-height:1.6; color:${EMAIL_COLORS.inkMuted}; border-top:1px solid ${EMAIL_COLORS.line}; margin-top:16px;">
        <span style="display:inline-block; margin-right:6px; color:${EMAIL_COLORS.cobalt}; font-weight:800;">↳</span>
        ${esc(text)}
      </td>
    </tr>
  `;
}

/* ------------------------------ MAIN RENDERER ------------------------------ */

export type RenderResult = { html: string; text: string; subject: string };

export function renderEmail({
  subject,
  content,
  vars
}: {
  subject: string;
  content: EmailContent;
  vars: EmailVars;
}): RenderResult {
  // Resolve variables everywhere.
  const resolved: EmailContent = {
    eyebrow: content.eyebrow ? resolveVars(content.eyebrow, vars) : undefined,
    heading: content.heading ? resolveVars(content.heading, vars) : undefined,
    paragraphs: content.paragraphs.map((p) => resolveVars(p, vars)),
    infoCard: content.infoCard
      ? {
          title: content.infoCard.title
            ? resolveVars(content.infoCard.title, vars)
            : undefined,
          rows: content.infoCard.rows.map((r) => ({
            label: r.label,
            value: resolveVars(r.value, vars)
          }))
        }
      : undefined,
    cta: content.cta
      ? {
          label: resolveVars(content.cta.label, vars),
          url: resolveVars(content.cta.url, vars)
        }
      : undefined,
    note: content.note ? resolveVars(content.note, vars) : undefined,
    ticketBlock: content.ticketBlock
      ? {
          ticketCode: resolveVars(content.ticketBlock.ticketCode, vars),
          tier: content.ticketBlock.tier
            ? resolveVars(content.ticketBlock.tier, vars)
            : undefined,
          gate: content.ticketBlock.gate
            ? resolveVars(content.ticketBlock.gate, vars)
            : undefined,
          date: content.ticketBlock.date
            ? resolveVars(content.ticketBlock.date, vars)
            : undefined,
          venue: content.ticketBlock.venue
            ? resolveVars(content.ticketBlock.venue, vars)
            : undefined
        }
      : undefined
  };
  const resolvedSubject = resolveVars(subject, vars).trim() || "BIS 2026";

  const blocks: string[] = [];
  if (resolved.eyebrow) blocks.push(renderEyebrow(resolved.eyebrow));
  if (resolved.heading) blocks.push(renderHeading(resolved.heading));
  for (const p of resolved.paragraphs) {
    if (p.trim().length > 0) blocks.push(renderParagraph(p));
  }
  if (resolved.ticketBlock)
    blocks.push(renderTicketBlock(resolved.ticketBlock));
  if (resolved.infoCard) blocks.push(renderInfoCard(resolved.infoCard));
  if (resolved.cta) blocks.push(renderCta(resolved.cta));
  if (resolved.note) blocks.push(renderNote(resolved.note));
  blocks.push(renderSignature());

  const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${esc(resolvedSubject)}</title>
</head>
<body style="margin:0; padding:0; background:${EMAIL_COLORS.frost}; font-family:${EMAIL_FONT_STACK}; -webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_COLORS.frost};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="${EMAIL_CONTAINER_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="max-width:${EMAIL_CONTAINER_WIDTH}px; width:100%; background:${EMAIL_COLORS.white}; border-radius:14px; overflow:hidden; box-shadow:0 20px 60px -30px rgba(15,25,60,0.15);">
          ${renderHeader()}
          <tr>
            <td style="padding:36px 32px 24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                ${blocks.join("")}
              </table>
            </td>
          </tr>
          ${renderFooter()}
        </table>
        <div style="margin-top:16px; font-family:${EMAIL_FONT_STACK}; font-size:11px; color:${EMAIL_COLORS.inkMuted};">
          Vous recevez ce message car vous êtes inscrit·e à ${esc(EMAIL_BRAND.editionLabel)}.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Plain-text version for mailto: fallback and text/plain multipart.
  const textParts: string[] = [];
  if (resolved.eyebrow) textParts.push(resolved.eyebrow.toUpperCase());
  if (resolved.heading) textParts.push("", resolved.heading);
  for (const p of resolved.paragraphs) {
    if (p.trim().length > 0) textParts.push("", p);
  }
  if (resolved.ticketBlock) {
    textParts.push(
      "",
      `TICKET: ${resolved.ticketBlock.ticketCode}`,
      resolved.ticketBlock.tier ? `Tier: ${resolved.ticketBlock.tier}` : "",
      resolved.ticketBlock.gate ? `Gate: ${resolved.ticketBlock.gate}` : "",
      resolved.ticketBlock.date ? `Date: ${resolved.ticketBlock.date}` : "",
      resolved.ticketBlock.venue ? `Venue: ${resolved.ticketBlock.venue}` : ""
    );
  }
  if (resolved.infoCard) {
    textParts.push("");
    if (resolved.infoCard.title) textParts.push(resolved.infoCard.title);
    for (const r of resolved.infoCard.rows)
      textParts.push(`${r.label}: ${r.value}`);
  }
  if (resolved.cta) {
    textParts.push("", `${resolved.cta.label}: ${resolved.cta.url}`);
  }
  if (resolved.note) textParts.push("", resolved.note);
  textParts.push(
    "",
    "—",
    "Bien cordialement,",
    "L'équipe BIS 2026",
    "",
    `${EMAIL_BRAND.eventName} · ${EMAIL_BRAND.eventDate} · ${EMAIL_BRAND.eventVenue}`
  );
  const text = textParts
    .filter((s) => s !== undefined && s !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return { html, text, subject: resolvedSubject };
}

import "server-only";

import QRCode from "qrcode";

// Thin wrapper around the `qrcode` npm package. Kept in its own file so the
// dependency is imported from exactly one place — swapping renderer or
// options later touches nothing else.
//
// PNG data URL was chosen over inline SVG on purpose:
//   • `<img src="data:image/png;...">` cannot execute embedded scripts, so
//     the QR pipeline avoids `dangerouslySetInnerHTML`.
//   • PNG at 512px is more than adequate for both mobile display and A6/A7
//     print. Higher-resolution rendering can be added later without any
//     API change.
//
// Options:
//   errorCorrectionLevel "M" — 15% recovery; balances density vs. resilience
//     under real venue lighting / phone screen glare. Higher levels shrink
//     the payload capacity and enlarge the pattern.
//   margin 2 — the QR standard requires a 4-module quiet zone; browsers
//     already give us the surrounding whitespace, but 2 keeps a safety
//     buffer for print bleed.
//   color — Ink Navy on White for maximum contrast, matching the BIS
//     palette. Do NOT tint the modules — reduced contrast breaks scans.
const OPTIONS: QRCode.QRCodeToDataURLOptions = {
  errorCorrectionLevel: "M",
  margin: 2,
  width: 512,
  color: { dark: "#0A0A0A", light: "#FFFFFF" }
};

// Encodes a raw badge token as a PNG QR data URL. The token is the only
// input; nothing else (name, permissions, event id, etc.) is ever encoded.
// The caller is expected to discard the token after calling this — the
// returned data URL contains the token in visual form and is the only
// artifact that should reach the client.
export async function renderBadgeQrDataUrl(token: string): Promise<string> {
  return QRCode.toDataURL(token, OPTIONS);
}

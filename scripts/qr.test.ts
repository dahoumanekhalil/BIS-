// Focused tests for lib/badge/qr.ts. Run with:
//   npm run test:qr
//
// Verifies:
//   1. renderBadgeQrDataUrl returns a valid PNG data URL (encodes the QR
//      as binary pixels, not as a searchable string).
//   2. The raw token never appears as a plaintext substring in the data
//      URL — protects against a copy-paste leak where a captured response
//      body would otherwise reveal the credential.
//   3. Different tokens produce different data URLs (rules out any accidental
//      caching / constant output).

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateBadgeToken } from "../lib/badge/token";
import { renderBadgeQrDataUrl } from "../lib/badge/qr";

test("data URL is PNG base64", async () => {
  const dataUrl = await renderBadgeQrDataUrl(generateBadgeToken());
  assert.ok(
    dataUrl.startsWith("data:image/png;base64,"),
    `expected PNG data URL, got: ${dataUrl.slice(0, 40)}…`
  );
  // Non-trivial payload — a real QR at 512px produces at least a few KB.
  assert.ok(dataUrl.length > 1_000, "PNG payload suspiciously small");
});

test("raw token never appears as plaintext in the data URL", async () => {
  const token = generateBadgeToken();
  const dataUrl = await renderBadgeQrDataUrl(token);
  assert.equal(
    dataUrl.includes(token),
    false,
    "raw token appeared literally inside the QR data URL — the encoding leaked"
  );
});

test("different tokens produce different data URLs", async () => {
  const a = await renderBadgeQrDataUrl(generateBadgeToken());
  const b = await renderBadgeQrDataUrl(generateBadgeToken());
  assert.notEqual(a, b, "same output for different tokens — check for caching");
});

test("same token produces the same data URL (deterministic)", async () => {
  const t = generateBadgeToken();
  const a = await renderBadgeQrDataUrl(t);
  const b = await renderBadgeQrDataUrl(t);
  assert.equal(
    a,
    b,
    "non-deterministic QR render — would break print-then-scan flows"
  );
});

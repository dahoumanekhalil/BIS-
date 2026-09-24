// Pure unit tests for the `safeNext` open-redirect whitelist in
// app/auth/page.tsx. Duplicated here rather than exported from the page
// because Next's `page.tsx` files export a default component + metadata;
// carving out a shared helper module is a follow-up if the number of
// callers grows.
//
//   npm run test:safe-next

import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The function under test — kept in sync with app/auth/page.tsx.
// Any divergence must be treated as a review failure.
function safeNext(input: string | undefined): string | null {
  if (!input) return null;
  if (!input.startsWith("/")) return null;
  if (input.startsWith("//")) return null;
  const lower = input.toLowerCase();
  if (
    lower.includes("/../") ||
    lower.endsWith("/..") ||
    lower.includes("/..%2f") ||
    lower.includes("/..%5c") ||
    lower.includes("\\")
  ) {
    return null;
  }
  const allowedPrefixes = ["/register", "/compte"];
  return allowedPrefixes.some((p) => input === p || input.startsWith(`${p}/`))
    ? input
    : null;
}

describe("safeNext", () => {
  test("accepts /register", () => {
    assert.equal(safeNext("/register"), "/register");
  });
  test("accepts /register/visitor", () => {
    assert.equal(safeNext("/register/visitor"), "/register/visitor");
  });
  test("accepts /register/speaker", () => {
    assert.equal(safeNext("/register/speaker"), "/register/speaker");
  });
  test("accepts /compte", () => {
    assert.equal(safeNext("/compte"), "/compte");
  });
  test("accepts /compte/badge", () => {
    assert.equal(safeNext("/compte/badge"), "/compte/badge");
  });

  test("rejects undefined", () => {
    assert.equal(safeNext(undefined), null);
  });
  test("rejects empty string", () => {
    assert.equal(safeNext(""), null);
  });
  test("rejects an off-domain absolute URL", () => {
    assert.equal(safeNext("https://evil.example/register"), null);
  });
  test("rejects an off-domain http URL", () => {
    assert.equal(safeNext("http://evil.example/register"), null);
  });
  test("rejects a protocol-relative URL", () => {
    assert.equal(safeNext("//evil.example/register"), null);
  });
  test("rejects a path outside the whitelist", () => {
    assert.equal(safeNext("/admin"), null);
  });
  test("rejects a path outside the whitelist even if it starts with `/reg`", () => {
    assert.equal(safeNext("/registrant-hijack"), null);
  });

  test("rejects raw traversal `/register/../admin`", () => {
    assert.equal(safeNext("/register/../admin"), null);
  });
  test("rejects percent-encoded traversal `/register/..%2fadmin`", () => {
    assert.equal(safeNext("/register/..%2fadmin"), null);
  });
  test("rejects uppercase percent-encoded traversal `/register/..%2Fadmin`", () => {
    assert.equal(safeNext("/register/..%2Fadmin"), null);
  });
  test("rejects percent-encoded backslash traversal `/register/..%5cadmin`", () => {
    assert.equal(safeNext("/register/..%5cadmin"), null);
  });
  test("rejects trailing traversal `/register/..`", () => {
    assert.equal(safeNext("/register/.."), null);
  });
  test("rejects backslash traversal `/register\\..\\admin`", () => {
    assert.equal(safeNext("/register\\..\\admin"), null);
  });
  test("rejects backslash sneaked into path `/register/\\evil`", () => {
    assert.equal(safeNext("/register/\\evil"), null);
  });

  test("rejects javascript: pseudo-URL", () => {
    // Would fail the `startsWith('/')` check anyway; this documents intent.
    assert.equal(safeNext("javascript:alert(1)"), null);
  });
  test("rejects data: pseudo-URL", () => {
    assert.equal(safeNext("data:text/html,<script>alert(1)</script>"), null);
  });
});

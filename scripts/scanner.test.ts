// Phase 9 tests — scanner transport layer. Run with:
//   npm run test:scanner
//
// Two kinds of assertion:
//   A) PURE unit tests on the type→permission mapping and the slug
//      Zod schema. These prove the strict RBAC and the sanitization
//      surface without any request boundary.
//   B) STRUCTURAL tests via file-source read. These prove Phase 9
//      does NOT contain the code paths reserved for Phase 10 / 11
//      (no BadgeCredential verification, no CheckIn mutation, no
//      raw-token logging or persistence). Dynamic import of the
//      client file would pull `html5-qrcode` into the test host —
//      structural check is deliberate.
//
// Roles-and-permissions baseline is already covered by
// scripts/rbac.test.ts; this suite verifies only the parts specific
// to the scanner transport layer.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AccessPointType, AdminRole } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { requiredScannerPermission } from "../lib/admin/scanner-permission";
import { can } from "../lib/admin/rbac";

const SCANNER_DIR = new URL(
  "../app/admin/(protected)/scan/[access-point-slug]/",
  import.meta.url
);

async function readScanner(name: "page.tsx" | "scanner-client.tsx"): Promise<string> {
  return readFile(new URL(name, SCANNER_DIR), "utf8");
}

// ─── (A) Pure — type → strict permission mapping ─────────────────────────

describe("requiredScannerPermission — strict, type-derived", () => {
  test("MAIN_ENTRANCE → access.validate.main", () => {
    assert.equal(
      requiredScannerPermission(AccessPointType.MAIN_ENTRANCE),
      "access.validate.main"
    );
  });

  test("ROOM → access.validate.room", () => {
    assert.equal(
      requiredScannerPermission(AccessPointType.ROOM),
      "access.validate.room"
    );
  });

  test("returned permission is NEVER checkin.validate", () => {
    for (const t of Object.values(AccessPointType)) {
      const p = requiredScannerPermission(t);
      assert.notEqual(
        p,
        "checkin.validate",
        `type ${t} must not resolve to the legacy permission`
      );
    }
  });
});

// ─── (A) Pure — RBAC baseline for the strict scanner permissions ─────────

describe("legacy checkin.validate does NOT authorize the scanner", () => {
  test("CHECKIN_OPERATOR holds BOTH new perms + legacy (baseline)", () => {
    assert.equal(
      can(AdminRole.CHECKIN_OPERATOR, "access.validate.main"),
      true
    );
    assert.equal(
      can(AdminRole.CHECKIN_OPERATOR, "access.validate.room"),
      true
    );
    assert.equal(can(AdminRole.CHECKIN_OPERATOR, "checkin.validate"), true);
  });

  test("SUPER_ADMIN + ADMIN hold BOTH new perms (via ALL)", () => {
    for (const role of [AdminRole.SUPER_ADMIN, AdminRole.ADMIN]) {
      assert.equal(can(role, "access.validate.main"), true);
      assert.equal(can(role, "access.validate.room"), true);
    }
  });

  test("REGISTRATION_MANAGER does NOT hold scanner permissions", () => {
    assert.equal(
      can(AdminRole.REGISTRATION_MANAGER, "access.validate.main"),
      false
    );
    assert.equal(
      can(AdminRole.REGISTRATION_MANAGER, "access.validate.room"),
      false
    );
  });

  test("SALES / VIEWER / CONTENT / SPONSOR / FINANCE / ANALYTICS get NEITHER", () => {
    for (const role of [
      AdminRole.SALES,
      AdminRole.VIEWER,
      AdminRole.CONTENT_MANAGER,
      AdminRole.SPONSOR_MANAGER,
      AdminRole.FINANCE,
      AdminRole.ANALYTICS
    ]) {
      assert.equal(
        can(role, "access.validate.main"),
        false,
        `${role} unexpectedly authorized for main scanner`
      );
      assert.equal(
        can(role, "access.validate.room"),
        false,
        `${role} unexpectedly authorized for room scanner`
      );
    }
  });
});

// ─── (B) Structural — page auth chain is present and in order ────────────

describe("scanner page — auth chain is server-side and strict", () => {
  test("page opens with requireAdmin() before any DB access", async () => {
    const src = await readScanner("page.tsx");
    const requireAdminIdx = src.indexOf("await requireAdmin()");
    // Match the actual assignment `await getAccessPointBySlug(...)` not
    // the enumeration inside the header doc comment (which lists the
    // helper name in the auth-chain narrative).
    const dbMatch = src.match(/await\s+getAccessPointBySlug\(/);
    const dbIdx = dbMatch?.index ?? -1;
    assert.ok(requireAdminIdx >= 0, "requireAdmin() call missing");
    assert.ok(dbIdx >= 0, "getAccessPointBySlug() call missing");
    assert.ok(
      requireAdminIdx < dbIdx,
      "requireAdmin() must run BEFORE the DB lookup"
    );
  });

  test("page calls requirePermission with the type-derived string, not a fallback", async () => {
    const src = await readScanner("page.tsx");
    // Must import + use requiredScannerPermission from the helper.
    assert.ok(
      /import\s*{[^}]*\brequiredScannerPermission\b[^}]*}\s*from\s*["']@\/lib\/admin\/scanner-permission["']/.test(
        src
      ),
      "page must import requiredScannerPermission from the pure helper"
    );
    assert.ok(
      src.includes("requiredScannerPermission(point.type)"),
      "page must derive the permission from the resolved AccessPoint.type"
    );
    assert.ok(
      src.includes("await requirePermission(requiredPerm)"),
      "page must call requirePermission with the derived permission"
    );
  });

  test("page never references canValidateMainEntrance (the removed OR-fallback helper)", async () => {
    const src = await readScanner("page.tsx");
    assert.equal(
      src.includes("canValidateMainEntrance"),
      false,
      "the legacy OR-fallback helper must not appear in the scanner route"
    );
  });

  test("page never accepts checkin.validate as a scanner authorization", async () => {
    const src = await readScanner("page.tsx");
    assert.equal(
      src.includes('"checkin.validate"'),
      false,
      "checkin.validate is the legacy manual-flow permission and must not gate the scanner"
    );
  });

  test("page rejects unknown slug via notFound()", async () => {
    const src = await readScanner("page.tsx");
    assert.ok(src.includes("notFound()"));
  });

  test("page renders a distinct branch when active === false (no ScannerClient mount)", async () => {
    const src = await readScanner("page.tsx");
    // The disabled branch must return BEFORE the actual <ScannerClient />
    // JSX render. Use a regex that matches the real JSX (with a prop
    // following) so we do NOT match `<ScannerClient>` inside code
    // comments elsewhere in the file.
    const disabledIdx = src.indexOf("!point.active");
    const jsxMatch = src.match(/<ScannerClient\s+accessPointName/);
    const clientIdx = jsxMatch?.index ?? -1;
    assert.ok(disabledIdx >= 0, "!point.active branch missing");
    assert.ok(clientIdx >= 0, "<ScannerClient /> JSX missing");
    assert.ok(
      disabledIdx < clientIdx,
      "active check must gate the ScannerClient mount"
    );
  });
});

// ─── (B) Structural — Phase 10/11 code paths are NOT present ─────────────

describe("Phase 10 / 11 boundary is respected", () => {
  test("scanner tree does NOT verify BadgeCredentials", async () => {
    for (const f of ["page.tsx", "scanner-client.tsx"] as const) {
      const src = await readScanner(f);
      for (const banned of [
        "verifyBadgeToken",
        "hashBadgeToken",
        "generateBadgeToken",
        "rotateBadgeCredential",
        "revokeBadgeCredential",
        "issueBadgeCredential"
      ]) {
        assert.equal(
          src.includes(banned),
          false,
          `${f} unexpectedly references ${banned} — belongs to Phase 10/11`
        );
      }
    }
  });

  test("scanner tree does NOT mutate CheckIn", async () => {
    for (const f of ["page.tsx", "scanner-client.tsx"] as const) {
      const src = await readScanner(f);
      for (const banned of [
        "checkIn.create",
        "checkIn.update",
        "checkIn.upsert",
        "checkIn.delete",
        "checkInCreate"
      ]) {
        assert.equal(
          src.includes(banned),
          false,
          `${f} unexpectedly references ${banned} — CheckIn mutation belongs to Phase 10/11`
        );
      }
    }
  });

  test("scanner tree does NOT touch ParticipantAccess", async () => {
    for (const f of ["page.tsx", "scanner-client.tsx"] as const) {
      const src = await readScanner(f);
      assert.equal(
        src.includes("participantAccess"),
        false,
        `${f} unexpectedly references participantAccess — belongs to Phase 11 validator`
      );
    }
  });
});

// ─── (B) Structural — raw QR credential discipline ───────────────────────

describe("raw QR credential — never logged, persisted, or URL-embedded", () => {
  test("scanner-client.tsx does NOT console.log / warn / info / debug", async () => {
    const src = await readScanner("scanner-client.tsx");
    // Bare `console.` calls of the noisy sinks — any of these could leak
    // a credential if a future edit accidentally passes it through.
    for (const sink of [
      "console.log(",
      "console.warn(",
      "console.info(",
      "console.debug("
    ]) {
      assert.equal(
        src.includes(sink),
        false,
        `scanner-client.tsx must not call ${sink} — a stray call could leak the decoded credential`
      );
    }
  });

  test("scanner-client.tsx does NOT persist to any client storage", async () => {
    const src = await readScanner("scanner-client.tsx");
    // Look for actual API USE, not the words themselves — the header
    // comment enumerates what NOT to do and would otherwise trip this
    // test. `localStorage.setItem` etc. is the shape we care about.
    for (const store of [
      "localStorage.",
      "sessionStorage.",
      "indexedDB.",
      "document.cookie",
      "navigator.sendBeacon",
      "fetch(", // no analytics beacon; server validation happens in Phase 10/11
      "XMLHttpRequest"
    ]) {
      assert.equal(
        src.includes(store),
        false,
        `scanner-client.tsx must not use ${store} — decoded credential must stay in transient React state`
      );
    }
  });

  test("scanner-client.tsx does NOT place the decoded value in URLs or window.history", async () => {
    const src = await readScanner("scanner-client.tsx");
    for (const banned of [
      "window.location",
      "location.assign",
      "location.replace",
      "history.pushState",
      "history.replaceState",
      "URLSearchParams"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `scanner-client.tsx must not use ${banned}`
      );
    }
  });

  test("decoded credential is not rendered as visible text", async () => {
    const src = await readScanner("scanner-client.tsx");
    // The onDecode callback binds the raw string as `decoded`. It must
    // never be referenced downstream in JSX or in state that is
    // subsequently rendered. The only permitted use is the `void
    // decoded;` unused-argument suppression comment on the same line.
    // Structural: no `{decoded}` JSX expression, no setState that
    // captures `decoded` other than the state-machine transition.
    assert.equal(
      /\{[\s]*decoded[\s]*\}/.test(src),
      false,
      "raw decoded value must not appear in a JSX expression"
    );
    assert.equal(
      /setState\(\s*\{[^}]*value\s*:\s*decoded/.test(src),
      false,
      "decoded value must not be stored in a state field named `value`"
    );
  });
});

// ─── (B) Structural — camera lifecycle discipline ────────────────────────

describe("camera lifecycle — mount/unmount cleanup + no double-start", () => {
  test("scanner-client.tsx uses useEffect cleanup to stop the camera", async () => {
    const src = await readScanner("scanner-client.tsx");
    // A useEffect returning a function that calls stopScanner — the
    // idiomatic React cleanup pattern. Structural test: presence of
    // both `return () =>` and a call to `stopScanner()` inside the
    // effect body.
    assert.ok(
      /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?return\s*\(\)\s*=>\s*\{[\s\S]*?stopScanner\(\)/i.test(
        src
      ),
      "the mount useEffect must return a cleanup that calls stopScanner()"
    );
  });

  test("scanner-client.tsx guards against creating a second Html5Qrcode instance", async () => {
    const src = await readScanner("scanner-client.tsx");
    assert.ok(
      /if\s*\(\s*!\s*scannerRef\.current\s*\)/.test(src),
      "startScanner must check the ref before instantiating a new Html5Qrcode"
    );
  });

  test("scanner-client.tsx debounces / cools down accepted decodes", async () => {
    const src = await readScanner("scanner-client.tsx");
    assert.ok(
      /COOLDOWN_MS/.test(src),
      "accepted-decode cooldown constant must exist"
    );
  });
});

// ─── (B) Structural — client boundary ────────────────────────────────────

describe("client boundary is respected", () => {
  test("scanner-client.tsx carries the 'use client' directive", async () => {
    const src = await readScanner("scanner-client.tsx");
    assert.ok(
      /^\s*["']use client["'];?/m.test(src),
      "scanner-client.tsx must begin with \"use client\""
    );
  });

  test("scanner-client.tsx does NOT import server-only modules", async () => {
    const src = await readScanner("scanner-client.tsx");
    for (const banned of [
      "@/lib/db",
      "next/headers",
      "@/lib/admin/auth",
      "@/lib/account/auth",
      "server-only"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `scanner-client.tsx must not import ${banned}`
      );
    }
  });

  test("page.tsx does NOT import html5-qrcode (server component)", async () => {
    const src = await readScanner("page.tsx");
    assert.equal(
      src.includes("html5-qrcode"),
      false,
      "page.tsx is a server component — the camera library must not be imported here"
    );
  });
});

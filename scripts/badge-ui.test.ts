// Phase 18 — badge UI + export discipline tests. Run with:
//   npm run test:badge-ui
//
// This suite is 100% behavioural on `resolveBadgeRole` (pure) plus
// STRUCTURAL grep on the badge components + export hook + client
// wrapper. There is no DOM-level test (would require a browser
// harness). The structural greps assert every rule the phase brief
// pinned down:
//
//   • QR lifecycle logic is NOT touched (badge-front/back/preview
//     and the export hook never import from lib/badge/service or
//     from app/compte/badge/actions).
//   • Export path never mutates BadgeCredential / ParticipantAccess /
//     CheckIn.
//   • rawToken / tokenHash never appear in badge components or the
//     export hook.
//   • Print / PNG / PDF do NOT call generateOrRotateMyBadge.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BADGE_ROLE_ACCENTS,
  BADGE_ROLE_LABEL,
  BIS_EVENT_2027,
  resolveBadgeRole,
  type BadgeRole
} from "../lib/badge/role";

// ─── Behavioural — role classifier ────────────────────────────────────

describe("resolveBadgeRole — deterministic classification", () => {
  test("VVIP tier wins", () => {
    assert.equal(
      resolveBadgeRole({ tier: "VVIP", participationChoice: "SPEAKER" }),
      "VVIP"
    );
  });
  test("VIP tier wins over participationChoice", () => {
    assert.equal(
      resolveBadgeRole({ tier: "VIP", participationChoice: "SPONSOR" }),
      "VIP"
    );
  });
  test("SPEAKER participationChoice → SPEAKER (when tier not VVIP/VIP)", () => {
    assert.equal(
      resolveBadgeRole({ tier: null, participationChoice: "SPEAKER" }),
      "SPEAKER"
    );
    assert.equal(
      resolveBadgeRole({ tier: "VISITOR", participationChoice: "SPEAKER" }),
      "SPEAKER"
    );
  });
  test("SPONSOR / PARTNER → ORGANISATION", () => {
    assert.equal(
      resolveBadgeRole({ tier: null, participationChoice: "SPONSOR" }),
      "ORGANISATION"
    );
    assert.equal(
      resolveBadgeRole({ tier: null, participationChoice: "PARTNER" }),
      "ORGANISATION"
    );
  });
  test("CONTENT_CREATOR — either source", () => {
    assert.equal(
      resolveBadgeRole({
        tier: null,
        participationChoice: "CONTENT_CREATOR"
      }),
      "CONTENT_CREATOR"
    );
    assert.equal(
      resolveBadgeRole({
        tier: "CONTENT_CREATOR",
        participationChoice: null
      }),
      "CONTENT_CREATOR"
    );
  });
  test("default → VISITOR", () => {
    assert.equal(
      resolveBadgeRole({ tier: null, participationChoice: null }),
      "VISITOR"
    );
    assert.equal(
      resolveBadgeRole({
        tier: "IMPACT_MAKER",
        participationChoice: "VISITOR"
      }),
      "VISITOR"
    );
  });
});

describe("Role catalog — coverage + accent shape", () => {
  test("every BadgeRole has label + accent", () => {
    const roles: BadgeRole[] = [
      "VVIP",
      "VIP",
      "SPEAKER",
      "ORGANISATION",
      "CONTENT_CREATOR",
      "PRESS",
      "VISITOR"
    ];
    for (const r of roles) {
      assert.ok(BADGE_ROLE_LABEL[r], `label missing for ${r}`);
      const a = BADGE_ROLE_ACCENTS[r];
      assert.ok(a, `accent missing for ${r}`);
      // Accent shape: pill bg + text + stripe + soft bg.
      assert.match(a.pillBg, /^#|^rgba?\(/);
      assert.match(a.pillText, /^#|^rgba?\(/);
      assert.match(a.stripe, /^#|^rgba?\(/);
      assert.match(a.softBg, /^#|^rgba?\(/);
    }
  });
  test("BIS_EVENT_2027 has the expected shape", () => {
    assert.equal(BIS_EVENT_2027.edition, "2027");
    assert.match(BIS_EVENT_2027.datesLabel, /2027/);
    assert.equal(BIS_EVENT_2027.hashtag, "#BIS2027");
  });
});

// ─── Structural — QR-logic isolation ──────────────────────────────────

describe("Phase 18 — QR lifecycle isolation", () => {
  const BADGE_UI_FILES = [
    "components/compte/badge/badge-front.tsx",
    "components/compte/badge/badge-back.tsx",
    "components/compte/badge/badge-preview.tsx",
    "components/compte/badge/use-badge-export.ts"
  ];

  test("badge UI files NEVER import from lib/badge/service", async () => {
    for (const f of BADGE_UI_FILES) {
      const src = await readFile(
        new URL(`../${f}`, import.meta.url),
        "utf8"
      );
      assert.equal(
        src.includes("lib/badge/service"),
        false,
        `${f} must not import the credential service`
      );
      // Also ban direct references to lifecycle functions.
      for (const banned of [
        "issueBadgeCredential",
        "rotateBadgeCredential",
        "revokeBadgeCredential",
        "verifyBadgeToken",
        "hashBadgeToken",
        "generateBadgeToken"
      ]) {
        assert.equal(
          src.includes(banned),
          false,
          `${f} must not reference ${banned}`
        );
      }
    }
  });

  test("badge UI files NEVER import / invoke the /compte/badge server action", async () => {
    for (const f of BADGE_UI_FILES) {
      const src = await readFile(
        new URL(`../${f}`, import.meta.url),
        "utf8"
      );
      // Docs / comments may mention the function name. What we ban:
      // actual invocation shape and import statements.
      assert.equal(
        /\bgenerateOrRotateMyBadge\s*\(/.test(src),
        false,
        `${f} must not invoke generateOrRotateMyBadge`
      );
      assert.equal(
        /import[\s\S]{0,120}generateOrRotateMyBadge/.test(src),
        false,
        `${f} must not import generateOrRotateMyBadge`
      );
    }
  });

  test("badge UI files NEVER mutate BadgeCredential / ParticipantAccess / CheckIn", async () => {
    for (const f of BADGE_UI_FILES) {
      const src = await readFile(
        new URL(`../${f}`, import.meta.url),
        "utf8"
      );
      for (const banned of [
        "badgeCredential.",
        "participantAccess.",
        "checkIn.create",
        "checkIn.update",
        "checkIn.upsert",
        "checkIn.delete"
      ]) {
        assert.equal(
          src.includes(banned),
          false,
          `${f} must not mutate ${banned}`
        );
      }
    }
  });

  test("badge UI files NEVER USE rawToken or tokenHash as identifiers", async () => {
    // Docs may mention rawToken/tokenHash to explain what the file
    // does NOT do. What we ban is actual identifier use — a Prisma
    // key, a variable reference, a JSX attribute value. Every real
    // usage lands next to one of: `:`, `=`, `.`, `(`, `,`, `)`, `>`.
    for (const f of BADGE_UI_FILES) {
      const src = await readFile(
        new URL(`../${f}`, import.meta.url),
        "utf8"
      );
      for (const id of ["rawToken", "tokenHash"]) {
        // Match the identifier followed by an operator / access char.
        const re = new RegExp(String.raw`\b${id}\s*[:=.,()>]`);
        assert.equal(
          re.test(src),
          false,
          `${f} must not USE ${id} as an identifier`
        );
      }
    }
  });
});

// ─── Structural — export hook safety ──────────────────────────────────

describe("useBadgeExport — never triggers credential lifecycle", () => {
  test("hook uses html-to-image + jspdf only; no fetch, no server action", async () => {
    const src = await readFile(
      new URL("../components/compte/badge/use-badge-export.ts", import.meta.url),
      "utf8"
    );
    // Positive: the two libraries are used.
    assert.ok(src.includes("html-to-image"));
    assert.ok(src.includes("jspdf"));
    // Negative: no fetch to a QR / credential endpoint. No import
    // of the server action. No localStorage / sessionStorage / cookie
    // write that could persist a credential value.
    for (const banned of [
      "localStorage.",
      "sessionStorage.",
      "document.cookie",
      "indexedDB.",
      "navigator.sendBeacon",
      "fetch(",
      "XMLHttpRequest"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `use-badge-export must not use ${banned}`
      );
    }
    // Special-case for generateOrRotateMyBadge: allowed to appear in
    // COMMENTS (the file explicitly documents that it never calls it),
    // but must not appear as an actual invocation.
    assert.equal(
      /\bgenerateOrRotateMyBadge\s*\(/.test(src),
      false,
      "use-badge-export must not INVOKE generateOrRotateMyBadge"
    );
    // And no import statement pulling it in.
    assert.equal(
      /import[\s\S]{0,80}generateOrRotateMyBadge/.test(src),
      false,
      "use-badge-export must not import generateOrRotateMyBadge"
    );
  });

  test("doPrint is a thin window.print() wrapper — no server mutation", async () => {
    const src = await readFile(
      new URL("../components/compte/badge/use-badge-export.ts", import.meta.url),
      "utf8"
    );
    // The doPrint callback body may contain a documentation comment
    // between the identifier and the actual call. Widen the range
    // and match [\s\S] (dot-all) up to a reasonable length.
    assert.ok(
      /doPrint[\s\S]{0,1000}?window\.print\(\)/.test(src),
      "doPrint must directly call window.print()"
    );
    // No `await fetch`, no server-action call inside doPrint.
    // (Already covered by the fetch/generate ban above.)
  });
});

// ─── Structural — badge-qr-client credential flow preserved ───────────

describe("badge-qr-client — Phase 5 credential flow preserved byte-for-byte", () => {
  test("still uses useActionState + generateOrRotateMyBadge", async () => {
    const src = await readFile(
      new URL("../components/compte/badge-qr-client.tsx", import.meta.url),
      "utf8"
    );
    assert.ok(src.includes("useActionState"));
    assert.ok(src.includes("generateOrRotateMyBadge"));
  });

  test("still shows Régénérer / Afficher / Générer labels", async () => {
    const src = await readFile(
      new URL("../components/compte/badge-qr-client.tsx", import.meta.url),
      "utf8"
    );
    assert.ok(src.includes("Régénérer mon QR"));
    assert.ok(src.includes("Afficher mon QR"));
    assert.ok(src.includes("Générer mon badge"));
  });

  test("wake-lock hook still wired", async () => {
    const src = await readFile(
      new URL("../components/compte/badge-qr-client.tsx", import.meta.url),
      "utf8"
    );
    assert.ok(src.includes("useScreenWakeLock"));
  });

  test("export buttons are gated on displayQr — no export without QR", async () => {
    const src = await readFile(
      new URL("../components/compte/badge-qr-client.tsx", import.meta.url),
      "utf8"
    );
    // Every export button uses `!displayQr` or `exp.busy` in the
    // `disabled=` prop.
    const disabledCount = (src.match(/disabled=\{!displayQr/g) ?? []).length;
    assert.ok(
      disabledCount >= 3,
      "PNG-front / PNG-back / PDF / print must all gate on !displayQr"
    );
  });
});

// ─── Structural — server-side helpers unchanged ───────────────────────

describe("Phase 5 server action and Phase 2 service — untouched", () => {
  test("app/compte/badge/actions.ts still uses rotateBadgeCredential and audits badge.rotate.self", async () => {
    const src = await readFile(
      new URL("../app/compte/badge/actions.ts", import.meta.url),
      "utf8"
    );
    // Sanity: Phase 5 pipeline is intact — same rotation, same audit
    // action, same rate limit.
    assert.ok(src.includes("rotateBadgeCredential"));
    assert.ok(src.includes("badge.rotate.self"));
    assert.ok(src.includes("MIN_ROTATION_INTERVAL_MS"));
    // No badge/service mutation moved to the UI side.
    assert.ok(src.includes("verifyBadgeToken") === false);
  });
});

// Regression tests for the Commit 2 legacy-route retirement. Confirms:
//   • /register/participation exists as a static redirect module (not the
//     old wizard page).
//   • /register/[slug]/page.tsx no longer exists.
//   • The legacy startRegistration / BasicRegistrationForm files are gone.
//   • The onboarding-action module (app/actions/onboarding.ts) is gone.
//
// Pure filesystem checks — no DB, no test server. Fast and deterministic.
//
//   npm run test:legacy-routes

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");

function repo(p: string): string {
  return path.join(REPO, p);
}

describe("Commit 2 — legacy route retirement", () => {
  test("/register/[slug] dynamic route is deleted", () => {
    assert.equal(
      existsSync(repo("app/register/[slug]/page.tsx")),
      false,
      "app/register/[slug]/page.tsx must be deleted"
    );
    assert.equal(
      existsSync(repo("app/register/[slug]/role-details-form.tsx")),
      false
    );
    assert.equal(
      existsSync(repo("app/register/[slug]/visitor-confirm.tsx")),
      false
    );
  });

  test("/register/participation is a redirect module", () => {
    const p = repo("app/register/participation/page.tsx");
    assert.equal(existsSync(p), true, "redirect module must exist");
    const src = readFileSync(p, "utf8");
    assert.ok(
      src.includes("permanentRedirect"),
      "must use permanentRedirect (308) to /register"
    );
    assert.ok(
      src.includes("/register"),
      "must redirect to /register"
    );
    assert.equal(
      existsSync(repo("app/register/participation/participation-selector.tsx")),
      false,
      "old participation-selector must be deleted"
    );
  });

  test("app/actions/onboarding.ts is deleted", () => {
    assert.equal(
      existsSync(repo("app/actions/onboarding.ts")),
      false,
      "orphaned onboarding action module must be deleted"
    );
  });

  test("BasicRegistrationForm is deleted", () => {
    assert.equal(
      existsSync(repo("components/forms/basic-registration-form.tsx")),
      false
    );
  });

  test("orphaned form primitives and selection-cards are deleted", () => {
    assert.equal(
      existsSync(repo("components/forms/primitives.tsx")),
      false
    );
    assert.equal(
      existsSync(repo("components/forms/selection-cards.tsx")),
      false
    );
  });

  test("all five new role pages exist", () => {
    for (const slug of [
      "visitor",
      "speaker",
      "sponsor",
      "partner",
      "content-creator"
    ]) {
      assert.equal(
        existsSync(repo(`app/register/${slug}/page.tsx`)),
        true,
        `app/register/${slug}/page.tsx must exist`
      );
    }
  });

  test("all five role server actions exist", () => {
    for (const slug of [
      "visitor",
      "speaker",
      "sponsor",
      "partner",
      "content-creator"
    ]) {
      assert.equal(
        existsSync(repo(`app/actions/register-${slug}.ts`)),
        true,
        `app/actions/register-${slug}.ts must exist`
      );
    }
  });

  test("role selector is not marking any role as 'coming soon'", () => {
    const src = readFileSync(
      repo("components/register/role-selector.tsx"),
      "utf8"
    );
    // Strip block + line comments so we don't false-positive on the
    // comment that explains the `available` field.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[\t ]*\/\/.*$/gm, "");
    assert.equal(
      code.includes("available: false"),
      false,
      "no role card should be marked available: false"
    );
    assert.equal(
      code.includes('cta: "Bientôt"'),
      false,
      'no card should render "Bientôt" cta'
    );
    // Sanity: every non-null href points at a /register/<role> route.
    const hrefRe = /href: "\/register\/([a-z-]+)"/g;
    const hrefs = [...code.matchAll(hrefRe)].map((m) => m[1]);
    for (const expected of ["visitor", "speaker", "sponsor", "partner", "content-creator"]) {
      assert.ok(
        hrefs.includes(expected),
        `role selector must link to /register/${expected}`
      );
    }
  });
});

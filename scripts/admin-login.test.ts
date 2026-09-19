// Phase 13 WARN 1 — admin-login regression tests. Run with:
//   npm run test:admin-login
//
// Two kinds of assertion:
//
//   A) BEHAVIOURAL — call `verifyAdminLogin` directly with a real DB
//      fixture. Assert the outcome shape for every failure branch,
//      the success shape for a valid credential, and the throttled
//      shape after burning through the per-email bucket.
//
//   B) STRUCTURAL — read the source of the hardened files and prove
//      the security-critical invariants hold at the code level:
//        • all failure branches call verifyPassword against DUMMY_HASH
//        • no branch-specific user-visible message
//        • rate-limit gate runs BEFORE the DB lookup
//        • no session creation on failure
//        • uniform generic error string
//
// Structural tests exist because timing-based enumeration is not
// easy to assert with wall-clock measurements — a hostile edit that
// SKIPS verifyPassword on one branch is what we need to prevent, and
// grepping the source proves that discipline.
//
// The behavioural tests use UNIQUE per-test email keys (with a random
// suffix) so the module-scoped attempts map does not carry state
// across tests. Ordering-independent.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { AdminRole, AdminStatus, PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import { verifyAdminLogin } from "../lib/admin/login-service";

const prisma = new PrismaClient();

const ACTIVE_EMAIL_PREFIX = "admin-login-active-";
const INACTIVE_EMAIL_PREFIX = "admin-login-inactive-";
const KNOWN_PASSWORD = "correct-horse-battery-staple";

let activeAdminId: string;
let activeEmail: string;
let inactiveEmail: string;

// Small helper: burn N failed attempts so the email bucket reaches
// (or crosses) the per-email limit. Bucket is process-scoped so this
// only affects the current test's email key.
async function burnEmail(email: string, n: number) {
  for (let i = 0; i < n; i++) {
    await verifyAdminLogin({
      email,
      password: "definitely-wrong-password",
      ip: null
    });
  }
}

before(async () => {
  const suffix = randomBytes(4).toString("hex");
  activeEmail = `${ACTIVE_EMAIL_PREFIX}${suffix}@bis.dz`;
  inactiveEmail = `${INACTIVE_EMAIL_PREFIX}${suffix}@bis.dz`;

  const active = await prisma.adminUser.create({
    data: {
      email: activeEmail,
      name: "Admin Login Test — Active",
      passwordHash: hashPassword(KNOWN_PASSWORD),
      role: AdminRole.VIEWER,
      status: AdminStatus.ACTIVE
    }
  });
  activeAdminId = active.id;

  await prisma.adminUser.create({
    data: {
      email: inactiveEmail,
      name: "Admin Login Test — Inactive",
      passwordHash: hashPassword(KNOWN_PASSWORD),
      role: AdminRole.VIEWER,
      status: AdminStatus.DISABLED
    }
  });
});

after(async () => {
  await prisma.adminSession
    .deleteMany({ where: { userId: activeAdminId } })
    .catch(() => undefined);
  await prisma.adminUser
    .deleteMany({
      where: {
        OR: [
          { email: activeEmail },
          { email: inactiveEmail }
        ]
      }
    })
    .catch(() => undefined);
  await prisma.$disconnect();
});

// ─── BEHAVIOURAL ────────────────────────────────────────────────────────

describe("verifyAdminLogin — uniform failure across branches", () => {
  test("nonexistent admin → INVALID_CREDENTIALS", async () => {
    const suffix = randomBytes(4).toString("hex");
    const r = await verifyAdminLogin({
      email: `does-not-exist-${suffix}@bis.dz`,
      password: "anything",
      ip: null
    });
    assert.deepEqual(r, { ok: false, kind: "INVALID_CREDENTIALS" });
  });

  test("existing ACTIVE admin + wrong password → INVALID_CREDENTIALS", async () => {
    const r = await verifyAdminLogin({
      email: activeEmail,
      password: "wrong-password",
      ip: null
    });
    assert.deepEqual(r, { ok: false, kind: "INVALID_CREDENTIALS" });
  });

  test("existing DISABLED admin + correct password → INVALID_CREDENTIALS", async () => {
    // Even the correct password against a disabled admin returns the
    // same uniform outcome. The kind is INVALID_CREDENTIALS, not a
    // distinct "ACCOUNT_DISABLED" — no enumeration.
    const r = await verifyAdminLogin({
      email: inactiveEmail,
      password: KNOWN_PASSWORD,
      ip: null
    });
    assert.deepEqual(r, { ok: false, kind: "INVALID_CREDENTIALS" });
  });

  test("empty email → INVALID_INPUT (client-visible: same as INVALID_CREDENTIALS)", async () => {
    const r = await verifyAdminLogin({
      email: "",
      password: "anything",
      ip: null
    });
    assert.deepEqual(r, { ok: false, kind: "INVALID_INPUT" });
  });

  test("empty password → INVALID_INPUT", async () => {
    const r = await verifyAdminLogin({
      email: activeEmail,
      password: "",
      ip: null
    });
    assert.deepEqual(r, { ok: false, kind: "INVALID_INPUT" });
  });
});

// ─── BEHAVIOURAL — rate limit ──────────────────────────────────────────

describe("verifyAdminLogin — per-email rate limit", () => {
  test("8 failed attempts allowed, 9th throttled", async () => {
    // Use a distinct email so the bucket starts empty. Nonexistent
    // user path is fine — we only care about the counter.
    const suffix = randomBytes(4).toString("hex");
    const email = `rate-limit-${suffix}@bis.dz`;

    // 8 attempts should all return INVALID_CREDENTIALS (count reaches 8).
    for (let i = 0; i < 8; i++) {
      const r = await verifyAdminLogin({
        email,
        password: "wrong",
        ip: null
      });
      assert.equal(r.ok, false);
      // Not THROTTLED yet on attempts 1..8.
      if (r.ok === false) {
        assert.equal(
          r.kind,
          "INVALID_CREDENTIALS",
          `attempt ${i + 1} unexpectedly throttled early`
        );
      }
    }

    // 9th attempt: count is now 8, isBlocked returns true, THROTTLED.
    const nth = await verifyAdminLogin({
      email,
      password: "wrong",
      ip: null
    });
    assert.deepEqual(nth, { ok: false, kind: "THROTTLED" });
  });

  test("THROTTLED does not disclose account existence", async () => {
    // Two distinct emails: one exists (ACTIVE), one does not.
    // After burning both to the throttle threshold, both return
    // THROTTLED with the same shape — no way to distinguish.
    const suffix = randomBytes(4).toString("hex");
    const nonexistent = `throttle-nx-${suffix}@bis.dz`;
    // Use a NEW nonexistent email specifically for the "existing"
    // side too, so the ACTIVE admin's bucket is not polluted with
    // failed attempts.
    const existingEmail = activeEmail;

    await burnEmail(nonexistent, 8);
    await burnEmail(existingEmail, 8);

    const rNx = await verifyAdminLogin({
      email: nonexistent,
      password: "anything",
      ip: null
    });
    const rEx = await verifyAdminLogin({
      email: existingEmail,
      password: "anything",
      ip: null
    });
    assert.deepEqual(rNx, { ok: false, kind: "THROTTLED" });
    assert.deepEqual(rEx, { ok: false, kind: "THROTTLED" });
  });

  test("throttled attempt does NOT record a session-worthy outcome", async () => {
    // Not asserting session table state here (the service does not
    // touch AdminSession — session creation lives in the action
    // wrapper). Instead, assert the outcome shape is a failure kind
    // that the wrapper would never treat as ok. Regressed if a
    // future edit accidentally returned ok:true from a throttled
    // branch.
    const suffix = randomBytes(4).toString("hex");
    const email = `no-session-${suffix}@bis.dz`;
    await burnEmail(email, 8);
    const r = await verifyAdminLogin({
      email,
      password: KNOWN_PASSWORD,
      ip: null
    });
    // Even the CORRECT password (against a nonexistent user, but
    // still — the wrapper never sees the difference) does not
    // resurrect a throttled bucket. The reset-on-success only fires
    // for ok:true, which requires passing the isBlocked gate first.
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.kind, "THROTTLED");
    }
  });
});

// ─── BEHAVIOURAL — success ─────────────────────────────────────────────

describe("verifyAdminLogin — success path", () => {
  test("ACTIVE admin + correct password → ok:true with userId", async () => {
    // Use a fresh email bucket by choosing a NEW email fixture would
    // be ideal — but we already created ONE active admin. To avoid
    // cross-test bucket pollution, this test runs against a fresh
    // ACTIVE admin created just for it.
    const suffix = randomBytes(4).toString("hex");
    const email = `admin-login-success-${suffix}@bis.dz`;
    const password = "another-strong-password";
    const created = await prisma.adminUser.create({
      data: {
        email,
        name: "Success Test",
        passwordHash: hashPassword(password),
        role: AdminRole.VIEWER,
        status: AdminStatus.ACTIVE
      }
    });
    try {
      const r = await verifyAdminLogin({
        email,
        password,
        ip: null
      });
      assert.equal(r.ok, true);
      if (r.ok === true) {
        assert.equal(r.userId, created.id);
      }
    } finally {
      await prisma.adminUser
        .delete({ where: { id: created.id } })
        .catch(() => undefined);
    }
  });

  test("success resets the per-email failure bucket", async () => {
    // 1. Burn 7 failures (still below threshold — 8 attempts allowed).
    // 2. Successful login — service must call reset(emailKey).
    // 3. 8 more failed attempts should NOT trip the throttle (bucket
    //    was reset; count restarts from 0).
    const suffix = randomBytes(4).toString("hex");
    const email = `admin-reset-${suffix}@bis.dz`;
    const password = "reset-me-please";
    const created = await prisma.adminUser.create({
      data: {
        email,
        name: "Reset Test",
        passwordHash: hashPassword(password),
        role: AdminRole.VIEWER,
        status: AdminStatus.ACTIVE
      }
    });
    try {
      await burnEmail(email, 7);
      // 8th call is a SUCCESS — this must reset the bucket.
      const good = await verifyAdminLogin({ email, password, ip: null });
      assert.equal(good.ok, true);
      // Now burn 8 more failures — should end with the 9th throttling.
      for (let i = 0; i < 8; i++) {
        const r = await verifyAdminLogin({
          email,
          password: "wrong-again",
          ip: null
        });
        assert.equal(r.ok, false);
      }
      const nth = await verifyAdminLogin({
        email,
        password: "wrong-again",
        ip: null
      });
      assert.deepEqual(
        nth,
        { ok: false, kind: "THROTTLED" },
        "post-reset bucket must trip after another full window"
      );
    } finally {
      await prisma.adminUser
        .delete({ where: { id: created.id } })
        .catch(() => undefined);
    }
  });
});

// ─── BEHAVIOURAL — data safety ─────────────────────────────────────────

describe("verifyAdminLogin — outcome data safety", () => {
  test("outcome NEVER contains password, hash, or token", async () => {
    // Correct password to hit the success path — ensures we sample
    // the fullest possible response shape.
    const suffix = randomBytes(4).toString("hex");
    const email = `data-safety-${suffix}@bis.dz`;
    const password = "some-secret-password";
    const created = await prisma.adminUser.create({
      data: {
        email,
        name: "Data Safety Test",
        passwordHash: hashPassword(password),
        role: AdminRole.VIEWER,
        status: AdminStatus.ACTIVE
      }
    });
    try {
      const r = await verifyAdminLogin({ email, password, ip: null });
      const serialised = JSON.stringify(r);
      assert.equal(
        serialised.includes(password),
        false,
        "outcome must not contain the raw password"
      );
      // No password hashes or session tokens should leak either.
      assert.equal(serialised.includes("scrypt$"), false);
      // The success outcome carries only userId — no email, no role.
      // Assert the shape explicitly.
      assert.equal(r.ok, true);
      if (r.ok === true) {
        assert.deepEqual(Object.keys(r).sort(), ["ok", "userId"]);
      }
    } finally {
      await prisma.adminUser
        .delete({ where: { id: created.id } })
        .catch(() => undefined);
    }
  });
});

// ─── STRUCTURAL — code discipline ──────────────────────────────────────

describe("admin-login code discipline (structural)", () => {
  const servicePath = new URL(
    "../lib/admin/login-service.ts",
    import.meta.url
  );
  const actionPath = new URL(
    "../app/admin/login/actions.ts",
    import.meta.url
  );

  test("service imports DUMMY_HASH from the shared rate-limit module", async () => {
    const src = await readFile(servicePath, "utf8");
    assert.ok(
      /from\s+["']@\/lib\/rate-limit["']/.test(src),
      "service must import from lib/rate-limit"
    );
    assert.ok(src.includes("DUMMY_HASH"));
  });

  test("both no-user and inactive-user branches call verifyPassword(_, DUMMY_HASH)", async () => {
    const src = await readFile(servicePath, "utf8");
    // Two distinct occurrences of `verifyPassword(password, DUMMY_HASH)`
    // — one for the !user branch, one for the !== ACTIVE branch. If a
    // future edit removes either, this test fails.
    // Trailing `;` narrows the match to actual code lines and
    // excludes matches inside doc comments that reference the same
    // expression.
    const matches = src.match(
      /verifyPassword\(\s*password\s*,\s*DUMMY_HASH\s*\)\s*;/g
    );
    assert.ok(matches, "verifyPassword(password, DUMMY_HASH); must appear");
    assert.equal(
      matches.length,
      2,
      "expected DUMMY_HASH verify to run on BOTH missing-user AND inactive-user branches"
    );
  });

  test("rate-limit gate runs BEFORE the DB findUnique", async () => {
    const src = await readFile(servicePath, "utf8");
    const isBlockedIdx = src.indexOf("isBlocked(");
    const findUniqueIdx = src.indexOf("prisma.adminUser.findUnique");
    assert.ok(isBlockedIdx >= 0);
    assert.ok(findUniqueIdx >= 0);
    assert.ok(
      isBlockedIdx < findUniqueIdx,
      "rate-limit isBlocked must run before Postgres lookup"
    );
  });

  test("service never creates a session or sets a cookie", async () => {
    const src = await readFile(servicePath, "utf8");
    // Session/cookie management belongs to the caller — the pure
    // service function must never touch them.
    for (const banned of [
      "createSession",
      "setSessionCookie",
      "cookies(",
      "adminSession.create",
      "adminSession.update"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `service must not call ${banned}`
      );
    }
  });

  test("action wrapper collapses INVALID_INPUT and INVALID_CREDENTIALS to one message", async () => {
    const src = await readFile(actionPath, "utf8");
    // The GENERIC_ERROR constant is used for both branches. A future
    // edit that split it into two messages would introduce
    // enumeration.
    assert.ok(
      /const\s+GENERIC_ERROR/.test(src),
      "GENERIC_ERROR constant missing — a per-branch inline literal would be a regression"
    );
    // The wrapper must not surface distinct messages for each failure
    // kind.
    assert.equal(
      /kind === "INVALID_INPUT"[\s\S]{0,200}?message:\s*"[^"]*(?:vide|empty|input|missing)/i.test(
        src
      ),
      false,
      "no distinct 'empty input' message allowed"
    );
  });

  test("action wrapper does not create a session on failure", async () => {
    const src = await readFile(actionPath, "utf8");
    // createSession must appear only inside the success branch — i.e.,
    // after the `outcome.ok === false` return. Verify by ordering.
    const failReturnIdx = src.indexOf("return GENERIC_ERROR");
    const createSessionIdx = src.indexOf("createSession(");
    assert.ok(failReturnIdx >= 0);
    assert.ok(createSessionIdx >= 0);
    assert.ok(
      failReturnIdx < createSessionIdx,
      "createSession must live AFTER the failure return"
    );
  });

  test("action wrapper resolves clientIp via the shared helper", async () => {
    const src = await readFile(actionPath, "utf8");
    // A hand-rolled header read would risk drifting from the attendee
    // pattern (trust boundary for x-real-ip vs x-forwarded-for). Use
    // the shared helper.
    assert.ok(src.includes("await clientIp()"));
    assert.equal(
      src.includes("headers()"),
      false,
      "action must not read headers directly — use the shared clientIp() helper"
    );
  });

  test("no legacy 'Ce compte est désactivé' user-visible message remains", async () => {
    const src = await readFile(actionPath, "utf8");
    // The pre-hardening code returned this distinct message on the
    // DISABLED path — an enumeration side-channel. It must not come
    // back.
    assert.equal(
      src.includes("Ce compte est désactivé"),
      false,
      "distinct DISABLED-account message must not reappear"
    );
  });
});

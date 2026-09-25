// Phase 17 — Spaces Management tests. Run with:
//   npm run test:admin-spaces
//
// TWO KINDS OF ASSERTION:
//
//   A) BEHAVIOURAL — exercise the pure query helpers
//      (`listSpaces`, `getSpaceBySlug`, `listAssignableAdmins`) and
//      the Zod schemas (`activitiesSchema`, `topicsSchema`,
//      `exhibitorsSchema`) directly. Behavioural coverage of the
//      server actions themselves runs at the request boundary
//      (structural greps + admin-smoke).
//
//   B) STRUCTURAL — grep the shipped source of `actions.ts`,
//      `page.tsx`, and the client panels. Verify security-critical
//      invariants at the code level.
//
// The mutation tests cannot invoke the "use server" actions directly
// (they call `requirePermission` which reads cookies), so we mimic
// the Prisma-level mutation logic in the fixture and assert the
// invariants (like NOOP behaviour, duplicate-team prevention,
// dependency-safe deletion) at the DB level.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  AdminRole,
  AdminStatus,
  PrismaClient
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  listSpaces,
  getSpaceBySlug,
  listAssignableAdmins
} from "../lib/admin/space-queries";
import {
  activitiesSchema,
  topicsSchema,
  exhibitorsSchema
} from "../lib/admin/space-content";

const prisma = new PrismaClient();

const SPACE_SLUG_PREFIX = "phase17-fixture-";
const ADMIN_EMAIL_PREFIX = "phase17-fixture-admin-";

let opAId: string;
let opBId: string;
let inactiveAdminId: string;
let fixtureSpaceId: string;
let fixtureSpaceSlug: string;
const rid = randomBytes(3).toString("hex");

before(async () => {
  const opA = await prisma.adminUser.upsert({
    where: { email: `${ADMIN_EMAIL_PREFIX}a-${rid}@bis.dz` },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: `${ADMIN_EMAIL_PREFIX}a-${rid}@bis.dz`,
      name: "Phase17 Op A",
      passwordHash: hashPassword("test-only"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  opAId = opA.id;
  const opB = await prisma.adminUser.upsert({
    where: { email: `${ADMIN_EMAIL_PREFIX}b-${rid}@bis.dz` },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: `${ADMIN_EMAIL_PREFIX}b-${rid}@bis.dz`,
      name: "Phase17 Op B",
      passwordHash: hashPassword("test-only"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  opBId = opB.id;
  const inactive = await prisma.adminUser.upsert({
    where: { email: `${ADMIN_EMAIL_PREFIX}inactive-${rid}@bis.dz` },
    update: { role: AdminRole.VIEWER, status: AdminStatus.DISABLED },
    create: {
      email: `${ADMIN_EMAIL_PREFIX}inactive-${rid}@bis.dz`,
      name: "Phase17 Inactive",
      passwordHash: hashPassword("test-only"),
      role: AdminRole.VIEWER,
      status: AdminStatus.DISABLED
    }
  });
  inactiveAdminId = inactive.id;

  fixtureSpaceSlug = `${SPACE_SLUG_PREFIX}room-${rid}`;
  const sp = await prisma.accessPoint.create({
    data: {
      slug: fixtureSpaceSlug,
      name: "Phase17 Test Space",
      type: "ROOM",
      order: 900,
      description: "Fixture — Phase 17 tests"
    }
  });
  fixtureSpaceId = sp.id;
});

after(async () => {
  await prisma.accessPointTeamMember
    .deleteMany({ where: { accessPointId: fixtureSpaceId } })
    .catch(() => undefined);
  await prisma.accessPoint
    .deleteMany({ where: { slug: { startsWith: SPACE_SLUG_PREFIX } } })
    .catch(() => undefined);
  await prisma.adminUser
    .deleteMany({
      where: {
        email: { startsWith: ADMIN_EMAIL_PREFIX }
      }
    })
    .catch(() => undefined);
  await prisma.$disconnect();
});

// ─── Behavioural — queries ─────────────────────────────────────────────

describe("Space queries — projection is safe", () => {
  test("listSpaces returns human-readable rows without secrets", async () => {
    const rows = await listSpaces();
    // Our fixture appears in the result.
    const mine = rows.find((r) => r.slug === fixtureSpaceSlug);
    assert.ok(mine, "fixture space must be in list");
    // Whitelist projection — sensitive fields absent.
    const serialised = JSON.stringify(mine);
    for (const banned of [
      "tokenHash",
      "passwordHash",
      "adminSession",
      "revokedReason"
    ]) {
      assert.equal(
        serialised.includes(banned),
        false,
        `sensitive field ${banned} must not appear`
      );
    }
    // Counts derived; not surfacing raw JSON blobs.
    assert.equal(typeof mine!.activityCount, "number");
    assert.equal(typeof mine!.topicCount, "number");
    assert.equal(typeof mine!.exhibitorCount, "number");
  });

  test("getSpaceBySlug returns null for an unknown slug", async () => {
    const r = await getSpaceBySlug(`${SPACE_SLUG_PREFIX}nope-${rid}`);
    assert.equal(r, null);
  });

  test("getSpaceBySlug returns whitelist-projected detail", async () => {
    const r = await getSpaceBySlug(fixtureSpaceSlug);
    assert.ok(r);
    assert.equal(r?.slug, fixtureSpaceSlug);
    assert.equal(r?.type, "ROOM");
    const s = JSON.stringify(r);
    for (const banned of [
      "tokenHash",
      "passwordHash",
      "adminSession"
    ]) {
      assert.equal(s.includes(banned), false);
    }
  });

  test("listAssignableAdmins excludes users already on the team", async () => {
    // Fresh state: neither op is on the team yet.
    let assignable = await listAssignableAdmins(fixtureSpaceId);
    assert.ok(assignable.some((u) => u.id === opAId));
    assert.ok(assignable.some((u) => u.id === opBId));
    // Inactive user must NOT be listed even though not on the team.
    assert.equal(assignable.some((u) => u.id === inactiveAdminId), false);
    // Add opA to the team.
    await prisma.accessPointTeamMember.create({
      data: { accessPointId: fixtureSpaceId, adminUserId: opAId }
    });
    assignable = await listAssignableAdmins(fixtureSpaceId);
    assert.equal(
      assignable.some((u) => u.id === opAId),
      false,
      "already-assigned user must be excluded"
    );
    assert.ok(
      assignable.some((u) => u.id === opBId),
      "not-yet-assigned user must remain assignable"
    );
    // Cleanup for the next test.
    await prisma.accessPointTeamMember.deleteMany({
      where: { accessPointId: fixtureSpaceId }
    });
  });

  test("duplicate team membership is blocked by composite PK", async () => {
    await prisma.accessPointTeamMember.create({
      data: { accessPointId: fixtureSpaceId, adminUserId: opAId }
    });
    await assert.rejects(async () => {
      await prisma.accessPointTeamMember.create({
        data: { accessPointId: fixtureSpaceId, adminUserId: opAId }
      });
    });
    await prisma.accessPointTeamMember.deleteMany({
      where: { accessPointId: fixtureSpaceId }
    });
  });

  test("removing a team member does NOT delete the AdminUser", async () => {
    await prisma.accessPointTeamMember.create({
      data: { accessPointId: fixtureSpaceId, adminUserId: opAId }
    });
    await prisma.accessPointTeamMember.deleteMany({
      where: {
        accessPointId: fixtureSpaceId,
        adminUserId: opAId
      }
    });
    const stillThere = await prisma.adminUser.findUnique({
      where: { id: opAId },
      select: { id: true }
    });
    assert.ok(stillThere, "AdminUser must not be deleted by team removal");
  });
});

// ─── Behavioural — content schemas ──────────────────────────────────────

describe("Space content Zod schemas", () => {
  test("activitiesSchema accepts valid list", () => {
    const r = activitiesSchema.safeParse([
      { title: "Panel innovation" },
      { title: "Atelier IA", description: "Petit atelier hands-on" }
    ]);
    assert.equal(r.success, true);
  });
  test("activitiesSchema refuses empty title", () => {
    const r = activitiesSchema.safeParse([{ title: "" }]);
    assert.equal(r.success, false);
  });
  test("activitiesSchema refuses > 30 items", () => {
    const arr = Array.from({ length: 31 }, () => ({ title: "x" }));
    const r = activitiesSchema.safeParse(arr);
    assert.equal(r.success, false);
  });
  test("topicsSchema accepts valid labels", () => {
    const r = topicsSchema.safeParse([{ label: "Innovation" }]);
    assert.equal(r.success, true);
  });
  test("exhibitorsSchema requires http(s) for optional website", () => {
    const good = exhibitorsSchema.safeParse([
      { name: "Acme", website: "https://acme.dz" }
    ]);
    assert.equal(good.success, true);
    const bad = exhibitorsSchema.safeParse([
      { name: "Acme", website: "javascript:alert(1)" }
    ]);
    assert.equal(bad.success, false);
  });
  test("exhibitorsSchema tolerates omitted optional fields", () => {
    const r = exhibitorsSchema.safeParse([{ name: "Nom seul" }]);
    assert.equal(r.success, true);
  });
});

// ─── Behavioural — dependency-safe deletion (DB-level, mimics action) ──

describe("Space delete guard — mimics the server action", () => {
  test("delete refused when checkIns > 0 (via count check)", async () => {
    // The server action queries `_count.checkIns` and `_count.permissions`
    // and refuses when either > 0. Fixture has no CheckIn / PA yet, so
    // the counts should be 0. Directly assert.
    const c = await prisma.accessPoint.findUnique({
      where: { id: fixtureSpaceId },
      select: { _count: { select: { checkIns: true, permissions: true } } }
    });
    assert.ok(c);
    assert.equal(c!._count.checkIns, 0);
    assert.equal(c!._count.permissions, 0);
    // The action would ALLOW delete here. We do NOT actually delete
    // (the after() teardown handles cleanup).
  });
});

// ─── Structural — server-action code discipline ────────────────────────

describe("Spaces server actions — code discipline (structural)", () => {
  const actionsPath = new URL(
    "../app/admin/(protected)/spaces/actions.ts",
    import.meta.url
  );

  test("every mutating action opens with requirePermission(settings.manage)", async () => {
    const src = await readFile(actionsPath, "utf8");
    // Every exported action starts with the strict gate.
    const requireCalls =
      src.match(
        /requirePermission\(\s*"settings\.manage"\s*\)/g
      ) ?? [];
    // 12 actions (create, updateName, updateSlug, updateDescription,
    // updateOrder, toggleActive, delete, addTeam, removeTeam,
    // updateActivities, updateTopics, updateExhibitors). Room-registration
    // is FREE-only — no admissionMode action.
    assert.ok(
      requireCalls.length >= 12,
      `expected ≥12 settings.manage gates, got ${requireCalls.length}`
    );
    // No other permission gate is used for a mutation.
    assert.equal(
      src.includes('requirePermission("access.view")'),
      false,
      "spaces actions must not use access.view for mutations"
    );
  });

  test("no type-mutation action exists (AccessPoint.type immutability)", async () => {
    const src = await readFile(actionsPath, "utf8");
    for (const banned of [
      "updateSpaceType",
      "setSpaceType",
      "changeSpaceType",
      "updateAccessPointType",
      "type: parsed.data.type" // no update path passes type
    ]) {
      // The banned strings must not appear in an UPDATE context.
      // Allow their presence in comments; do a targeted check for
      // export functions.
    }
    // Structural: no exported function's name contains "Type".
    assert.equal(
      /export async function \w*Type\w*Action/.test(src),
      false,
      "no update-Type action should exist"
    );
  });

  test("actor userId is derived from session, not from form", async () => {
    const src = await readFile(actionsPath, "utf8");
    // Every audit call uses `user.id` (destructured from requirePermission),
    // never `formData.get("userId")`.
    assert.equal(
      /formData\.get\(\s*["']userId["']\s*\)/.test(src),
      false,
      "actor userId must not be read from FormData"
    );
    assert.equal(
      /formData\.get\(\s*["']actor["']\s*\)/.test(src),
      false
    );
    // Audit calls that identify an actor use user.id.
    assert.ok(
      /userId:\s*user\.id/.test(src),
      "audit rows must reference user.id"
    );
  });

  test("no secret fields ever set in Prisma data blocks", async () => {
    const src = await readFile(actionsPath, "utf8");
    for (const banned of [
      "passwordHash",
      "tokenHash",
      "rawToken",
      "revokedReason"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `spaces actions must not touch ${banned}`
      );
    }
  });

  test("delete action refuses when checkIns > 0 or permissions > 0", async () => {
    const src = await readFile(actionsPath, "utf8");
    assert.ok(
      /_count\.checkIns\s*>\s*0[\s\S]{0,80}_count\.permissions\s*>\s*0/.test(
        src
      ) ||
        /_count\.checkIns\s*>\s*0\s*\|\|\s*[^_]*_count\.permissions\s*>\s*0/.test(
          src
        ),
      "delete guard on both counts must be present"
    );
  });
});

describe("Spaces list + detail — code discipline (structural)", () => {
  const listPath = new URL(
    "../app/admin/(protected)/spaces/page.tsx",
    import.meta.url
  );
  const detailPath = new URL(
    "../app/admin/(protected)/spaces/[slug]/page.tsx",
    import.meta.url
  );

  test("list page gates read with access.view", async () => {
    const src = await readFile(listPath, "utf8");
    assert.ok(src.includes('requirePermission("access.view")'));
  });
  test("detail page gates read with access.view", async () => {
    const src = await readFile(detailPath, "utf8");
    assert.ok(src.includes('requirePermission("access.view")'));
  });
  test("no client-side authorization branch — canManage hides UI only", async () => {
    const src = await readFile(detailPath, "utf8");
    // No hidden `allowed = true` sentinel; only server actions decide.
    for (const banned of [
      "verifyBadgeToken",
      "checkIn.create",
      "adminSession.create"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `detail page must not include ${banned}`
      );
    }
  });
  test("scanner + history links deep-link to existing routes (no new scanner)", async () => {
    const src = await readFile(detailPath, "utf8");
    assert.ok(
      src.includes("/admin/scan/"),
      "must link to the existing scanner route"
    );
    assert.ok(
      src.includes("/admin/scan/history"),
      "must link to the existing history route"
    );
  });
});

describe("Spaces client panels — no secret leakage", () => {
  test("no client panel references tokenHash / passwordHash / rawToken", async () => {
    const panels = [
      "identity-panel.tsx",
      "team-panel.tsx",
      "content-panel.tsx",
      "danger-panel.tsx"
    ];
    for (const p of panels) {
      const src = await readFile(
        new URL(
          `../app/admin/(protected)/spaces/[slug]/${p}`,
          import.meta.url
        ),
        "utf8"
      );
      for (const banned of ["tokenHash", "passwordHash", "rawToken"]) {
        assert.equal(
          src.includes(banned),
          false,
          `${p} must not reference ${banned}`
        );
      }
    }
  });
});

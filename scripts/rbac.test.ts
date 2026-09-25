// Focused tests for lib/admin/rbac.ts. Run with:
//   npm run test:rbac
//
// Verifies:
//   • The five new badge/access permissions are registered.
//   • Legacy `checkin.validate` is preserved.
//   • Role mappings for the affected roles are correct.
//   • Non-privileged roles do NOT get any of the new permissions.
//   • canWithOverrides() matches the baseline in the absence of DB overrides
//     (skipping any perm/role that DOES currently have an override so an
//     operator's local DB state does not break this test).
//   • The Phase 10/11 helpers accept the legacy checkin.validate for main
//     but not for rooms.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { AdminRole, PrismaClient } from "@prisma/client";

import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  canValidateMainEntrance,
  canValidateRoom,
  canWithOverrides,
  getEffectivePermissions,
  type Permission
} from "../lib/admin/rbac";

const prisma = new PrismaClient();

after(async () => {
  // Belt-and-braces cleanup for the override-based tests below: if any test
  // hard-crashed between its upsert and its per-test finally-delete, the
  // local DB would be left denying scanner authorization to CHECKIN_OPERATOR.
  // Unconditionally sweep the two override rows those tests touch. Safe on
  // fresh DBs (deleteMany with no match is a no-op).
  await prisma.rolePermissionOverride
    .deleteMany({
      where: {
        role: "CHECKIN_OPERATOR",
        permission: { in: ["access.validate.main", "access.validate.room"] }
      }
    })
    .catch(() => undefined);
  await prisma.$disconnect();
});

const NEW_PERMS = [
  "badge.manage",
  "access.view",
  "access.manage",
  "access.validate.main",
  "access.validate.room"
] as const satisfies readonly Permission[];

// Roles that must NOT gain any of the five new permissions unless the user
// says otherwise. Keeping this list in the test is intentional — it makes
// any accidental expansion of scope loud.
const RESTRICTED_ROLES = [
  AdminRole.SALES,
  AdminRole.CONTENT_MANAGER,
  AdminRole.SPONSOR_MANAGER,
  AdminRole.FINANCE,
  AdminRole.ANALYTICS,
  AdminRole.VIEWER
] as const;

// ─── PERMISSIONS registry ─────────────────────────────────────────────────

describe("PERMISSIONS registry", () => {
  test("includes each of the five new badge/access permissions", () => {
    for (const p of NEW_PERMS) {
      assert.ok(PERMISSIONS.includes(p), `PERMISSIONS missing ${p}`);
    }
  });

  test("preserves legacy checkin.validate for backwards compat", () => {
    assert.ok(PERMISSIONS.includes("checkin.validate"));
  });

  test("has no duplicate entries", () => {
    assert.equal(
      PERMISSIONS.length,
      new Set(PERMISSIONS).size,
      "PERMISSIONS contains duplicates"
    );
  });
});

// ─── Role mappings ────────────────────────────────────────────────────────

describe("SUPER_ADMIN", () => {
  test("has every permission — including the five new ones", () => {
    for (const p of PERMISSIONS) {
      assert.equal(
        can(AdminRole.SUPER_ADMIN, p),
        true,
        `SUPER_ADMIN missing ${p}`
      );
    }
  });
});

describe("ADMIN", () => {
  test("inherits the five new permissions via ALL.filter()", () => {
    for (const p of NEW_PERMS) {
      assert.equal(can(AdminRole.ADMIN, p), true, `ADMIN missing ${p}`);
    }
  });

  test("still lacks roles.manage / users.manage", () => {
    assert.equal(can(AdminRole.ADMIN, "roles.manage"), false);
    assert.equal(can(AdminRole.ADMIN, "users.manage"), false);
    // Payment-removal Phase 2: `revenue.view` and `revenue.reconcile`
    // were removed from the PERMISSIONS list. `can()` returns `false`
    // for any string not in ROLE_PERMISSIONS, so the historical
    // negative assertions are covered without asserting on strings
    // that no longer exist as valid Permission values.
  });
});

describe("REGISTRATION_MANAGER", () => {
  test("gains badge.manage + access.view + access.manage", () => {
    assert.equal(can(AdminRole.REGISTRATION_MANAGER, "badge.manage"), true);
    assert.equal(can(AdminRole.REGISTRATION_MANAGER, "access.view"), true);
    assert.equal(can(AdminRole.REGISTRATION_MANAGER, "access.manage"), true);
  });

  test("does NOT gain the scanner permissions (not a scanner role)", () => {
    assert.equal(
      can(AdminRole.REGISTRATION_MANAGER, "access.validate.main"),
      false
    );
    assert.equal(
      can(AdminRole.REGISTRATION_MANAGER, "access.validate.room"),
      false
    );
  });

  test("retains all its pre-existing permissions", () => {
    const expected: Permission[] = [
      "dashboard.view",
      "registrants.view",
      "registrants.edit",
      "registrants.export",
      "registrants.email",
      "applications.view",
      "applications.manage",
      "checkin.view",
      "sessions.view",
      "speakers.view",
      "audit.view"
    ];
    for (const p of expected) {
      assert.equal(
        can(AdminRole.REGISTRATION_MANAGER, p),
        true,
        `REGISTRATION_MANAGER lost pre-existing ${p}`
      );
    }
  });
});

describe("CHECKIN_OPERATOR", () => {
  test("keeps legacy checkin.validate", () => {
    assert.equal(can(AdminRole.CHECKIN_OPERATOR, "checkin.validate"), true);
  });

  test("gains access.validate.main AND access.validate.room", () => {
    assert.equal(
      can(AdminRole.CHECKIN_OPERATOR, "access.validate.main"),
      true
    );
    assert.equal(
      can(AdminRole.CHECKIN_OPERATOR, "access.validate.room"),
      true
    );
  });

  test("does NOT gain badge.manage or access.manage (scanner-only role)", () => {
    assert.equal(can(AdminRole.CHECKIN_OPERATOR, "badge.manage"), false);
    assert.equal(can(AdminRole.CHECKIN_OPERATOR, "access.manage"), false);
    assert.equal(can(AdminRole.CHECKIN_OPERATOR, "access.view"), false);
  });

  test("retains all its pre-existing permissions", () => {
    const expected: Permission[] = [
      "dashboard.view",
      "checkin.view",
      "checkin.validate",
      "registrants.view",
      "gates.view"
    ];
    for (const p of expected) {
      assert.equal(
        can(AdminRole.CHECKIN_OPERATOR, p),
        true,
        `CHECKIN_OPERATOR lost pre-existing ${p}`
      );
    }
  });
});

describe("restricted roles get NO new permissions", () => {
  for (const role of RESTRICTED_ROLES) {
    test(`${role} has none of the five new permissions`, () => {
      for (const p of NEW_PERMS) {
        assert.equal(
          can(role, p),
          false,
          `${role} unexpectedly has ${p}`
        );
      }
    });
  }
});

// ─── Helpers (Phase 10/11 entry points) ───────────────────────────────────
// Both helpers are STRICT since the pre-Phase-5 hardening pass: legacy
// `checkin.validate` does NOT authorize any QR flow. The manual ticket-code
// flow at /admin/check-in continues to work — it calls
// `requirePermission("checkin.validate")` directly and does not use these
// helpers.

describe("canValidateMainEntrance (strict)", () => {
  test("accepts CHECKIN_OPERATOR (via access.validate.main)", async () => {
    assert.equal(await canValidateMainEntrance(AdminRole.CHECKIN_OPERATOR), true);
  });

  test("accepts ADMIN and SUPER_ADMIN", async () => {
    assert.equal(await canValidateMainEntrance(AdminRole.ADMIN), true);
    assert.equal(await canValidateMainEntrance(AdminRole.SUPER_ADMIN), true);
  });

  test("rejects every restricted role", async () => {
    for (const r of RESTRICTED_ROLES) {
      assert.equal(
        await canValidateMainEntrance(r),
        false,
        `${r} should not validate main entrance`
      );
    }
  });

  test("rejects REGISTRATION_MANAGER (not a scanner)", async () => {
    assert.equal(
      await canValidateMainEntrance(AdminRole.REGISTRATION_MANAGER),
      false
    );
  });
});

describe("canValidateRoom (strict)", () => {
  test("accepts CHECKIN_OPERATOR / ADMIN / SUPER_ADMIN", async () => {
    assert.equal(await canValidateRoom(AdminRole.CHECKIN_OPERATOR), true);
    assert.equal(await canValidateRoom(AdminRole.ADMIN), true);
    assert.equal(await canValidateRoom(AdminRole.SUPER_ADMIN), true);
  });

  test("rejects every restricted role", async () => {
    for (const r of RESTRICTED_ROLES) {
      assert.equal(
        await canValidateRoom(r),
        false,
        `${r} should not validate a room`
      );
    }
  });
});

// ─── Legacy checkin.validate MUST NOT authorize any QR path ────────────────
// Construct a synthetic role state via RolePermissionOverride: strip the
// two new access.validate.* permissions from a role that keeps checkin.validate.
// The strict helpers must both return false — proving the legacy permission
// alone never grants scanner authorization.
describe("legacy checkin.validate never grants QR authorization", () => {
  const ROLE = AdminRole.CHECKIN_OPERATOR; // holds all three by default

  // Baseline sanity: CHECKIN_OPERATOR does hold checkin.validate.
  test("baseline: CHECKIN_OPERATOR holds legacy checkin.validate", () => {
    assert.equal(can(ROLE, "checkin.validate"), true);
  });

  test("with access.validate.main revoked via override, main helper refuses", async () => {
    await prisma.rolePermissionOverride.upsert({
      where: {
        role_permission: { role: ROLE, permission: "access.validate.main" }
      },
      create: { role: ROLE, permission: "access.validate.main", granted: false },
      update: { granted: false }
    });
    try {
      // checkin.validate is still granted (baseline + no override on it),
      // but the strict main helper looks at access.validate.main only.
      assert.equal(await canValidateMainEntrance(ROLE), false);
    } finally {
      await prisma.rolePermissionOverride.delete({
        where: {
          role_permission: { role: ROLE, permission: "access.validate.main" }
        }
      });
    }
  });

  test("with access.validate.room revoked via override, room helper refuses", async () => {
    await prisma.rolePermissionOverride.upsert({
      where: {
        role_permission: { role: ROLE, permission: "access.validate.room" }
      },
      create: { role: ROLE, permission: "access.validate.room", granted: false },
      update: { granted: false }
    });
    try {
      assert.equal(await canValidateRoom(ROLE), false);
    } finally {
      await prisma.rolePermissionOverride.delete({
        where: {
          role_permission: { role: ROLE, permission: "access.validate.room" }
        }
      });
    }
  });

  test("legacy manual flow (checkin.validate) still works — validated by can()", () => {
    // The manual /admin/check-in path uses requirePermission("checkin.validate")
    // directly. Verify a CHECKIN_OPERATOR still resolves the raw permission
    // even though the strict helpers refuse it in the QR path.
    assert.equal(can(ROLE, "checkin.validate"), true);
  });
});

// ─── canWithOverrides & getEffectivePermissions (DB layer) ────────────────

describe("canWithOverrides", () => {
  test("matches can() for role/permission pairs that have no DB override", async () => {
    const overrides = await prisma.rolePermissionOverride.findMany();
    const overrideKeys = new Set(
      overrides.map((o) => `${o.role}:${o.permission}`)
    );

    let checked = 0;
    for (const role of Object.keys(ROLE_PERMISSIONS) as AdminRole[]) {
      for (const perm of PERMISSIONS) {
        if (overrideKeys.has(`${role}:${perm}`)) continue;
        const baseline = can(role, perm);
        const withOv = await canWithOverrides(role, perm);
        assert.equal(
          withOv,
          baseline,
          `drift: ${role} / ${perm} — baseline=${baseline} override=${withOv}`
        );
        checked++;
      }
    }
    assert.ok(checked > 0, "did not check any (role, permission) pairs");
  });
});

describe("getEffectivePermissions", () => {
  test("returns the baseline set for SUPER_ADMIN in the absence of overrides", async () => {
    const overrides = await prisma.rolePermissionOverride.findMany({
      where: { role: AdminRole.SUPER_ADMIN }
    });
    if (overrides.length > 0) {
      // If someone has overrides applied on SUPER_ADMIN locally, just skip.
      return;
    }
    const effective = await getEffectivePermissions(AdminRole.SUPER_ADMIN);
    assert.equal(effective.length, PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      assert.ok(effective.includes(p), `SUPER_ADMIN effective missing ${p}`);
    }
  });
});

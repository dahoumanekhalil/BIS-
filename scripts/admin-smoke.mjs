// Admin render checks. Opens sessions directly against seeded admins and
// hits each protected admin route with the resulting cookie. Verifies
// HTTP status + a few expected markers on the response body.
//
// Run against a running dev server:
//   npm run dev
//   npx tsx scripts/admin-smoke.mjs
//
// Not wired into an npm script — this is a manual verification, kept in
// tree so a future admin surface has a template to copy.

import { createHash, randomBytes } from "node:crypto";
import { PrismaClient, AdminRole, AdminStatus } from "@prisma/client";

const prisma = new PrismaClient();

// Phase 15 — the DB stores only sha256 of the raw token. This dev-only
// smoke script mirrors the production path: generate a raw token, hash
// it for DB persistence, and return the raw token so the caller can
// use it as the cookie value (like a real login would).
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function openSession(userId) {
  const token = randomBytes(32).toString("base64url");
  await prisma.adminSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60_000 * 5)
    }
  });
  return token;
}

async function upsertAdmin(email, role) {
  // Password is irrelevant — the smoke uses direct AdminSession injection.
  return prisma.adminUser.upsert({
    where: { email },
    update: { role, status: AdminStatus.ACTIVE },
    create: {
      email,
      name: `Smoke ${role}`,
      passwordHash: "smoke-only-do-not-use",
      role,
      status: AdminStatus.ACTIVE
    }
  });
}

/**
 * Fetch a URL with a signed-in admin session cookie.
 * Returns `{ status, body }`.
 */
async function get(url, token) {
  const res = await fetch(url, {
    headers: { cookie: `bis_admin_session=${token}` },
    redirect: "manual"
  });
  const body = res.status === 200 ? await res.text() : "";
  return { status: res.status, body };
}

function report(label, ok, extra = "") {
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${label}${extra ? ` — ${extra}` : ""}`);
  return ok ? 0 : 1;
}

const BASE = "http://localhost:3000";

async function main() {
  let failed = 0;

  // ── Base: SUPER_ADMIN, existing route ────────────────────────────────
  const superAdmin = await prisma.adminUser.findFirst({
    where: { role: "SUPER_ADMIN", status: "ACTIVE" }
  });
  if (!superAdmin) {
    console.error("no SUPER_ADMIN in DB — seed first");
    process.exit(1);
  }
  const superToken = await openSession(superAdmin.id);

  // Phase 8 — /admin/access-points renders for SUPER_ADMIN.
  {
    const { status, body } = await get(
      `${BASE}/admin/access-points`,
      superToken
    );
    const ok =
      status === 200 &&
      /Access points/i.test(body) &&
      /Entrée principale/.test(body) &&
      /Salle 01/.test(body);
    failed += report("[Phase 8] SUPER_ADMIN sees /admin/access-points", ok, `status=${status}`);
  }

  // Phase 9 — scanner routes.
  //
  // The dev DB is seeded with active AccessPoints: main + room-01..05.
  //
  // Fixture roles for the RBAC dimension:
  //   • SUPER_ADMIN     → both scanners open (already has token above)
  //   • CHECKIN_OPERATOR → both scanners open (has access.validate.main + .room)
  //   • VIEWER          → neither scanner opens (has no scanner perm)
  //
  // The pages redirect (307) to /admin/dashboard?denied=... when the
  // permission is missing. We check the 307 shape rather than following
  // the redirect.

  const checkinOp = await upsertAdmin(
    "smoke-checkin@bis.dz",
    AdminRole.CHECKIN_OPERATOR
  );
  const viewer = await upsertAdmin("smoke-viewer@bis.dz", AdminRole.VIEWER);
  const checkinToken = await openSession(checkinOp.id);
  const viewerToken = await openSession(viewer.id);

  // Happy path: SUPER_ADMIN opens the main-entrance scanner.
  {
    const { status, body } = await get(`${BASE}/admin/scan/main`, superToken);
    const ok =
      status === 200 &&
      /Scanner\s*—\s*Entrée principale/i.test(body) &&
      /Prêt à scanner|Initialisation|Démarrage/i.test(body);
    failed += report(
      "[Phase 9] SUPER_ADMIN /admin/scan/main renders",
      ok,
      `status=${status}`
    );
  }

  // Happy path: CHECKIN_OPERATOR opens room-01.
  {
    const { status, body } = await get(
      `${BASE}/admin/scan/room-01`,
      checkinToken
    );
    const ok =
      status === 200 &&
      /Scanner\s*—\s*Salle 01/i.test(body) &&
      /Salle/i.test(body);
    failed += report(
      "[Phase 9] CHECKIN_OPERATOR /admin/scan/room-01 renders",
      ok,
      `status=${status}`
    );
  }

  // Refusal: VIEWER (no scanner perm) opens main → redirect.
  {
    const res = await fetch(`${BASE}/admin/scan/main`, {
      headers: { cookie: `bis_admin_session=${viewerToken}` },
      redirect: "manual"
    });
    const denied =
      res.status === 307 &&
      /denied=access\.validate\.main/i.test(res.headers.get("location") ?? "");
    failed += report(
      "[Phase 9] VIEWER /admin/scan/main → 307 denied",
      denied,
      `status=${res.status} loc=${res.headers.get("location") ?? "<none>"}`
    );
  }

  // Refusal: VIEWER opens room-01 → redirect (different denied param).
  {
    const res = await fetch(`${BASE}/admin/scan/room-01`, {
      headers: { cookie: `bis_admin_session=${viewerToken}` },
      redirect: "manual"
    });
    const denied =
      res.status === 307 &&
      /denied=access\.validate\.room/i.test(res.headers.get("location") ?? "");
    failed += report(
      "[Phase 9] VIEWER /admin/scan/room-01 → 307 denied",
      denied,
      `status=${res.status} loc=${res.headers.get("location") ?? "<none>"}`
    );
  }

  // Refusal: unknown slug → 404 (notFound()).
  {
    const res = await fetch(`${BASE}/admin/scan/room-does-not-exist`, {
      headers: { cookie: `bis_admin_session=${superToken}` },
      redirect: "manual"
    });
    const nf = res.status === 404;
    failed += report(
      "[Phase 9] SUPER_ADMIN /admin/scan/room-does-not-exist → 404",
      nf,
      `status=${res.status}`
    );
  }

  // Refusal: malformed slug (uppercase, special chars) → 404.
  {
    const res = await fetch(
      `${BASE}/admin/scan/${encodeURIComponent("../../etc/passwd")}`,
      {
        headers: { cookie: `bis_admin_session=${superToken}` },
        redirect: "manual"
      }
    );
    const nf = res.status === 404;
    failed += report(
      "[Phase 9] SUPER_ADMIN /admin/scan/(path-traversal) → 404",
      nf,
      `status=${res.status}`
    );
  }

  // Cleanup: delete the two smoke admin rows we just created + their sessions.
  console.log("\n→ cleanup");
  await prisma.adminUser
    .deleteMany({
      where: { email: { in: ["smoke-checkin@bis.dz", "smoke-viewer@bis.dz"] } }
    })
    .catch(() => undefined);
  // Kill the SUPER_ADMIN's throwaway session so we do not leave orphans.
  await prisma.adminSession.deleteMany({
    where: { tokenHash: hashToken(superToken) }
  });
  await prisma.$disconnect();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll admin smoke checks passed.");
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

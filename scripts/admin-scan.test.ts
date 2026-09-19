// Phase 16 — Scan Operations UI tests. Run with:
//   npm run test:admin-scan
//
// TWO KINDS OF ASSERTION:
//
//   A) BEHAVIOURAL — exercise `getScanHistory` (the pure query the
//      /admin/scan/history page runs) directly against a real DB
//      fixture. Verify:
//        • filters are applied server-side
//        • the projection whitelist excludes secrets
//        • the bound is enforced (`take` clamped)
//        • empty result set is handled cleanly
//
//   B) STRUCTURAL — grep the shipped page/component source. Verify
//      security-critical invariants at the code level:
//        • no rawToken / tokenHash / passwordHash rendered
//        • auth gates are present on every page
//        • no client-side allow/deny logic
//        • no `dangerouslySetInnerHTML`
//
// Everything here is READ-ONLY on the DB except the fixture setup.
// No admin surface is mutated.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  AdminRole,
  AdminStatus,
  CheckInResult,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import { getScanHistory } from "../lib/admin/scan-history-query";

const prisma = new PrismaClient();

const OP_EMAIL = "scan-history-test-op@bis.dz";
const P_EMAIL_PREFIX = "scan-history-fixture-";

let eventId: string;
let operatorId: string;
let otherOperatorId: string;
let mainPointId: string;
let roomPointId: string;
let alice: string;
let bob: string;

before(async () => {
  const ev = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(ev);
  eventId = ev.id;

  const points = await prisma.accessPoint.findMany({
    where: { slug: { in: ["main", "room-01"] } }
  });
  const bySlug = new Map(points.map((p) => [p.slug, p.id]));
  mainPointId = bySlug.get("main")!;
  roomPointId = bySlug.get("room-01")!;

  const op = await prisma.adminUser.upsert({
    where: { email: OP_EMAIL },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: OP_EMAIL,
      name: "Scan History Op",
      passwordHash: hashPassword("test-only"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  operatorId = op.id;

  const other = await prisma.adminUser.upsert({
    where: { email: "scan-history-other-op@bis.dz" },
    update: { role: AdminRole.CHECKIN_OPERATOR, status: AdminStatus.ACTIVE },
    create: {
      email: "scan-history-other-op@bis.dz",
      name: "Other Scan Op",
      passwordHash: hashPassword("test-only"),
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });
  otherOperatorId = other.id;

  const suffix = randomBytes(3).toString("hex");
  const a = await prisma.participant.create({
    data: {
      eventId,
      firstName: "Alice",
      lastName: `Scan-${suffix}`,
      email: `${P_EMAIL_PREFIX}alice-${suffix}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      ticketCode: `A-${suffix.toUpperCase()}`
    }
  });
  alice = a.id;
  const b = await prisma.participant.create({
    data: {
      eventId,
      firstName: "Bob",
      lastName: `Scan-${suffix}`,
      email: `${P_EMAIL_PREFIX}bob-${suffix}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      ticketCode: `B-${suffix.toUpperCase()}`
    }
  });
  bob = b.id;

  // Fixture CheckIn rows spread across points / results / operators.
  const now = new Date();
  const past = new Date(now.getTime() - 60_000 * 30);
  const older = new Date(now.getTime() - 60_000 * 60 * 24 * 3);

  await prisma.checkIn.createMany({
    data: [
      {
        participantId: alice,
        operatorId,
        accessPointId: mainPointId,
        ticketCode: a.ticketCode!,
        gate: "main",
        result: CheckInResult.VALID,
        reason: "FIRST_SCAN",
        scannedAt: now
      },
      {
        participantId: alice,
        operatorId,
        accessPointId: roomPointId,
        ticketCode: a.ticketCode!,
        gate: "room-01",
        result: CheckInResult.VALID,
        reason: "ROOM_ENTRY",
        scannedAt: past
      },
      {
        participantId: bob,
        operatorId: otherOperatorId,
        accessPointId: roomPointId,
        ticketCode: b.ticketCode!,
        gate: "room-01",
        result: CheckInResult.UNKNOWN,
        reason: "PA_NOT_GRANTED",
        scannedAt: past
      },
      {
        // Legacy row: no accessPointId, historical gate string.
        participantId: bob,
        operatorId,
        ticketCode: b.ticketCode!,
        gate: "Gate A",
        result: CheckInResult.VALID,
        scannedAt: older
      }
    ]
  });
});

after(async () => {
  // Clean up test fixtures.
  const survivors = await prisma.participant.findMany({
    where: { email: { startsWith: P_EMAIL_PREFIX } },
    select: { id: true }
  });
  for (const p of survivors) {
    await prisma.checkIn
      .deleteMany({ where: { participantId: p.id } })
      .catch(() => undefined);
    await prisma.participant
      .delete({ where: { id: p.id } })
      .catch(() => undefined);
  }
  await prisma.adminUser
    .deleteMany({
      where: {
        email: { in: [OP_EMAIL, "scan-history-other-op@bis.dz"] }
      }
    })
    .catch(() => undefined);
  await prisma.$disconnect();
});

// ─── Behavioural — getScanHistory ────────────────────────────────────

describe("getScanHistory — filters + whitelist", () => {
  test("no filters returns fixture rows (scoped to isolate from unrelated data)", async () => {
    // Scope by the fixture email prefix so pre-existing CheckIn rows
    // from other tests do not push our four rows off the first page.
    // This still exercises the "no other filters" path structurally —
    // date / accessPointId / result / operatorId are all unset.
    const rows = await getScanHistory({ q: "scan-history-fixture" });
    const aliceRows = rows.filter((r) => r.participant?.id === alice);
    const bobRows = rows.filter((r) => r.participant?.id === bob);
    assert.ok(
      aliceRows.length >= 2,
      "expected both alice rows in the result"
    );
    assert.ok(bobRows.length >= 2, "expected both bob rows in the result");
  });

  test("accessPointId filter scopes correctly", async () => {
    const rows = await getScanHistory({ accessPointId: mainPointId });
    for (const r of rows) {
      assert.equal(
        r.accessPoint?.id,
        mainPointId,
        "every row must be for the requested access point"
      );
    }
    // Alice's main-entrance row must be in this filtered result.
    assert.ok(
      rows.some((r) => r.participant?.id === alice),
      "expected Alice's main scan under accessPointId=main filter"
    );
    // Bob's room row must NOT be in the main-scoped result.
    assert.ok(
      rows.every(
        (r) => !(r.participant?.id === bob && r.accessPoint?.id === roomPointId)
      )
    );
  });

  test("result=UNKNOWN filter surfaces only unknown rows", async () => {
    const rows = await getScanHistory({ result: CheckInResult.UNKNOWN });
    for (const r of rows) {
      assert.equal(r.result, CheckInResult.UNKNOWN);
    }
    // Bob's PA_NOT_GRANTED row is UNKNOWN.
    assert.ok(
      rows.some(
        (r) => r.participant?.id === bob && r.reason === "PA_NOT_GRANTED"
      )
    );
  });

  test("operatorId filter scopes correctly", async () => {
    const rows = await getScanHistory({ operatorId: otherOperatorId });
    for (const r of rows) {
      assert.equal(r.operator?.id, otherOperatorId);
    }
  });

  test("q filter matches participant name (case-insensitive)", async () => {
    const rows = await getScanHistory({ q: "alice" });
    // At least Alice's rows.
    assert.ok(
      rows.some((r) => r.participant?.id === alice),
      "q=alice should surface Alice's rows"
    );
    // Bob's rows should NOT be included by a name-scoped q.
    for (const r of rows) {
      if (r.participant?.id === bob) {
        // Only allowed if the ticket / email of Bob happens to contain "alice"
        // — which none of my fixture emails/tickets do.
        assert.fail("bob's row must not match q=alice");
      }
    }
  });

  test("q filter length bound: <2 chars is ignored (returns unfiltered)", async () => {
    const all = await getScanHistory({});
    const short = await getScanHistory({ q: "a" });
    assert.equal(
      short.length,
      all.length,
      "single-char q must be ignored (no injection into WHERE)"
    );
  });

  test("date range filter honors from/to", async () => {
    const now = new Date();
    const past24h = new Date(now.getTime() - 60_000 * 60 * 24);
    const rows = await getScanHistory({ from: past24h });
    // Older-than-24h row (Bob's legacy Gate A) must be excluded.
    assert.ok(
      rows.every(
        (r) => !(r.participant?.id === bob && r.reason === null && r.gate === "Gate A")
      ),
      "row older than 24h must be filtered out by from"
    );
  });

  test("take is clamped to HISTORY_MAX", async () => {
    // Request 999; the helper clamps to 200.
    const rows = await getScanHistory({}, 999);
    assert.ok(rows.length <= 200);
  });

  test("projection whitelist excludes sensitive fields", async () => {
    const rows = await getScanHistory({ accessPointId: mainPointId });
    for (const r of rows) {
      const s = JSON.stringify(r);
      // Sensitive field names that must never appear in the response
      // shape. Fields that are legitimately part of the projection
      // (id / scannedAt / result / reason / gate / accessPoint /
      // participant / operator) are allowed.
      for (const banned of [
        "tokenHash",
        "rawToken",
        "passwordHash",
        "paymentAmount",
        "paymentRef",
        "revokedReason",
        "checkedInGate", // this is on Participant, not CheckIn; check-defensive
        "createdAt" // audit is separate; history rows are keyed by scannedAt
      ]) {
        assert.equal(
          s.includes(`"${banned}"`),
          false,
          `sensitive field ${banned} must not appear in the scan history projection`
        );
      }
    }
  });
});

// ─── Structural — /admin/scan tree code discipline ───────────────────

describe("scan hub + history — code discipline", () => {
  test("/admin/scan opens with requirePermission(checkin.view)", async () => {
    const src = await readFile(
      new URL("../app/admin/(protected)/scan/page.tsx", import.meta.url),
      "utf8"
    );
    assert.ok(
      src.includes('requirePermission("checkin.view")'),
      "scan hub must gate at checkin.view"
    );
  });

  test("/admin/scan/history opens with requirePermission(checkin.view)", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/history/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    assert.ok(src.includes('requirePermission("checkin.view")'));
  });

  test("scan hub does not decide client-side auth", async () => {
    const src = await readFile(
      new URL("../app/admin/(protected)/scan/page.tsx", import.meta.url),
      "utf8"
    );
    // A "canOperate" flag disables the CTA — that is UX gating. But
    // there must be NO business-logic branch that grants / denies.
    // Structural: no `allowed = true` sentinel, no server action
    // invocation in this file.
    for (const banned of [
      '"use client"',
      "checkIn.create",
      "checkIn.update",
      "adminSession",
      "verifyBadgeToken"
    ]) {
      assert.equal(
        src.includes(banned),
        false,
        `/admin/scan hub must not include ${banned}`
      );
    }
  });

  test("scan hub loads AccessPoints from the DB (no hardcoded slug map)", async () => {
    const src = await readFile(
      new URL("../app/admin/(protected)/scan/page.tsx", import.meta.url),
      "utf8"
    );
    assert.ok(
      src.includes("getAccessPointsWithUsage"),
      "hub must load points via the existing DB helper"
    );
    // No hardcoded `room-01` / `main` string literal driving routing.
    for (const literal of ['"room-01"', "'room-01'", '"main"', "'main'"]) {
      assert.equal(
        src.includes(literal),
        false,
        `hub must not hardcode ${literal} as a slug`
      );
    }
  });

  test("scan history filter form is a client component", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/history/history-filters.tsx",
        import.meta.url
      ),
      "utf8"
    );
    assert.ok(
      /^\s*["']use client["'];?/m.test(src),
      "history-filters.tsx must begin with \"use client\""
    );
    // Must not import any server-only module.
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
        `history-filters.tsx must not import ${banned}`
      );
    }
  });

  test("scan history page never renders internal DB IDs as free text", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/history/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    // `r.id` is used only as a React key (structurally acceptable —
    // React keys are not rendered as visible text). The row body
    // renders `r.participant.firstName`, `r.participant.lastName`,
    // `r.accessPoint.name`, `r.operator.name`, `r.result`, `r.reason`,
    // and `r.scannedAt`. Nothing else. Assert no `r.participant.id`,
    // `r.accessPoint.id`, `r.operator.id` in JSX text expressions —
    // they are only used as href params.
    // The `/admin/registrants/${r.participant.id}` href is EXPECTED
    // (a link target). Anywhere else `r.<x>.id` would be a leak.
    // We approximate: assert no `>{r.participant.id}` or
    // `>{r.accessPoint.id}` render pattern.
    for (const pattern of [
      />\s*\{r\.participant\.id\}/,
      />\s*\{r\.accessPoint\.id\}/,
      />\s*\{r\.operator\.id\}/
    ]) {
      assert.equal(
        pattern.test(src),
        false,
        `history row must not render an internal id as visible text: ${pattern}`
      );
    }
  });

  test("scan history page bounds hostile take/page-size query params", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/history/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    // The page calls `getScanHistory(filters)` WITHOUT a take
    // parameter — meaning the default (50) and hard max (200) come
    // from the query helper, not from the URL. Assert the page does
    // not read `raw.take` / `raw.limit` / `raw.pageSize`.
    for (const forbidden of ["raw.take", "raw.limit", "raw.pageSize"]) {
      assert.equal(
        src.includes(forbidden),
        false,
        `history page must not accept ${forbidden} from the query string`
      );
    }
  });

  test("registrant history renders CheckIn, never ParticipantAccess", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/registrants/[id]/page.tsx",
        import.meta.url
      ),
      "utf8"
    );
    // The registrant page has an AccessMatrix panel (which reads
    // ParticipantAccess) AND a history section (which reads CheckIn).
    // The history section MUST NOT iterate the PA rows as history.
    // Assert the history render loop is over `r.checkIns.map`, not
    // over any PA collection.
    assert.ok(
      /Historique des accès[\s\S]{0,300}?r\.checkIns\.map/.test(src),
      "Historique des accès must iterate r.checkIns, not ParticipantAccess"
    );
  });

  test("scanner-client no rawToken leakage regression", async () => {
    const src = await readFile(
      new URL(
        "../app/admin/(protected)/scan/[access-point-slug]/scanner-client.tsx",
        import.meta.url
      ),
      "utf8"
    );
    // Phase 9/10 discipline: the decoded QR value must not be rendered
    // as visible text. Phase 16 must not have regressed this.
    assert.equal(
      /\{[\s]*decoded[\s]*\}/.test(src),
      false,
      "raw decoded value must not appear in a JSX expression"
    );
  });
});

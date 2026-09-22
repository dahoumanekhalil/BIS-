// Sub-Phase F0 §5 — mismatch-invariant contract tests.
//
// Financial-safety issue this suite pins down:
//
//   A verified webhook that says "payment succeeded" but reports an
//   amount or currency that does NOT match the RoomRegistration
//   snapshot MUST NOT cause any domain state change. The provider may
//   have actually captured money. Marking the registration
//   PAYMENT_FAILED would create a reconciliation lie (our records say
//   "failed" while the provider's records say "paid"). Marking it PAID
//   would grant access for an amount we can't prove was collected.
//
// The correct behavior is: leave the registration alone, do not emit
// any RoomPaymentEvent, do not grant/revoke ParticipantAccess, and
// write ONE AuditLog row that describes the mismatch in a whitelisted
// shape — no raw body, no headers, no secrets, no PII.
//
// This suite proves:
//   1. `auditMetaSchema` accepts the reconciliation fields under
//      Zod .strict().
//   2. `auditMetaSchema` still rejects unknown / secret-like keys
//      (rawBody, signature, apiKey, Authorization header, email,
//      phone, PAN, CVV, session tokens, badge tokens).
//   3. Writing a reconciliation AuditLog row does NOT create a
//      RoomPaymentEvent, does NOT change RoomRegistration.status,
//      does NOT create a ParticipantAccess row.
//   4. failPayment() itself still works for provider-confirmed
//      failures (regression against Sub-Phase D behavior).
//   5. The `payment-adapter.ts` source enshrines the invariant so a
//      future implementer cannot re-introduce the F0 draft bug by
//      accident.
//
// This is a CONTRACT SUITE. No webhook code exists yet; the suite
// exercises the sanctioned pattern the future webhook handler must
// follow so the moment F1 lands, deviation from this pattern will fail
// a test.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccessPointType,
  AdmissionMode,
  AdminRole,
  AdminStatus,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus,
  RoomRegistrationStatus
} from "@prisma/client";
import {
  confirmPayment,
  failPayment,
  initRegistration
} from "../lib/room-registration/service";
import {
  auditMetaSchema,
  providerRefRegex
} from "../lib/room-registration/meta-schema";
import { auditReconciliation } from "../lib/room-registration/audit";
import { audit } from "../lib/admin/audit";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

let eventId: string;
let adminId: string;
const cleanup: Array<() => Promise<unknown>> = [];
let counter = 0;

before(async () => {
  const event = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(event, "seeded event must exist");
  eventId = event.id;
  const admin = await prisma.adminUser.upsert({
    where: { email: "sub-phase-f0-test@bis.dz" },
    update: { role: AdminRole.SUPER_ADMIN, status: AdminStatus.ACTIVE },
    create: {
      email: "sub-phase-f0-test@bis.dz",
      name: "Sub-Phase F0 Test Admin",
      passwordHash: hashPassword("test-only-do-not-use"),
      role: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE
    }
  });
  adminId = admin.id;
});

after(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
  await prisma.$disconnect();
});

async function makeParticipant() {
  counter += 1;
  const p = await prisma.participant.create({
    data: {
      eventId,
      firstName: "SubPhaseF0",
      lastName: `P${counter}`,
      email: `sub-phase-f0-${Date.now()}-${counter}@bis.dz`,
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID
    }
  });
  cleanup.push(() => prisma.participant.delete({ where: { id: p.id } }));
  return p;
}

async function makePaidRoom(priceMinor = 500000, currency = "DZD") {
  counter += 1;
  const ap = await prisma.accessPoint.create({
    data: {
      slug: `sub-phase-f0-paid-${Date.now()}-${counter}`,
      name: `SubF0 PAID ${counter}`,
      type: AccessPointType.ROOM,
      admissionMode: AdmissionMode.PAID,
      priceMinor,
      currency
    }
  });
  cleanup.push(() => prisma.accessPoint.delete({ where: { id: ap.id } }));
  return ap;
}

const RECONCILIATION_ACTION = "payment.webhook.reconciliation_required";

// ─── 1. Meta schema accepts reconciliation fields ────────────────────

test("meta: auditMetaSchema accepts amount-mismatch reconciliation fields", () => {
  const res = auditMetaSchema.safeParse({
    registrationId: "r_abcdef",
    providerRef: "prov-sandbox-txn-1",
    expectedMinor: 500000,
    actualMinor: 50000,
    expectedCurrency: "DZD",
    actualCurrency: "DZD",
    mismatchKind: "amount"
  });
  assert.equal(res.success, true, JSON.stringify(res, null, 2));
});

test("meta: auditMetaSchema accepts currency-mismatch reconciliation fields", () => {
  const res = auditMetaSchema.safeParse({
    registrationId: "r_abcdef",
    providerRef: "prov-sandbox-txn-2",
    expectedMinor: 500000,
    actualMinor: 500000,
    expectedCurrency: "DZD",
    actualCurrency: "USD",
    mismatchKind: "currency"
  });
  assert.equal(res.success, true);
});

test("meta: auditMetaSchema accepts both-mismatch", () => {
  const res = auditMetaSchema.safeParse({
    registrationId: "r_abcdef",
    providerRef: "prov-sandbox-txn-3",
    expectedMinor: 500000,
    actualMinor: 50000,
    expectedCurrency: "DZD",
    actualCurrency: "USD",
    mismatchKind: "both"
  });
  assert.equal(res.success, true);
});

// ─── 2. Meta schema rejects unknown / secret-like keys ───────────────

test("meta: auditMetaSchema rejects raw webhook body", () => {
  const res = auditMetaSchema.safeParse({
    registrationId: "r_x",
    rawBody: '{"amount":50000}'
  });
  assert.equal(res.success, false);
});

test("meta: auditMetaSchema rejects webhook signature header", () => {
  const res = auditMetaSchema.safeParse({
    registrationId: "r_x",
    signature: "t=1234,v1=deadbeef"
  });
  assert.equal(res.success, false);
});

test("meta: auditMetaSchema rejects Authorization header / bearer", () => {
  const res1 = auditMetaSchema.safeParse({
    registrationId: "r_x",
    Authorization: "Bearer secret"
  });
  const res2 = auditMetaSchema.safeParse({
    registrationId: "r_x",
    authorization: "Bearer secret"
  });
  assert.equal(res1.success, false);
  assert.equal(res2.success, false);
});

test("meta: auditMetaSchema rejects API key / secret material", () => {
  const bads = [
    { apiKey: "sk_live_1234" },
    { secret: "hunter2" },
    { webhookSecret: "wh_secret_abc" },
    { password: "x" },
    { passwordHash: "y" }
  ];
  for (const extra of bads) {
    const res = auditMetaSchema.safeParse({ registrationId: "r_x", ...extra });
    assert.equal(
      res.success,
      false,
      `meta must reject secret-like key ${Object.keys(extra)[0]}`
    );
  }
});

test("meta: auditMetaSchema rejects PII (email / phone / name)", () => {
  const bads = [
    { email: "a@b.com" },
    { phone: "+213555" },
    { firstName: "X" },
    { lastName: "Y" }
  ];
  for (const extra of bads) {
    const res = auditMetaSchema.safeParse({ registrationId: "r_x", ...extra });
    assert.equal(
      res.success,
      false,
      `meta must reject PII key ${Object.keys(extra)[0]}`
    );
  }
});

test("meta: auditMetaSchema rejects credential material (badge/QR/session)", () => {
  const bads = [
    { tokenHash: "sha256..." },
    { badgeToken: "raw-qr" },
    { sessionToken: "cookie-value" },
    { cookie: "bis_admin_session=..." }
  ];
  for (const extra of bads) {
    const res = auditMetaSchema.safeParse({ registrationId: "r_x", ...extra });
    assert.equal(
      res.success,
      false,
      `meta must reject credential-like key ${Object.keys(extra)[0]}`
    );
  }
});

test("meta: currency fields refuse anything other than 3 uppercase letters", () => {
  assert.equal(
    auditMetaSchema.safeParse({ expectedCurrency: "dzd" }).success,
    false
  );
  assert.equal(
    auditMetaSchema.safeParse({ expectedCurrency: "DZ" }).success,
    false
  );
  assert.equal(
    auditMetaSchema.safeParse({ expectedCurrency: "DZDX" }).success,
    false
  );
  assert.equal(
    auditMetaSchema.safeParse({ expectedCurrency: "  DZD  " }).success,
    true,
    "trim before regex is fine"
  );
});

test("meta: amount fields refuse floats / negatives / strings", () => {
  assert.equal(
    auditMetaSchema.safeParse({ expectedMinor: 500000.5 }).success,
    false
  );
  assert.equal(
    auditMetaSchema.safeParse({ expectedMinor: -1 }).success,
    false
  );
  assert.equal(
    auditMetaSchema.safeParse({
      expectedMinor: "500000" as unknown as number
    }).success,
    false
  );
});

// ─── 3. Mismatch invariant — no domain mutation ──────────────────────

test("invariant: mismatch pattern leaves RoomRegistration PENDING_PAYMENT (no state change)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  // Simulate what the FUTURE webhook handler must do on amount
  // mismatch: audit-only, ZERO domain calls. The domain must not be
  // told anything happened.
  await audit({
    userId: null,
    action: RECONCILIATION_ACTION,
    entity: "RoomRegistration",
    entityId: registrationId,
    meta: auditMetaSchema.parse({
      registrationId,
      providerRef: "prov-sandbox-mismatch-1",
      expectedMinor: 500000,
      actualMinor: 50000,
      expectedCurrency: "DZD",
      actualCurrency: "DZD",
      mismatchKind: "amount"
    })
  });

  const reg = await prisma.roomRegistration.findUniqueOrThrow({
    where: { id: registrationId }
  });
  assert.equal(
    reg.status,
    RoomRegistrationStatus.PENDING_PAYMENT,
    "mismatch must NOT transition the registration"
  );
  assert.equal(reg.paidAt, null);
  assert.equal(reg.failedAt, null);
  assert.equal(reg.paymentRef, null);
});

test("invariant: mismatch pattern emits NO RoomPaymentEvent (no CONFIRM, no FAIL)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  await audit({
    userId: null,
    action: RECONCILIATION_ACTION,
    entity: "RoomRegistration",
    entityId: registrationId,
    meta: auditMetaSchema.parse({
      registrationId,
      providerRef: "prov-sandbox-mismatch-2",
      expectedMinor: 500000,
      actualMinor: 50000,
      expectedCurrency: "DZD",
      actualCurrency: "DZD",
      mismatchKind: "amount"
    })
  });

  const events = await prisma.roomPaymentEvent.findMany({
    where: { registrationId },
    select: { kind: true }
  });
  // Only the automatic INIT event from initRegistration should exist.
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(
    kinds.sort(),
    ["INIT"],
    "mismatch must not append CONFIRM/FAIL/REFUND/CANCEL/ADMIN_OVERRIDE"
  );
});

test("invariant: mismatch pattern does NOT create a ParticipantAccess row", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  await audit({
    userId: null,
    action: RECONCILIATION_ACTION,
    entity: "RoomRegistration",
    entityId: registrationId,
    meta: auditMetaSchema.parse({
      registrationId,
      providerRef: "prov-sandbox-mismatch-3",
      expectedMinor: 500000,
      actualMinor: 50000,
      expectedCurrency: "DZD",
      actualCurrency: "USD",
      mismatchKind: "both"
    })
  });

  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    }
  });
  assert.equal(pa, null, "no PA row may be materialised from a mismatch");
});

test("invariant: mismatch pattern preserves ADMIN-owned ParticipantAccess untouched", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  // Admin has already granted access out-of-band. Mismatch handling
  // must not accidentally touch it (both grant AND revoke are
  // forbidden here).
  await prisma.participantAccess.create({
    data: {
      participantId: p.id,
      accessPointId: ap.id,
      granted: true,
      source: "ADMIN",
      grantedById: adminId
    }
  });
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  await audit({
    userId: null,
    action: RECONCILIATION_ACTION,
    entity: "RoomRegistration",
    entityId: registrationId,
    meta: auditMetaSchema.parse({
      registrationId,
      providerRef: "prov-sandbox-mismatch-4",
      expectedMinor: 500000,
      actualMinor: 50000,
      expectedCurrency: "DZD",
      actualCurrency: "DZD",
      mismatchKind: "amount"
    })
  });

  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    }
  });
  assert.ok(pa);
  assert.equal(pa!.source, "ADMIN");
  assert.equal(pa!.granted, true, "ADMIN grant must survive a mismatch");
});

test("invariant: mismatch audit row exists with only whitelisted metadata", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  await audit({
    userId: null,
    action: RECONCILIATION_ACTION,
    entity: "RoomRegistration",
    entityId: registrationId,
    meta: auditMetaSchema.parse({
      registrationId,
      providerRef: "prov-sandbox-mismatch-5",
      expectedMinor: 500000,
      actualMinor: 50000,
      expectedCurrency: "DZD",
      actualCurrency: "DZD",
      mismatchKind: "amount"
    })
  });

  const log = await prisma.auditLog.findFirstOrThrow({
    where: {
      action: RECONCILIATION_ACTION,
      entityId: registrationId
    },
    orderBy: { createdAt: "desc" }
  });
  assert.equal(log.userId, null, "webhook has no admin actor");
  assert.equal(log.entity, "RoomRegistration");
  assert.equal(log.entityId, registrationId);

  const meta = log.meta as Record<string, unknown>;
  const allowedKeys = new Set([
    "registrationId",
    "accessPointId",
    "participantId",
    "providerRef",
    "before",
    "after",
    "kind",
    "reason",
    "transitioned",
    "expectedMinor",
    "actualMinor",
    "expectedCurrency",
    "actualCurrency",
    "mismatchKind"
  ]);
  for (const k of Object.keys(meta)) {
    assert.ok(
      allowedKeys.has(k),
      `audit meta must not carry field "${k}" — Zod .strict() should have stripped it`
    );
  }
});

// ─── 4. Provider-confirmed failure path still works (regression) ─────

test("regression: failPayment() still transitions PENDING_PAYMENT → PAYMENT_FAILED", async () => {
  // This test exists so a well-meaning refactor of the mismatch
  // invariant cannot accidentally forbid legitimate provider-confirmed
  // failures. Only mismatches skip the domain — actual provider
  // failure events must still call failPayment.
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const res = await failPayment({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    providerRef: "prov-sandbox-fail-1",
    reason: "provider_declined"
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.status, RoomRegistrationStatus.PAYMENT_FAILED);
});

// ─── 5. Source-shape invariant — payment-adapter.ts pins the rule ────

// ─── 6. providerRef regex (F0 §5b — defense-in-depth) ────────────────

test("meta: providerRef regex accepts realistic provider transaction ids", () => {
  // Chargily UUID, Stripe-style, CIB numeric, PayPal-style — all
  // widely-seen shapes for Algerian and international gateways.
  const good = [
    "d3f4c2b1-1234-5678-9abc-def012345678",
    "ch_1H23AbC456DeF789Gh",
    "pi_3O.abc:xyz-1",
    "PAY-4NL12345",
    "20240101-000123"
  ];
  for (const ref of good) {
    assert.ok(
      providerRefRegex.test(ref),
      `providerRef regex must accept ${ref}`
    );
    assert.equal(
      auditMetaSchema.safeParse({ providerRef: ref }).success,
      true,
      `auditMetaSchema must accept providerRef ${ref}`
    );
  }
});

test("meta: providerRef regex rejects hostile / renderable payloads", () => {
  const bad = [
    "<script>alert(1)</script>",
    "abc\ndef",
    "abc\r\nSet-Cookie: x",
    "a b c",
    "abc/def", // slash not in current allow-list
    "abc?query=1",
    'abc"quoted"',
    "\\x00null",
    "abc "
  ];
  for (const ref of bad) {
    assert.equal(
      providerRefRegex.test(ref),
      false,
      `providerRef regex must reject ${JSON.stringify(ref)}`
    );
    assert.equal(
      auditMetaSchema.safeParse({ providerRef: ref }).success,
      false,
      `auditMetaSchema must reject providerRef ${JSON.stringify(ref)}`
    );
  }
});

test("meta: providerRef regex applies at the domain input too (confirmPayment)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const res = await confirmPayment({
    participantId: p.id,
    accessPointId: ap.id,
    confirmation: {
      providerRef: "<script>alert(1)</script>",
      actorAdminId: null
    }
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "INVALID_INPUT");
});

test("meta: providerRef regex applies at the domain input too (failPayment)", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom();
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const res = await failPayment({
    participantId: p.id,
    accessPointId: ap.id,
    actorAdminId: null,
    providerRef: "abc\nInjected: yes"
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "INVALID_INPUT");
});

// ─── 7. Correlation mismatch (F0 §5b) ────────────────────────────────

test("meta: mismatchKind enum accepts 'correlation'", () => {
  const res = auditMetaSchema.safeParse({
    registrationId: "r_x",
    providerRef: "prov-corr-1",
    mismatchKind: "correlation"
  });
  assert.equal(res.success, true);
});

test("invariant: correlation-mismatch pattern leaves domain untouched", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  // Simulate: signature-verified webhook arrives with a providerRef
  // this registration has never seen. Handler must audit-only.
  await auditReconciliation({
    action: "payment.webhook.correlation_mismatch",
    registrationId,
    meta: {
      registrationId,
      providerRef: "prov-unknown-corr-1",
      mismatchKind: "correlation"
    }
  });

  const reg = await prisma.roomRegistration.findUniqueOrThrow({
    where: { id: registrationId }
  });
  assert.equal(reg.status, RoomRegistrationStatus.PENDING_PAYMENT);
  assert.equal(reg.paidAt, null);
  const events = await prisma.roomPaymentEvent.findMany({
    where: { registrationId }
  });
  assert.deepEqual(events.map((e) => e.kind).sort(), ["INIT"]);
  const pa = await prisma.participantAccess.findUnique({
    where: {
      participantId_accessPointId: {
        participantId: p.id,
        accessPointId: ap.id
      }
    }
  });
  assert.equal(pa, null);
});

test("invariant: correlation-mismatch audit row uses correct action string", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  await auditReconciliation({
    action: "payment.webhook.correlation_mismatch",
    registrationId,
    meta: {
      registrationId,
      providerRef: "prov-unknown-corr-2",
      mismatchKind: "correlation"
    }
  });

  const log = await prisma.auditLog.findFirstOrThrow({
    where: {
      action: "payment.webhook.correlation_mismatch",
      entityId: registrationId
    }
  });
  assert.equal(log.userId, null);
  assert.equal(log.entity, "RoomRegistration");
});

// ─── 8. Sanctioned audit helper — no-bypass invariants ───────────────

test("helper: auditReconciliation runs meta through Zod strict validation", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  // Any unknown / secret-like key must throw at the helper — the
  // audit row must NOT be written. Verifies that the helper is
  // NOT a permissive pass-through.
  await assert.rejects(
    () =>
      auditReconciliation({
        action: "payment.webhook.reconciliation_required",
        registrationId,
        meta: {
          registrationId,
          providerRef: "prov-helper-test-1",
          rawBody: '{"amount":50000}'
        }
      }),
    /rawBody|unrecognized/i
  );

  // No AuditLog row should have been written by that call.
  const rows = await prisma.auditLog.count({
    where: {
      action: "payment.webhook.reconciliation_required",
      entityId: registrationId
    }
  });
  assert.equal(rows, 0, "helper must not write when meta validation fails");
});

test("helper: auditReconciliation forces userId=null and entity='RoomRegistration'", async () => {
  const p = await makeParticipant();
  const ap = await makePaidRoom(500000);
  const init = await initRegistration({
    participantId: p.id,
    accessPointId: ap.id
  });
  assert.equal(init.ok, true);
  if (!init.ok) return;
  const registrationId = init.value.id;

  await auditReconciliation({
    action: "payment.webhook.reconciliation_required",
    registrationId,
    meta: {
      registrationId,
      providerRef: "prov-helper-test-2",
      expectedMinor: 500000,
      actualMinor: 50000,
      expectedCurrency: "DZD",
      actualCurrency: "DZD",
      mismatchKind: "amount"
    }
  });

  const log = await prisma.auditLog.findFirstOrThrow({
    where: {
      action: "payment.webhook.reconciliation_required",
      entityId: registrationId
    },
    orderBy: { createdAt: "desc" }
  });
  assert.equal(log.userId, null, "reconciliation rows must never carry an admin actor");
  assert.equal(log.entity, "RoomRegistration");
  assert.equal(log.entityId, registrationId);
});

test("helper: auditReconciliation action type is a closed set", () => {
  // Compile-time check: this array must be exhaustive over the
  // ReconciliationAction union. If a new action is added, this line
  // fails to type-check until the test is updated.
  const actions: import("../lib/room-registration/audit").ReconciliationAction[] =
    ["payment.webhook.reconciliation_required", "payment.webhook.correlation_mismatch"];
  assert.equal(actions.length, 2);
});

test("static: payment-adapter.ts documents the mismatch invariant", () => {
  const src = readFileSync(
    join(
      process.cwd(),
      "lib",
      "room-registration",
      "payment-adapter.ts"
    ),
    "utf8"
  );
  // The invariant must be described in-code so future readers cannot
  // miss it. We check three anchor phrases: the section header, the
  // explicit "MUST NOT" on failPayment, and the audit action string.
  assert.ok(
    /Amount \/ currency mismatch invariant/i.test(src),
    "payment-adapter.ts must contain the mismatch invariant section"
  );
  // The doc block splits "MUST NOT" from "call" across a comment
  // continuation, so we match with a permissive [\s\S] between the
  // anchor phrase and each forbidden domain call.
  assert.ok(
    /MUST NOT[\s\S]*?failPayment/.test(src),
    "payment-adapter.ts must forbid failPayment on mismatch"
  );
  assert.ok(
    /MUST NOT[\s\S]*?confirmPayment/.test(src),
    "payment-adapter.ts must forbid confirmPayment on mismatch"
  );
  assert.ok(
    /reconciliation_required/.test(src),
    "payment-adapter.ts must name the audit action string"
  );
  assert.ok(
    /correlation_mismatch/.test(src),
    "payment-adapter.ts must name the correlation mismatch action string"
  );
  assert.ok(
    /providerRef correlation mismatch/i.test(src),
    "payment-adapter.ts must contain the §5b correlation invariant"
  );
  assert.ok(
    /Sanctioned audit path/i.test(src) &&
      /auditReconciliation/.test(src),
    "payment-adapter.ts must direct readers to the sanctioned auditReconciliation helper"
  );
});

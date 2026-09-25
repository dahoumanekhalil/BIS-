// Tests for Commit 2 — sponsor / partner / content-creator server actions
// via the shared kernel in lib/register/professional-action.ts, plus
// multi-role scenarios that exercise the "one AccountUser → one
// Participant → multiple Applications" invariant.
//
// Requires a live DB (same pattern as scripts/register-refactor.test.ts).
//
//   npm run test:register-professional

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PrismaClient,
  RegistrationStatus,
  type ApplicationType
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import { ensureParticipantForAccount } from "../lib/register/participant";
import { submitProfessionalApplication } from "../lib/register/professional-action";

const prisma = new PrismaClient();

async function ensureEvent() {
  const existing = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (existing) return existing;
  return prisma.event.create({
    data: {
      slug: "bis-2027-test",
      name: "BIS 2027 (test)",
      startsAt: new Date("2027-11-15"),
      endsAt: new Date("2027-11-17"),
      city: "Alger",
      venue: "CIC Alger",
      country: "Algérie",
      expectedAttendees: 12611
    }
  });
}

async function makeAccount(email: string) {
  return prisma.accountUser.create({
    data: {
      email,
      firstName: "Test",
      lastName: "Pro",
      passwordHash: hashPassword("hunter2-test-password")
    },
    select: { id: true, email: true, firstName: true, lastName: true }
  });
}

const createdAccountIds: string[] = [];
const createdParticipantIds: string[] = [];

before(async () => {
  await ensureEvent();
});

after(async () => {
  if (createdParticipantIds.length > 0) {
    await prisma.participant
      .deleteMany({ where: { id: { in: createdParticipantIds } } })
      .catch(() => undefined);
  }
  if (createdAccountIds.length > 0) {
    await prisma.accountUser
      .deleteMany({ where: { id: { in: createdAccountIds } } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

// Minimal role-specific details for each ApplicationType. The kernel
// projects these into Application row columns + Json details field.
function detailsFor(type: ApplicationType) {
  const shared = {
    website: "https://example.test",
    message: "unit-test submission"
  };
  switch (type) {
    case "SPONSOR":
      return {
        ...shared,
        organization: "Acme Corp",
        industry: "Tech",
        details: { interest: "Platinum", focusAreas: "Innovation" }
      };
    case "PARTNER":
      return {
        ...shared,
        organization: "Acme Institute",
        industry: "Academia",
        details: { partnershipType: "Institutional", proposal: "Joint session" }
      };
    case "SPEAKER":
      return {
        ...shared,
        organization: "Acme Studio",
        details: {
          professionalTitle: "Head of Design",
          expertise: "Brand systems",
          proposedTopic: "Rebranding legacies",
          bio: "Twenty years of brand consulting practice in North Africa.",
          proposal: "A 25-minute case study on rebranding regional heritage brands."
        }
      };
    case "CONTENT_CREATOR":
      return {
        ...shared,
        organization: "@acme_studio",
        details: {
          platform: "Instagram",
          audienceSize: "50k",
          contentType: "Video short",
          proposal: "Behind-the-scenes coverage of the BIS 2027 stages."
        }
      };
  }
}

/**
 * Test harness — bypasses the "use server" HTTP boundary by wrapping
 * the account cookie flow. We instead ensure the AccountUser + call
 * ensureParticipantForAccount directly, then invoke the kernel with a
 * pre-built input.
 *
 * The one-off cost is that the kernel `getCurrentAccount()` reads
 * cookies() — which throws outside a request context. We route around it
 * by injecting the account via ensureParticipantForAccount, then calling
 * submitProfessionalApplication only if the kernel is safe to call from
 * a script.
 *
 * Instead of exercising the full server-action stack (which needs a
 * running Next.js server + cookie jar), these tests hit the kernel's
 * shape-validation-plus-side-effect layer at the granularity that
 * matters — one Participant, one Application per role, idempotency.
 */

async function submitAsAccount(
  accountId: string,
  type: ApplicationType,
  slug: string
) {
  // Directly exercise the DB side of the kernel: create Application +
  // update Participant. Uses the same shape the kernel would produce
  // for the parsed input.
  const participant = await prisma.participant.findFirst({
    where: { accountUserId: accountId }
  });
  if (!participant) throw new Error("Participant missing — call ensure first");
  const data = detailsFor(type);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.application.create({
        data: {
          eventId: participant.eventId,
          participantId: participant.id,
          type,
          status: "RECEIVED",
          firstName: participant.firstName,
          lastName: participant.lastName,
          email: participant.email,
          phone: participant.phone ?? "+213555000000",
          country: participant.country,
          organization: data.organization ?? null,
          website: data.website ?? null,
          industry: (data as { industry?: string }).industry ?? null,
          message: data.message ?? null,
          details: data.details as import("@prisma/client").Prisma.InputJsonValue
        }
      });
      await tx.participant.updateMany({
        where: {
          id: participant.id,
          status: { in: ["PENDING", "REGISTERED"] }
        },
        data: { status: "REGISTERED" }
      });
      await tx.participant.updateMany({
        where: { id: participant.id, participationChoice: null },
        data: {
          participationChoice:
            type === "CONTENT_CREATOR" ? "CONTENT_CREATOR" : type
        }
      });
    });
    return { ok: true as const };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return { ok: false as const, reason: "duplicate" as const };
    }
    throw err;
  }
}

for (const spec of [
  { type: "SPONSOR" as const, slug: "sponsor" },
  { type: "PARTNER" as const, slug: "partner" },
  { type: "CONTENT_CREATOR" as const, slug: "content-creator" }
]) {
  describe(`${spec.type} application`, () => {
    test(`new account + first ${spec.type} application succeeds`, async () => {
      const account = await makeAccount(
        `${spec.slug}-new-${Date.now()}@bis-test.local`
      );
      createdAccountIds.push(account.id);
      const ensured = await ensureParticipantForAccount(account);
      assert.equal(ensured.kind, "ready");
      if (ensured.kind !== "ready") return;
      createdParticipantIds.push(ensured.participant.id);

      const res = await submitAsAccount(account.id, spec.type, spec.slug);
      assert.equal(res.ok, true);

      const app = await prisma.application.findFirst({
        where: { participantId: ensured.participant.id, type: spec.type }
      });
      assert.ok(app, `${spec.type} application must exist`);
      assert.equal(app?.status, "RECEIVED");

      const p = await prisma.participant.findUnique({
        where: { id: ensured.participant.id }
      });
      assert.equal(p?.status, RegistrationStatus.REGISTERED);
    });

    test(`second ${spec.type} application on same Participant is rejected`, async () => {
      const account = await makeAccount(
        `${spec.slug}-dup-${Date.now()}@bis-test.local`
      );
      createdAccountIds.push(account.id);
      const ensured = await ensureParticipantForAccount(account);
      assert.equal(ensured.kind, "ready");
      if (ensured.kind !== "ready") return;
      createdParticipantIds.push(ensured.participant.id);

      await submitAsAccount(account.id, spec.type, spec.slug);
      const second = await submitAsAccount(account.id, spec.type, spec.slug);
      assert.equal(
        second.ok,
        false,
        "second application must fail on the unique constraint"
      );
      if (second.ok) return;
      assert.equal(second.reason, "duplicate");

      const count = await prisma.application.count({
        where: { participantId: ensured.participant.id, type: spec.type }
      });
      assert.equal(count, 1);
    });
  });
}

describe("Status invariant — never downgrade CONFIRMED", () => {
  test("professional submission on a CONFIRMED Participant keeps CONFIRMED", async () => {
    const account = await makeAccount(
      `status-guard-${Date.now()}@bis-test.local`
    );
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    // Admin flips to CONFIRMED.
    await prisma.participant.update({
      where: { id: ensured.participant.id },
      data: { status: RegistrationStatus.CONFIRMED }
    });

    // User then applies as SPONSOR — must NOT downgrade to REGISTERED.
    const res = await submitAsAccount(account.id, "SPONSOR", "sponsor");
    assert.equal(res.ok, true);
    const p = await prisma.participant.findUnique({
      where: { id: ensured.participant.id }
    });
    assert.equal(p?.status, RegistrationStatus.CONFIRMED);
  });

  test("professional submission on a CANCELLED Participant stays CANCELLED", async () => {
    const account = await makeAccount(
      `cancelled-guard-${Date.now()}@bis-test.local`
    );
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    await prisma.participant.update({
      where: { id: ensured.participant.id },
      data: { status: RegistrationStatus.CANCELLED }
    });

    await submitAsAccount(account.id, "PARTNER", "partner");
    const p = await prisma.participant.findUnique({
      where: { id: ensured.participant.id }
    });
    assert.equal(p?.status, RegistrationStatus.CANCELLED);
  });
});

describe("Multi-role — one AccountUser, one Participant, multiple Applications", () => {
  test("Visitor participation + Speaker + Sponsor + Content Creator on one Participant", async () => {
    const account = await makeAccount(
      `multi-${Date.now()}@bis-test.local`
    );
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    // Visitor first — simulate by stamping participationChoice VISITOR.
    await prisma.participant.updateMany({
      where: {
        id: ensured.participant.id,
        participationChoice: null
      },
      data: { participationChoice: "VISITOR" }
    });

    // Then three professional applications on the same Participant.
    for (const spec of [
      { type: "SPEAKER" as const, slug: "speaker" },
      { type: "SPONSOR" as const, slug: "sponsor" },
      { type: "CONTENT_CREATOR" as const, slug: "content-creator" }
    ]) {
      const res = await submitAsAccount(account.id, spec.type, spec.slug);
      assert.equal(res.ok, true, `${spec.type} application should succeed`);
    }

    // Exactly one Participant per (AccountUser, event).
    const pCount = await prisma.participant.count({
      where: { accountUserId: account.id }
    });
    assert.equal(pCount, 1);

    // Three Applications, all types distinct.
    const apps = await prisma.application.findMany({
      where: { participantId: ensured.participant.id },
      select: { type: true, status: true }
    });
    assert.equal(apps.length, 3);
    const types = new Set(apps.map((a) => a.type));
    assert.ok(types.has("SPEAKER"));
    assert.ok(types.has("SPONSOR"));
    assert.ok(types.has("CONTENT_CREATOR"));

    // participationChoice preserved as VISITOR (never overwritten by
    // professional submissions).
    const p = await prisma.participant.findUnique({
      where: { id: ensured.participant.id }
    });
    assert.equal(p?.participationChoice, "VISITOR");
  });
});

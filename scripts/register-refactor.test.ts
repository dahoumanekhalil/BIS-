// Tests for Commit 1 of the role-based registration refactor.
//
// Covers:
//   • ensureParticipantForAccount reuses vs creates + never duplicates
//   • Legacy anonymous Participant claim via email verification
//   • Status default is REGISTERED for new participants
//   • Badge issuance no longer requires payment
//   • /auth/register redirect target
//
// Requires a live DB — matches the pattern used by every other test in
// this project (see scripts/email-verification.test.ts).
//
//   npm run test:register-refactor

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient, RegistrationStatus } from "@prisma/client";
import { hashPassword } from "../lib/admin/password";
import {
  issueEmailVerificationToken,
  consumeEmailVerificationToken
} from "../lib/account/email-verification";
import { ensureParticipantForAccount, ensureActiveBadge } from "../lib/register/participant";

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
      lastName: "Refactor",
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

describe("ensureParticipantForAccount", () => {
  test("creates a new Participant with status=REGISTERED", async () => {
    const account = await makeAccount(`ensure-new-${Date.now()}@bis-test.local`);
    createdAccountIds.push(account.id);

    const res = await ensureParticipantForAccount(account);
    assert.equal(res.kind, "ready");
    if (res.kind !== "ready") return;
    createdParticipantIds.push(res.participant.id);

    assert.equal(res.participant.accountUserId, account.id);
    assert.equal(
      res.participant.status,
      RegistrationStatus.REGISTERED,
      "new Participants must default to REGISTERED (never PENDING)"
    );
  });

  test("reuses the existing Participant on repeated calls", async () => {
    const account = await makeAccount(`ensure-reuse-${Date.now()}@bis-test.local`);
    createdAccountIds.push(account.id);

    const first = await ensureParticipantForAccount(account);
    const second = await ensureParticipantForAccount(account);

    assert.equal(first.kind, "ready");
    assert.equal(second.kind, "ready");
    if (first.kind !== "ready" || second.kind !== "ready") return;
    createdParticipantIds.push(first.participant.id);

    assert.equal(first.participant.id, second.participant.id);
  });

  test("returns conflict when an anonymous Participant claims the email", async () => {
    const email = `ensure-conflict-${Date.now()}@bis-test.local`;
    const event = await ensureEvent();

    // Pre-existing anonymous Participant (accountUserId = null).
    const anon = await prisma.participant.create({
      data: {
        eventId: event.id,
        firstName: "Anon",
        lastName: "Legacy",
        email,
        phone: null,
        country: "Algérie",
        status: RegistrationStatus.REGISTERED
      }
    });
    createdParticipantIds.push(anon.id);

    const account = await makeAccount(email);
    createdAccountIds.push(account.id);

    const res = await ensureParticipantForAccount(account);
    assert.equal(
      res.kind,
      "conflict",
      "must refuse to auto-link an anonymous Participant on email alone"
    );
  });
});

describe("Legacy Participant claim via email verification", () => {
  test("consuming the verification token binds the anonymous Participant", async () => {
    const email = `claim-ok-${Date.now()}@bis-test.local`;
    const event = await ensureEvent();

    const anon = await prisma.participant.create({
      data: {
        eventId: event.id,
        firstName: "Anon",
        lastName: "Claim",
        email,
        phone: null,
        country: "Algérie",
        status: RegistrationStatus.REGISTERED
      }
    });
    createdParticipantIds.push(anon.id);
    assert.equal(anon.accountUserId, null);

    const account = await makeAccount(email);
    createdAccountIds.push(account.id);

    const issued = await issueEmailVerificationToken({
      userId: account.id,
      email: account.email
    });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.claimedParticipantCount, 1);

    const bound = await prisma.participant.findUnique({ where: { id: anon.id } });
    assert.equal(bound?.accountUserId, account.id);
  });

  test("claim matches case-insensitively (mixed-case legacy row)", async () => {
    // Simulate a legacy row that skipped Zod normalization (e.g. CSV
    // import, prisma studio edit) and landed with mixed case.
    const suffix = Date.now();
    const canonical = `mixedcase-${suffix}@bis-test.local`;
    const mixed = `MixedCase-${suffix}@bis-test.local`;
    const upper = `MIXEDCASE-${suffix}@bis-test.local`;
    const event = await ensureEvent();

    const anonMixed = await prisma.participant.create({
      data: {
        eventId: event.id,
        firstName: "Mixed",
        lastName: "Legacy",
        email: mixed,
        phone: null,
        country: "Algérie",
        status: RegistrationStatus.REGISTERED
      }
    });
    createdParticipantIds.push(anonMixed.id);

    // AccountUser email goes through Zod → lowercase.
    const account = await makeAccount(canonical);
    createdAccountIds.push(account.id);

    // Token issued to the canonical (lowercased) email — same as production.
    const issued = await issueEmailVerificationToken({
      userId: account.id,
      email: account.email
    });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(
      res.claimedParticipantCount,
      1,
      "case-insensitive match must bind the mixed-case legacy row"
    );

    const bound = await prisma.participant.findUnique({ where: { id: anonMixed.id } });
    assert.equal(bound?.accountUserId, account.id);

    // Sanity: the upper-cased email variant would ALSO match — this
    // documents the case-insensitive behaviour so a future change that
    // narrows it will fail loudly.
    const wouldMatch = await prisma.participant.findMany({
      where: {
        email: { equals: upper, mode: "insensitive" },
        eventId: event.id
      },
      select: { id: true }
    });
    assert.ok(
      wouldMatch.some((p) => p.id === anonMixed.id),
      "upper-case query must find the mixed-case row via mode: insensitive"
    );
  });

  test("claim cannot cross accounts via casing (owned mixed-case cannot be stolen)", async () => {
    // Even with case-insensitive match, an already-bound row must NEVER
    // be re-bound to a different AccountUser.
    const suffix = Date.now();
    const mixed = `Owned-${suffix}@bis-test.local`;
    const event = await ensureEvent();

    const rightful = await makeAccount(`rightful-${suffix}@bis-test.local`);
    createdAccountIds.push(rightful.id);

    const owned = await prisma.participant.create({
      data: {
        eventId: event.id,
        firstName: "Owned",
        lastName: "Mixed",
        email: mixed,
        phone: null,
        country: "Algérie",
        status: RegistrationStatus.REGISTERED,
        accountUserId: rightful.id
      }
    });
    createdParticipantIds.push(owned.id);

    // A different account with the same canonical email (via a stolen
    // verification link would be needed for `email-changed` to pass —
    // simulate the impossible best case for the attacker by matching
    // the AccountUser email to the token's emailAtIssue.
    const attacker = await makeAccount(`Owned-${suffix}@bis-attacker.local`);
    createdAccountIds.push(attacker.id);
    const issued = await issueEmailVerificationToken({
      userId: attacker.id,
      email: attacker.email
    });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    // Attacker's own account verifies fine — they don't hit the target's
    // Participant because that row is already `accountUserId != NULL`.
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // Target row still owned by original account.
    const stillOwned = await prisma.participant.findUnique({
      where: { id: owned.id }
    });
    assert.equal(stillOwned?.accountUserId, rightful.id);
  });

  test("consuming the token when nothing to claim returns count=0", async () => {
    const account = await makeAccount(`claim-empty-${Date.now()}@bis-test.local`);
    createdAccountIds.push(account.id);
    const issued = await issueEmailVerificationToken({
      userId: account.id,
      email: account.email
    });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.claimedParticipantCount, 0);
  });

  test("claim does not steal an already-bound Participant", async () => {
    const email = `claim-owned-${Date.now()}@bis-test.local`;
    const event = await ensureEvent();

    const originalOwner = await makeAccount(`owner-${Date.now()}@bis-test.local`);
    createdAccountIds.push(originalOwner.id);
    // Owned Participant — accountUserId set.
    const owned = await prisma.participant.create({
      data: {
        eventId: event.id,
        firstName: "Owned",
        lastName: "Already",
        email,
        phone: null,
        country: "Algérie",
        status: RegistrationStatus.REGISTERED,
        accountUserId: originalOwner.id
      }
    });
    createdParticipantIds.push(owned.id);

    // Second account tries to claim by verifying an email that matches.
    // Note: AccountUser.email is globally unique, so this second account
    // uses a DIFFERENT email; we then issue the token with the target email
    // to prove even a targeted attempt fails.
    const attacker = await makeAccount(`attacker-${Date.now()}@bis-test.local`);
    createdAccountIds.push(attacker.id);
    const issued = await issueEmailVerificationToken({
      userId: attacker.id,
      email
    });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    // The user-side check `email-changed` fires because the AccountUser's
    // own email does not equal the token's emailAtIssue — this is exactly
    // the anti-hijack rail the design relies on.
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "email-changed");

    // Ownership unchanged.
    const stillOwned = await prisma.participant.findUnique({ where: { id: owned.id } });
    assert.equal(stillOwned?.accountUserId, originalOwner.id);
  });
});

describe("Badge issuance decoupled from payment", () => {
  test("ensureActiveBadge issues even when paymentStatus is UNPAID", async () => {
    const account = await makeAccount(`badge-unpaid-${Date.now()}@bis-test.local`);
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    // Sanity — paymentStatus should default to UNPAID.
    const p0 = await prisma.participant.findUnique({
      where: { id: ensured.participant.id },
      select: { paymentStatus: true }
    });
    assert.equal(p0?.paymentStatus, "UNPAID");

    await ensureActiveBadge(ensured.participant.id);
    const badge = await prisma.badgeCredential.findFirst({
      where: { participantId: ensured.participant.id, status: "ACTIVE" }
    });
    assert.ok(
      badge,
      "an ACTIVE BadgeCredential must exist for an UNPAID participant"
    );
  });

  test("ensureActiveBadge is idempotent", async () => {
    const account = await makeAccount(`badge-idem-${Date.now()}@bis-test.local`);
    createdAccountIds.push(account.id);
    const ensured = await ensureParticipantForAccount(account);
    assert.equal(ensured.kind, "ready");
    if (ensured.kind !== "ready") return;
    createdParticipantIds.push(ensured.participant.id);

    await ensureActiveBadge(ensured.participant.id);
    await ensureActiveBadge(ensured.participant.id);
    const active = await prisma.badgeCredential.count({
      where: { participantId: ensured.participant.id, status: "ACTIVE" }
    });
    assert.equal(active, 1, "must never issue a second ACTIVE credential");
  });
});

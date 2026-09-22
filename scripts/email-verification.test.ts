// Tests for lib/account/email-verification. Requires a live DB.
//   npm run test:email-verification

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  issueEmailVerificationToken,
  consumeEmailVerificationToken
} from "../lib/account/email-verification";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

async function createUser(email: string) {
  return prisma.accountUser.create({
    data: {
      email,
      firstName: "Test",
      lastName: "Verify",
      passwordHash: hashPassword("hunter2-test-password")
    },
    select: { id: true, email: true }
  });
}

const createdIds: string[] = [];

after(async () => {
  if (createdIds.length > 0) {
    await prisma.accountUser
      .deleteMany({ where: { id: { in: createdIds } } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("email verification tokens", () => {
  test("issue → consume marks the user verified", async () => {
    const user = await createUser(`verify-ok-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issueEmailVerificationToken({
      userId: user.id,
      email: user.email
    });
    assert.ok(issued.rawToken.length > 20, "rawToken should be non-trivial");

    const before = await prisma.accountUser.findUnique({
      where: { id: user.id },
      select: { emailVerifiedAt: true }
    });
    assert.equal(before?.emailVerifiedAt, null);

    const res = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(res.ok, true);

    const after = await prisma.accountUser.findUnique({
      where: { id: user.id },
      select: { emailVerifiedAt: true }
    });
    assert.notEqual(after?.emailVerifiedAt, null);
  });

  test("consuming an already-consumed token fails with reason=used", async () => {
    const user = await createUser(`verify-used-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issueEmailVerificationToken({
      userId: user.id,
      email: user.email
    });
    await consumeEmailVerificationToken(issued.rawToken);
    const second = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "used");
  });

  test("consuming an expired token fails with reason=expired", async () => {
    const user = await createUser(`verify-expired-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issueEmailVerificationToken({
      userId: user.id,
      email: user.email
    });
    // Force-expire.
    await prisma.emailVerificationToken.update({
      where: { tokenHash: issued.tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "expired");
  });

  test("consuming a garbage token fails with reason=invalid", async () => {
    const res = await consumeEmailVerificationToken("this-is-not-a-real-token");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid");
  });

  test("email change after issue → token is rejected", async () => {
    const user = await createUser(`verify-changed-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issueEmailVerificationToken({
      userId: user.id,
      email: user.email
    });
    // Simulate the user changing their email before clicking the link.
    await prisma.accountUser.update({
      where: { id: user.id },
      data: { email: `changed-${Date.now()}@bis-test.local` }
    });
    const res = await consumeEmailVerificationToken(issued.rawToken);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "email-changed");
  });

  test("tokenHash is not the raw token", async () => {
    const user = await createUser(`verify-hash-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issueEmailVerificationToken({
      userId: user.id,
      email: user.email
    });
    assert.notEqual(issued.tokenHash, issued.rawToken);
    // The DB row stores only the hash.
    const row = await prisma.emailVerificationToken.findUnique({
      where: { tokenHash: issued.tokenHash }
    });
    assert.ok(row);
    // Sanity: no field on the row equals the raw token.
    const raw = issued.rawToken;
    for (const v of Object.values(row!)) {
      if (typeof v === "string") assert.notEqual(v, raw);
    }
  });
});

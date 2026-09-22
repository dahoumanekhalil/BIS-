// Tests for lib/account/password-reset. Requires a live DB.
//   npm run test:password-reset

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";
import {
  issuePasswordResetToken,
  validatePasswordResetToken,
  consumeAndSetPassword
} from "../lib/account/password-reset";
import { hashPassword, verifyPassword } from "../lib/admin/password";

// Local session-creation helper. The production `createAccountSession()`
// lives in lib/account/auth.ts which module-level-imports next/navigation
// — under the `react-server` condition that needs Next.js runtime and blows
// up in a standalone `node --test` process. Since this test only needs a
// row in AccountSession to prove that the reset destroys it, we insert
// directly rather than pulling in the Next.js-flavoured helper.
async function seedAccountSession(prisma: PrismaClient, userId: string) {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  return prisma.accountSession.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60)
    }
  });
}

const prisma = new PrismaClient();

async function createUser(email: string) {
  return prisma.accountUser.create({
    data: {
      email,
      firstName: "Test",
      lastName: "Reset",
      passwordHash: hashPassword("original-password-1")
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

describe("password reset tokens", () => {
  test("issue → validate → consume path updates password + invalidates sessions", async () => {
    const user = await createUser(`reset-ok-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);

    // Give the user a session — must be destroyed by consume.
    await seedAccountSession(prisma, user.id);
    const before = await prisma.accountSession.count({
      where: { userId: user.id }
    });
    assert.ok(before >= 1);

    const issued = await issuePasswordResetToken({ userId: user.id, requestIp: "10.0.0.1" });
    const validate = await validatePasswordResetToken(issued.rawToken);
    assert.equal(validate.ok, true);

    const newHash = hashPassword("new-password-2");
    const consume = await consumeAndSetPassword({
      rawToken: issued.rawToken,
      newPasswordHash: newHash
    });
    assert.equal(consume.ok, true);

    const user2 = await prisma.accountUser.findUnique({
      where: { id: user.id },
      select: { passwordHash: true }
    });
    assert.ok(user2);
    assert.equal(verifyPassword("new-password-2", user2!.passwordHash), true);
    assert.equal(verifyPassword("original-password-1", user2!.passwordHash), false);

    const sessions = await prisma.accountSession.count({
      where: { userId: user.id }
    });
    assert.equal(sessions, 0, "all sessions should be destroyed on reset");
  });

  test("consuming twice fails on the second attempt", async () => {
    const user = await createUser(`reset-twice-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issuePasswordResetToken({ userId: user.id });
    const a = await consumeAndSetPassword({
      rawToken: issued.rawToken,
      newPasswordHash: hashPassword("new-1")
    });
    assert.equal(a.ok, true);
    const b = await consumeAndSetPassword({
      rawToken: issued.rawToken,
      newPasswordHash: hashPassword("new-2")
    });
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.reason, "used");
  });

  test("expired token fails to consume", async () => {
    const user = await createUser(`reset-expired-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issuePasswordResetToken({ userId: user.id });
    await prisma.passwordResetToken.update({
      where: { tokenHash: issued.tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    const res = await consumeAndSetPassword({
      rawToken: issued.rawToken,
      newPasswordHash: hashPassword("x")
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "expired");
  });

  test("second outstanding reset token is invalidated by first successful consume", async () => {
    const user = await createUser(`reset-multi-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const first = await issuePasswordResetToken({ userId: user.id });
    const second = await issuePasswordResetToken({ userId: user.id });
    const a = await consumeAndSetPassword({
      rawToken: first.rawToken,
      newPasswordHash: hashPassword("via-first")
    });
    assert.equal(a.ok, true);
    // The second, previously-valid token must be invalidated now.
    const b = await consumeAndSetPassword({
      rawToken: second.rawToken,
      newPasswordHash: hashPassword("via-second")
    });
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.reason, "used");
  });

  test("garbage token fails with reason=invalid", async () => {
    const res = await consumeAndSetPassword({
      rawToken: "definitely-not-real",
      newPasswordHash: hashPassword("x")
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid");
  });

  test("requestIp is truncated to /24 in DB", async () => {
    const user = await createUser(`reset-ip-${Date.now()}@bis-test.local`);
    createdIds.push(user.id);
    const issued = await issuePasswordResetToken({
      userId: user.id,
      requestIp: "203.0.113.45"
    });
    const row = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: issued.tokenHash },
      select: { requestIp: true }
    });
    assert.equal(row?.requestIp, "203.0.113.0");
  });
});

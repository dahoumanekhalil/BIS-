// End-to-end test of the email worker + queue in log-only mode. Requires
// a live DB. Uses a randomly generated EMAIL_SECRET_ENCRYPTION_KEY so the
// test does not depend on a specific deployment secret.
//
//   npm run test:email-worker

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { EmailStatus, PrismaClient } from "@prisma/client";

const originalKey = process.env.EMAIL_SECRET_ENCRYPTION_KEY;

before(() => {
  process.env.EMAIL_SECRET_ENCRYPTION_KEY =
    process.env.EMAIL_SECRET_ENCRYPTION_KEY ||
    randomBytes(32).toString("base64url");
  // Force log-only in case the deployment env has real SMTP configured.
  process.env.EMAIL_MODE = "log-only";
  process.env.SMTP_HOST = process.env.SMTP_HOST || "smtp.example.com";
  process.env.SMTP_PORT = process.env.SMTP_PORT || "587";
  process.env.SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || "no-reply@example.com";
  process.env.SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || "BIS 2027 Test";
});

after(() => {
  if (originalKey === undefined) {
    delete process.env.EMAIL_SECRET_ENCRYPTION_KEY;
  } else {
    process.env.EMAIL_SECRET_ENCRYPTION_KEY = originalKey;
  }
  delete process.env.EMAIL_MODE;
});

const prisma = new PrismaClient();
const createdIds: string[] = [];

after(async () => {
  if (createdIds.length > 0) {
    await prisma.emailMessage
      .deleteMany({ where: { id: { in: createdIds } } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("email worker + queue", async () => {
  const { queueTemplatedEmail } = await import("../lib/email/queue");
  const {
    processQueue,
    drainQueueForTests,
    __resetStaleCleanupGateForTests
  } = await import("../lib/email/worker");

  test("queueTemplatedEmail creates a QUEUED row", async () => {
    const q = await queueTemplatedEmail({
      templateKey: "welcome",
      to: "test-queue@example.com",
      vars: {
        firstName: "Ada",
        lastName: "Lovelace",
        fullName: "Ada Lovelace",
        email: "test-queue@example.com",
        tier: "STANDARD",
        eventDate: "3-5 jan 2027",
        eventVenue: "CIC Alger"
      }
    });
    assert.equal(q.ok, true);
    if (q.ok) createdIds.push(q.id);
    const row = q.ok
      ? await prisma.emailMessage.findUnique({ where: { id: q.id } })
      : null;
    assert.ok(row);
    // Might have been immediately processed by the fire-and-forget worker
    // in log-only mode — accept either QUEUED or SENT.
    assert.ok(row!.status === EmailStatus.QUEUED || row!.status === EmailStatus.SENT);
  });

  test("processQueue marks rows SENT in log-only mode", async () => {
    __resetStaleCleanupGateForTests();
    const q = await queueTemplatedEmail({
      templateKey: "welcome",
      to: "test-process@example.com",
      vars: {
        firstName: "Grace",
        lastName: "Hopper",
        fullName: "Grace Hopper",
        email: "test-process@example.com",
        tier: "STANDARD",
        eventDate: "3-5 jan 2027",
        eventVenue: "CIC Alger"
      }
    });
    assert.equal(q.ok, true);
    if (q.ok) createdIds.push(q.id);
    // Drain instead of a single processQueue() call — a fire-and-forget
    // tick from the previous test may still be in flight, and we want
    // our row to be picked up by the follow-up chain the worker schedules.
    await drainQueueForTests();
    const row = q.ok
      ? await prisma.emailMessage.findUnique({ where: { id: q.id } })
      : null;
    assert.equal(row?.status, EmailStatus.SENT);
    assert.equal(row?.provider, "log-only");
    assert.notEqual(row?.sentAt, null);
  });

  test("idempotency key deduplicates a second enqueue", async () => {
    const key = `test-idem-${Date.now()}`;
    const first = await queueTemplatedEmail({
      templateKey: "welcome",
      to: "test-idem@example.com",
      idempotencyKey: key,
      vars: {
        firstName: "Rear",
        lastName: "Admiral",
        fullName: "Rear Admiral",
        email: "test-idem@example.com",
        tier: "STANDARD",
        eventDate: "3-5 jan 2027",
        eventVenue: "CIC Alger"
      }
    });
    assert.equal(first.ok, true);
    if (first.ok) createdIds.push(first.id);
    const second = await queueTemplatedEmail({
      templateKey: "welcome",
      to: "test-idem@example.com",
      idempotencyKey: key,
      vars: {
        firstName: "Rear",
        lastName: "Admiral",
        fullName: "Rear Admiral",
        email: "test-idem@example.com",
        tier: "STANDARD",
        eventDate: "3-5 jan 2027",
        eventVenue: "CIC Alger"
      }
    });
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.id, second.id, "second call should return the first row's id");
      assert.equal(second.deduped, true);
    }
  });

  test("stale-cleanup marks a > 7-day-old QUEUED row as FAILED", async () => {
    // Insert a row directly with an old createdAt.
    const stale = await prisma.emailMessage.create({
      data: {
        toEmail: "stale@example.com",
        subject: "Old",
        body: "Old body",
        html: null,
        status: EmailStatus.QUEUED,
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      }
    });
    createdIds.push(stale.id);
    __resetStaleCleanupGateForTests();
    // Drain so any in-flight tick from the previous test settles before
    // we assert; the stale-cleanup runs on the FIRST tick after the gate
    // reset, which the follow-up chain guarantees will fire.
    await drainQueueForTests();
    const after = await prisma.emailMessage.findUnique({
      where: { id: stale.id }
    });
    assert.equal(after?.status, EmailStatus.FAILED);
    assert.match(
      after?.lastError ?? "",
      /Stale queued email/
    );
  });
});

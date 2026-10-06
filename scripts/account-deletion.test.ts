// Self-service account deletion (store requirement).
//   npm run test:account-deletion      (needs a THROWAWAY database)

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ApplicationType, PrismaClient, RegistrationStatus } from "@prisma/client";
import { deleteAccountData } from "../lib/account/delete-account";
import { issueBadgeCredential, verifyBadgeToken } from "../lib/badge";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();
process.env.BADGE_QR_TOKEN_SECRET ??=
  "test-only-badge-qr-secret-0123456789abcdef0123456789abcdef";

let eventId: string;
const dbName = (() => {
  try { return new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", ""); } catch { return ""; }
})();

before(async () => {
  assert.ok(dbName.includes("test"), `refusing to run on "${dbName}" (needs a throwaway *test* database)`);
  const ev = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  assert.ok(ev, "run the seed or create an event first");
  eventId = ev.id;
});

after(async () => {
  await prisma.$disconnect();
});

async function scenario(tag: string) {
  const email = `deltest-${tag}-${Date.now()}@bis.dz`;
  const other = await prisma.accountUser.create({
    data: { email: `deltest-other-${tag}-${Date.now()}@bis.dz`, firstName: "Other", lastName: "Person", passwordHash: hashPassword("x-test-only") }
  });
  const acct = await prisma.accountUser.create({
    data: { email, firstName: "Del", lastName: "Etest", passwordHash: hashPassword("x-test-only"), emailVerifiedAt: new Date() }
  });
  await prisma.accountSession.create({
    data: { userId: acct.id, tokenHash: `deltest-${tag}-${Math.random()}`, expiresAt: new Date(Date.now() + 3600e3) }
  });
  const p = await prisma.participant.create({
    data: { eventId, accountUserId: acct.id, firstName: "Del", lastName: "Etest", email, phone: "0555000111", organization: "Acme", status: RegistrationStatus.CONFIRMED }
  });
  const otherP = await prisma.participant.create({
    data: { eventId, accountUserId: other.id, firstName: "Other", lastName: "Person", email: other.email, status: RegistrationStatus.CONFIRMED }
  });
  const cred = await issueBadgeCredential(p.id);
  const otherCred = await issueBadgeCredential(otherP.id);
  const checkIn = await prisma.checkIn.create({
    data: { participantId: p.id, credentialId: cred.credentialId, ticketCode: "", gate: "main", result: "VALID" }
  });
  const app = await prisma.application.create({
    data: {
      eventId, participantId: p.id, type: ApplicationType.SPONSOR,
      firstName: "Del", lastName: "Etest", email, phone: "0555000111",
      organization: "Acme", website: "https://acme.example", linkedin: "https://linkedin.example/x",
      message: "private note", details: { contactDirect: "0555000111" }
    }
  });
  const mail = await prisma.emailMessage.create({
    data: { participantId: p.id, toEmail: email, toName: "Del Etest", subject: "Bienvenue Del", body: "Bonjour Del Etest", html: "<p>Del</p>", status: "SENT" }
  });
  const strayMail = await prisma.emailMessage.create({
    data: { toEmail: email.toUpperCase(), subject: "Auth mail", body: "lien", status: "SENT" }
  });
  return { acct, other, p, otherP, cred, otherCred, checkIn, app, mail, strayMail, email };
}

describe("deleteAccountData", () => {
  test("erases the person, keeps business/anonymous records, never touches others", async () => {
    const s = await scenario("a");
    const res = await deleteAccountData(s.acct.id);
    assert.deepEqual(res, { participants: 1, applications: 1, emails: 2 });

    // Account + sessions + participant gone.
    assert.equal(await prisma.accountUser.findUnique({ where: { id: s.acct.id } }), null);
    assert.equal(await prisma.accountSession.count({ where: { userId: s.acct.id } }), 0);
    assert.equal(await prisma.participant.findUnique({ where: { id: s.p.id } }), null);

    // QR is dead immediately (credential row cascaded away).
    const v = await verifyBadgeToken(s.cred.rawToken);
    assert.ok(!v.ok && v.reason === "INVALID");

    // Check-in history kept, detached from the person.
    const ci = await prisma.checkIn.findUniqueOrThrow({ where: { id: s.checkIn.id } });
    assert.equal(ci.participantId, null);
    assert.equal(ci.gate, "main");

    // Application anonymised, business record kept.
    const app = await prisma.application.findUniqueOrThrow({ where: { id: s.app.id } });
    assert.equal(app.type, "SPONSOR");
    assert.equal(app.organization, "Acme");
    assert.equal(app.participantId, null);
    const flat = JSON.stringify(app);
    for (const pii of ["Del", "Etest", "0555000111", s.email, "private note", "linkedin.example", "acme.example"]) {
      assert.equal(flat.includes(pii), false, `application still contains ${pii}`);
    }

    // E-mail log anonymised (both the linked one and the stray one by address, case-insensitive).
    for (const id of [s.mail.id, s.strayMail.id]) {
      const m = await prisma.emailMessage.findUniqueOrThrow({ where: { id } });
      const f = JSON.stringify(m);
      assert.equal(f.includes(s.email.toLowerCase()), false);
      assert.equal(f.includes("Del"), false);
      assert.equal(m.toEmail, "deleted@anonymized.invalid");
    }

    // Audit: counts only, no PII.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "account.self-delete", entityId: s.acct.id } });
    const lf = JSON.stringify(log);
    assert.equal(lf.includes(s.email), false);
    assert.equal(lf.includes("Etest"), false);

    // Someone else is untouched.
    assert.ok(await prisma.accountUser.findUnique({ where: { id: s.other.id } }));
    assert.ok(await prisma.participant.findUnique({ where: { id: s.otherP.id } }));
    assert.ok((await verifyBadgeToken(s.otherCred.rawToken)).ok);

    await prisma.participant.deleteMany({ where: { id: s.otherP.id } });
    await prisma.accountUser.delete({ where: { id: s.other.id } });
  });

  test("is all-or-nothing: a failure rolls everything back", async () => {
    const s = await scenario("b");
    // Break the transaction at its last step: a trigger that rejects the audit row.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION deltest_block() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'blocked'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER deltest_block_trg BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW.action = 'account.self-delete') EXECUTE FUNCTION deltest_block()`);
    try {
      await assert.rejects(() => deleteAccountData(s.acct.id));
      assert.ok(await prisma.accountUser.findUnique({ where: { id: s.acct.id } }), "account still exists");
      assert.ok(await prisma.participant.findUnique({ where: { id: s.p.id } }), "participant still exists");
      const app = await prisma.application.findUniqueOrThrow({ where: { id: s.app.id } });
      assert.equal(app.firstName, "Del", "application NOT anonymised");
      assert.ok((await verifyBadgeToken(s.cred.rawToken)).ok, "QR still valid");
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS deltest_block_trg ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS deltest_block()`);
    }
    await deleteAccountData(s.acct.id);
    await prisma.participant.deleteMany({ where: { id: s.otherP.id } });
    await prisma.accountUser.delete({ where: { id: s.other.id } });
  });

  test("SECURITY: an UNVERIFIED account cannot erase a stranger's records by sharing their email", async () => {
    const victimEmail = `deltest-victim-${Date.now()}@bis.dz`;
    // The victim's real records (no account), same address.
    const victimP = await prisma.participant.create({
      data: { eventId, firstName: "Vic", lastName: "Tim", email: victimEmail, status: RegistrationStatus.CONFIRMED }
    });
    const victimApp = await prisma.application.create({
      data: { eventId, participantId: victimP.id, type: ApplicationType.SPEAKER, firstName: "Vic", lastName: "Tim", email: victimEmail, phone: "0666", details: {} }
    });
    const victimMail = await prisma.emailMessage.create({
      data: { toEmail: victimEmail, subject: "Important", body: "keep me", status: "SENT" }
    });
    // Attacker registers with the victim's address but never verifies it.
    const attacker = await prisma.accountUser.create({
      data: { email: victimEmail.toUpperCase(), firstName: "Evil", lastName: "Actor", passwordHash: hashPassword("x-test-only") }
    });
    const res = await deleteAccountData(attacker.id);
    assert.deepEqual(res, { participants: 0, applications: 0, emails: 0 });
    assert.ok(await prisma.participant.findUnique({ where: { id: victimP.id } }), "victim participant survives");
    assert.equal((await prisma.application.findUniqueOrThrow({ where: { id: victimApp.id } })).firstName, "Vic");
    assert.equal((await prisma.emailMessage.findUniqueOrThrow({ where: { id: victimMail.id } })).body, "keep me");
    await prisma.application.delete({ where: { id: victimApp.id } });
    await prisma.emailMessage.delete({ where: { id: victimMail.id } });
    await prisma.participant.delete({ where: { id: victimP.id } });
  });

  test("a VERIFIED owner also erases their own unclaimed registration; kept check-ins are fully anonymous", async () => {
    const email = `deltest-claimless-${Date.now()}@bis.dz`;
    const acct = await prisma.accountUser.create({
      data: { email, firstName: "Own", lastName: "Er", passwordHash: hashPassword("x-test-only"), emailVerifiedAt: new Date() }
    });
    const unclaimed = await prisma.participant.create({
      data: { eventId, firstName: "Own", lastName: "Er", email, status: RegistrationStatus.CONFIRMED }
    });
    const ci = await prisma.checkIn.create({
      data: { participantId: unclaimed.id, ticketCode: "K4MX-92QT-A7RN", gate: "main", result: "VALID", reason: "FIRST_SCAN Own Er" }
    });
    const res = await deleteAccountData(acct.id);
    assert.equal(res.participants, 1);
    assert.equal(await prisma.participant.findUnique({ where: { id: unclaimed.id } }), null);
    const kept = await prisma.checkIn.findUniqueOrThrow({ where: { id: ci.id } });
    assert.equal(kept.participantId, null);
    assert.equal(kept.ticketCode, "");
    assert.equal(kept.reason, null);
    assert.equal(kept.gate, "main");
  });

  test("account without a participant is deleted cleanly", async () => {
    const acct = await prisma.accountUser.create({
      data: { email: `deltest-solo-${Date.now()}@bis.dz`, firstName: "Solo", lastName: "User", passwordHash: hashPassword("x-test-only") }
    });
    const res = await deleteAccountData(acct.id);
    assert.deepEqual(res, { participants: 0, applications: 0, emails: 0 });
    assert.equal(await prisma.accountUser.findUnique({ where: { id: acct.id } }), null);
  });

  test("unknown account fails without side effects", async () => {
    await assert.rejects(() => deleteAccountData("no-such-account"), /ACCOUNT_NOT_FOUND/);
  });
});

describe("deleteMyAccount action — structure", () => {
  test("requires the session, password + typed confirmation, throttling, and ends the session", async () => {
    const src = (await readFile(new URL("../app/actions/account.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    const fn = src.slice(src.indexOf("export async function deleteMyAccount("));
    assert.ok(fn.includes("await requireAccount()"));
    assert.ok(fn.includes("verifyPassword("));
    assert.ok(src.includes('z.literal("SUPPRIMER")'));
    assert.ok(fn.includes("isBlocked(acctKey") && fn.includes("record(acctKey)"));
    assert.ok(fn.includes("deleteAccountData(account.id)"), "identity from the session, never from input");
    assert.ok(fn.indexOf("destroyAccountSession") > fn.indexOf("deleteAccountData"));
  });

  test("security page exposes the delete card; privacy page exists and is linked", async () => {
    const sec = await readFile(new URL("../app/compte/securite/page.tsx", import.meta.url), "utf8");
    assert.ok(sec.includes("DeleteAccountCard"));
    const priv = await readFile(new URL("../app/confidentialite/page.tsx", import.meta.url), "utf8");
    assert.ok(priv.includes("Supprimer mon compte"));
    const footer = await readFile(new URL("../components/layout/footer.tsx", import.meta.url), "utf8");
    assert.ok(footer.includes("/confidentialite"));
  });
});

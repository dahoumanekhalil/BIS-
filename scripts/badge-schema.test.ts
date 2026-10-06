// Verifies the database-level QR invariants exist on the target database.
// These used to depend on a manual script; they are now part of the managed
// schema delta (prisma/sql/2026-badge-persistent-qr.sql).
//
//   npm run test:badge-schema      (also run it against production!)

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
after(async () => {
  await prisma.$disconnect();
});

describe("BadgeCredential database invariants", () => {
  test("partial unique index: one ACTIVE credential per participant", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'BadgeCredential'
        AND indexname = 'BadgeCredential_one_active_per_participant_uidx'`;
    assert.equal(rows.length, 1, "partial unique index is MISSING — apply prisma/sql/2026-badge-persistent-qr.sql");
    assert.match(rows[0].indexdef, /UNIQUE/i);
    assert.match(rows[0].indexdef, /\("participantId"\)/);
    assert.match(rows[0].indexdef, /ACTIVE/);
  });

  test("tokenHash is globally unique", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'BadgeCredential' AND indexname = 'BadgeCredential_tokenHash_key'`;
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /UNIQUE/i);
  });

  test("(participantId, sequence) is unique", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'BadgeCredential' AND indexname = 'BadgeCredential_participantId_sequence_key'`;
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /UNIQUE/i);
  });

  test("no participant currently holds more than one ACTIVE credential", async () => {
    const dup = await prisma.$queryRaw<Array<{ participantId: string }>>`
      SELECT "participantId" FROM "BadgeCredential"
      WHERE status = 'ACTIVE' GROUP BY "participantId" HAVING COUNT(*) > 1`;
    assert.equal(dup.length, 0);
  });
});

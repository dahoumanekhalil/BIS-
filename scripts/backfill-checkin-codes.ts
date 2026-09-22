// Phase 19 — one-shot backfill: assign a secure human-readable
// text check-in code to every Participant that does not yet have one.
//
// Run once after `npm run db:push` (which added the `checkinCode`
// column). Idempotent: participants that already have a code are
// left untouched. Safe to re-run — the service is atomic-claim
// protected.
//
// Usage:
//   npx tsx scripts/backfill-checkin-codes.ts
//
// This does NOT:
//   • touch BadgeCredential
//   • touch ParticipantAccess
//   • touch CheckIn
//   • touch AuditLog
//   • rotate any QR credential
//
// Every code is stored via the same service used at attendee
// runtime (`ensureCheckinCode`) so the format / collision-retry /
// atomic-claim invariants are identical.

import { PrismaClient } from "@prisma/client";
import { ensureCheckinCode } from "../lib/badge/checkin-code";

const prisma = new PrismaClient();

async function main() {
  const missing = await prisma.participant.findMany({
    where: { checkinCode: null },
    select: { id: true, firstName: true, lastName: true }
  });
  console.log(
    `Backfill: ${missing.length} participant(s) without a checkin code.`
  );
  let ok = 0;
  let fail = 0;
  for (const p of missing) {
    try {
      const code = await ensureCheckinCode(p.id);
      // Deliberately NOT logging the code — this script may be
      // captured in a terminal history. Log only counts + ids.
      void code;
      ok += 1;
    } catch (err) {
      fail += 1;
      console.error(`  ✗ participant ${p.id}:`, err);
    }
  }
  console.log(`Backfill complete: assigned=${ok}, failed=${fail}.`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

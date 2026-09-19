import { PrismaClient } from "@prisma/client";

// Enforces "at most one ACTIVE BadgeCredential per Participant" at the
// database level. Prisma's schema DSL cannot express a partial unique
// constraint, so we install it here. Idempotent via IF NOT EXISTS — safe to
// re-run after every `prisma db push`.
//
// The service layer (Phase 2) also enforces this inside a transaction — this
// index is the belt-and-braces last line of defence against a race that
// would otherwise leave two live QR codes for the same person.
async function main() {
  const prisma = new PrismaClient();
  try {
    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS "BadgeCredential_one_active_per_participant_uidx"
      ON "BadgeCredential" ("participantId")
      WHERE status = 'ACTIVE'`;
    await prisma.$executeRawUnsafe(sql);
    console.log(
      'Partial unique index ensured: BadgeCredential_one_active_per_participant_uidx'
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

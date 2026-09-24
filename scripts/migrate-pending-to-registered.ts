import { PrismaClient } from "@prisma/client";

// One-shot data migration accompanying the additive RegistrationStatus
// enum change (Commit 1 of the role-based registration refactor).
//
// Semantics:
//   PENDING (legacy)  =  "successfully registered, awaiting admin confirmation"
//   REGISTERED (new)  =  same meaning, better name
//
// This script updates every existing PENDING Participant row to REGISTERED
// so the new invariant ("new registrations are REGISTERED") applies to the
// historical data without touching the enum (that stays additive until a
// follow-up commit removes the deprecated value).
//
// Idempotent: re-running finds zero PENDING rows and reports 0. Safe to run
// before or after a fresh `prisma db push`.
//
// Rollback: run scripts/rollback-registered-to-pending.ts (mirror).
async function main() {
  const prisma = new PrismaClient();
  try {
    const before = await prisma.participant.count({ where: { status: "PENDING" } });
    if (before === 0) {
      console.log("migrate-pending-to-registered: nothing to do (0 PENDING rows).");
      return;
    }
    // Tagged $executeRaw — no interpolation, no user input, but the tagged
    // form keeps the review grep on `$executeRawUnsafe` clean.
    const res = await prisma.$executeRaw`
      UPDATE "Participant"
      SET status = 'REGISTERED'::"RegistrationStatus"
      WHERE status = 'PENDING'::"RegistrationStatus"
    `;
    console.log(
      `migrate-pending-to-registered: swept ${res} rows PENDING → REGISTERED (before=${before}).`
    );
    const after = await prisma.participant.count({ where: { status: "PENDING" } });
    if (after !== 0) {
      throw new Error(
        `Expected 0 PENDING rows after migration, found ${after}. Aborting so this can be investigated.`
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { PrismaClient } from "@prisma/client";

// Enforces webhook idempotency on RoomPaymentEvent at the database
// level: two events cannot share the same (registrationId, providerRef)
// when providerRef is set.
//
// Prisma's schema DSL cannot express a partial unique constraint, so
// we install it here — mirrors the existing pattern used for
// BadgeCredential (scripts/apply-badge-index.ts).
//
// The partial predicate `WHERE "providerRef" IS NOT NULL` is essential:
// admin-confirmed events legitimately carry providerRef=NULL, and
// multiple such events per registration are expected (INIT, CONFIRM,
// REFUND, …). Without the partial predicate, PostgreSQL would treat
// every NULL as distinct anyway — but being explicit documents the
// intent and matches the schema comment.
//
// Idempotent via IF NOT EXISTS — safe to re-run after every
// `prisma db push`.
async function main() {
  const prisma = new PrismaClient();
  try {
    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS "RoomPaymentEvent_registration_providerRef_uidx"
      ON "RoomPaymentEvent" ("registrationId", "providerRef")
      WHERE "providerRef" IS NOT NULL`;
    await prisma.$executeRawUnsafe(sql);
    console.log(
      'Partial unique index ensured: RoomPaymentEvent_registration_providerRef_uidx'
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

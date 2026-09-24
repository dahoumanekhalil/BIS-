import { PrismaClient } from "@prisma/client";

// Emergency rollback for scripts/migrate-pending-to-registered.ts.
//
// NOT part of the normal deployment path. Run manually if a downstream
// consumer relied on the legacy PENDING label and cannot be updated in
// time. After running this, revert the code changes that write REGISTERED
// and restore the previous default. The enum retains PENDING, so this is
// non-destructive.
async function main() {
  const prisma = new PrismaClient();
  try {
    const res = await prisma.$executeRaw`
      UPDATE "Participant"
      SET status = 'PENDING'::"RegistrationStatus"
      WHERE status = 'REGISTERED'::"RegistrationStatus"
    `;
    console.log(
      `rollback-registered-to-pending: swept ${res} rows REGISTERED → PENDING.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

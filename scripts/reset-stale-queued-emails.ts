// Reset stale QUEUED emails to FAILED per the approval spec §3.
//
// Usage:
//   npx tsx scripts/reset-stale-queued-emails.ts
//
// Idempotent — running twice is safe. Also runs automatically inside the
// email worker on the first tick of each day, so most deployments never
// need to invoke this script manually. It exists so operators can force
// the cleanup at deploy time if they prefer.

import { PrismaClient, EmailStatus } from "@prisma/client";

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REASON =
  "Stale queued email — automatically invalidated before email worker activation.";

async function main() {
  const prisma = new PrismaClient({ log: ["error"] });
  const cutoff = new Date(Date.now() - STALE_MS);
  try {
    const res = await prisma.emailMessage.updateMany({
      where: {
        status: EmailStatus.QUEUED,
        createdAt: { lt: cutoff }
      },
      data: {
        status: EmailStatus.FAILED,
        errorMessage: REASON,
        lastError: REASON,
        nextAttemptAt: null
      }
    });
    // eslint-disable-next-line no-console
    console.log(
      `[reset-stale-queued-emails] Reset ${res.count} row(s) older than 7 days.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

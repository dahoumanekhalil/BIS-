// One-time cutover to the persistent-QR scheme.
//
// Legacy BadgeCredential rows only hold a sha256 — their raw token is
// unrecoverable, so the exact existing QR cannot be kept. This script
// replaces each participant's LEGACY ACTIVE credential (sequence IS NULL)
// with a persistent one:
//   • the legacy credential is REVOKED (kept, never deleted),
//   • a new persistent ACTIVE credential is created for the SAME participant,
//   • Participant, AccountUser, CheckIn history are untouched,
//   • participants whose credential an admin revoked are NOT re-issued
//     (revocation stays durable),
//   • each replacement is audited (action "badge.cutover") atomically.
// The subscriber sees the new QR on /compte/badge; previously printed or
// displayed legacy QR codes stop working — announce this before applying.
//
// SAFE BY DEFAULT — it is a DRY RUN unless you pass both flags:
//
//   node --conditions=react-server --import tsx scripts/badge-cutover.ts
//        (dry run: counts + invariants, writes nothing)
//
//   node --conditions=react-server --import tsx scripts/badge-cutover.ts \
//        --apply --expect=<N> --i-know-target=<database name>
//        (N must equal the dry-run "legacy ACTIVE" count and the target
//         database name must be confirmed, or nothing happens)
//
// Requires BADGE_QR_TOKEN_SECRET in the environment (only for --apply).
// Idempotent: re-running after success finds 0 legacy credentials.

import { PrismaClient } from "@prisma/client";
import { reissueLegacyCredential } from "../lib/badge/service";
import { loadBadgeQrSecret } from "../lib/badge/token";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

async function main() {
  const apply = arg("apply") !== undefined;
  const expectRaw = arg("expect");

  // Always show WHICH database this will touch.
  let dbHost = "?";
  let dbName = "?";
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    dbHost = u.host;
    dbName = u.pathname.replace("/", "");
  } catch {
    // leave as "?"
  }
  console.log(`target database: ${dbName} @ ${dbHost}`);

  const legacyActive = await prisma.badgeCredential.findMany({
    where: { status: "ACTIVE", sequence: null },
    select: { participantId: true }
  });
  const duplicates = await prisma.$queryRaw<Array<{ participantId: string }>>`
    SELECT "participantId" FROM "BadgeCredential"
    WHERE status = 'ACTIVE'
    GROUP BY "participantId" HAVING COUNT(*) > 1`;
  const persistentActive = await prisma.badgeCredential.count({
    where: { status: "ACTIVE", sequence: { not: null } }
  });

  console.log("── Persistent-QR cutover ──");
  console.log(`legacy ACTIVE credentials (to replace): ${legacyActive.length}`);
  console.log(`persistent ACTIVE credentials (untouched): ${persistentActive}`);
  console.log(`participants with >1 ACTIVE credential: ${duplicates.length}`);

  if (duplicates.length > 0) {
    console.error("ABORT: duplicate ACTIVE credentials exist. Resolve first.");
    process.exit(2);
  }

  if (!apply) {
    console.log("DRY RUN — nothing was changed. Re-run with --apply --expect=" + legacyActive.length + " --i-know-target=" + dbName);
    return;
  }

  if (arg("i-know-target") !== dbName) {
    console.error(
      `ABORT: pass --i-know-target=${dbName} to confirm the target database. Nothing was changed.`
    );
    process.exit(4);
  }
  try {
    loadBadgeQrSecret(); // fail BEFORE touching any row
  } catch {
    console.error("ABORT: BADGE_QR_TOKEN_SECRET is missing or invalid. Nothing was changed.");
    process.exit(5);
  }

  if (expectRaw === undefined || Number(expectRaw) !== legacyActive.length) {
    console.error(
      `ABORT: --expect=${expectRaw ?? "(missing)"} does not match the current ` +
        `legacy ACTIVE count (${legacyActive.length}). Nothing was changed.`
    );
    process.exit(3);
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of legacyActive) {
    try {
      const r = await reissueLegacyCredential(row.participantId);
      if (r) done += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      // Participant id + error code only — never tokens or secrets.
      console.error(
        `  ✗ participant ${row.participantId}:`,
        err instanceof Error
          ? err.name + (("code" in err && typeof err.code === "string") ? ":" + err.code : "")
          : "unknown"
      );
    }
  }
  console.log(`Cutover complete: reissued=${done}, skipped=${skipped}, failed=${failed}.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "unknown error");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

import { PrismaClient, AccessPointType, AdmissionMode } from "@prisma/client";

// Sub-Phase B data migration for the paid/free room registration
// feature. This script establishes the operational default for every
// existing ROOM AccessPoint that has not yet had its admission mode
// declared. Per the approved Sub-Phase A brief:
//
//   • Existing ROOM AccessPoints with admissionMode = NULL → FREE.
//   • Existing ROOM AccessPoints with admissionMode already set
//     (FREE or PAID) are LEFT UNTOUCHED. That respects Phase 17
//     admin intent and avoids the "silently making rooms paid" trap
//     in reverse.
//   • MAIN_ENTRANCE points are LEFT UNTOUCHED. They must remain
//     admissionMode = NULL (validated at the service layer).
//   • No existing ParticipantAccess rows are modified. The `source`
//     column defaults to ADMIN for every pre-existing row, which is
//     the safe migration default (see schema.prisma comment on
//     AccessGrantSource).
//   • No RoomRegistration rows are created. Historical admin grants
//     stay admin-attributed; the sync service owns only rows it
//     creates going forward. If retrospective backfill of granted
//     PA rows into FREE_CONFIRMED RoomRegistrations is desired
//     later, a separate script will implement it — this migration
//     is deliberately non-destructive.
//
// Idempotent: subsequent runs report 0 updates because the WHERE
// clause targets only rows whose admissionMode is currently null.

async function main() {
  const prisma = new PrismaClient();
  try {
    // Pre-run snapshot (used for the operator-friendly diff below).
    const before = await prisma.accessPoint.findMany({
      select: {
        slug: true,
        type: true,
        admissionMode: true,
        priceMinor: true,
        currency: true
      },
      orderBy: { slug: "asc" }
    });

    // The actual, idempotent write. `updateMany` returns the count
    // of rows that matched — 0 on a second run.
    const result = await prisma.accessPoint.updateMany({
      where: {
        type: AccessPointType.ROOM,
        admissionMode: null
      },
      data: {
        admissionMode: AdmissionMode.FREE
      }
    });

    const after = await prisma.accessPoint.findMany({
      select: {
        slug: true,
        type: true,
        admissionMode: true,
        priceMinor: true,
        currency: true
      },
      orderBy: { slug: "asc" }
    });

    // Defensive assertion: MAIN_ENTRANCE points must remain null.
    // If this ever fails, the migration is unsafe.
    const drifted = after.filter(
      (r) => r.type === AccessPointType.MAIN_ENTRANCE && r.admissionMode !== null
    );
    if (drifted.length > 0) {
      throw new Error(
        `MAIN_ENTRANCE drift detected: ${drifted
          .map((r) => r.slug)
          .join(", ")} have non-null admissionMode. Migration aborted.`
      );
    }

    console.log(
      `Set admissionMode=FREE on ${result.count} ROOM AccessPoint(s).`
    );
    console.log("Post-migration state:");
    for (const r of after) {
      const beforeRow = before.find((b) => b.slug === r.slug);
      const changed =
        beforeRow &&
        beforeRow.admissionMode !== r.admissionMode &&
        r.admissionMode !== null;
      console.log(
        `  ${r.slug.padEnd(12)}  type=${r.type.padEnd(13)}  admissionMode=${
          r.admissionMode ?? "null"
        }${changed ? "  ← updated" : ""}`
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

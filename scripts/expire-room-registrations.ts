import { PrismaClient, RoomRegistrationStatus } from "@prisma/client";
import { expire } from "../lib/room-registration/service";

// ─── Expire stale PENDING_PAYMENT room registrations (Sub-Phase D §8) ─
//
// Iterates PENDING_PAYMENT rows whose `expiresAt` is strictly in the
// past and transitions each one to EXPIRED through the canonical
// domain service.
//
// Design constraints (Sub-Phase D §8):
//   • Uses the domain service — this script does NOT mutate
//     RoomRegistration / ParticipantAccess / RoomPaymentEvent
//     directly. The service enforces the state machine, emits exactly
//     one event, syncs REGISTRATION-owned access (a no-op for the
//     PENDING_PAYMENT → EXPIRED transition since no PA row was ever
//     materialised), and preserves ADMIN-owned access.
//   • Idempotent — the domain `expire()` returns
//     transitioned=false for rows that are already EXPIRED,
//     rows whose expiresAt is not set, and rows whose expiresAt is
//     still in the future. Repeat runs are safe.
//   • Does NOT invent a duration — rows with `expiresAt IS NULL` are
//     ignored. Automatic assignment of `expiresAt` at registration
//     time is an unresolved business decision documented in the
//     Sub-Phase D final report; this script only acts on deadlines
//     that were explicitly set (e.g., by a future policy).
//
// Usage:
//   npx tsx scripts/expire-room-registrations.ts
//
// Environment: DATABASE_URL must be set. No other env or CLI flag is
// required.
//
// SAFETY: this script only reads / writes RoomRegistration +
// RoomPaymentEvent + AuditLog via the canonical service. It does NOT
// touch CheckIn, BadgeCredential, ParticipantAccess (source=ADMIN),
// Participant, or any other model directly.

const BATCH_SIZE = 200;

async function main() {
  const prisma = new PrismaClient();
  let total = 0;
  let transitioned = 0;
  let skipped = 0;
  let errored = 0;

  try {
    const now = new Date();

    // Cursor-paginated scan. We take a snapshot of the (id, participantId,
    // accessPointId) triples once and process each row through the
    // domain service. If a row transitions to another status between
    // list-time and process-time (e.g., a race with an admin confirm),
    // the domain's `expire()` idempotently returns transitioned=false
    // — no error surfaced.
    let cursor: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await prisma.roomRegistration.findMany({
        where: {
          status: RoomRegistrationStatus.PENDING_PAYMENT,
          expiresAt: { lt: now }
        },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: {
          id: true,
          participantId: true,
          accessPointId: true
        }
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      total += batch.length;

      for (const row of batch) {
        const res = await expire({
          participantId: row.participantId,
          accessPointId: row.accessPointId
        });
        if (!res.ok) {
          errored += 1;
          console.warn(
            `[expire] row ${row.id} refused: ${res.code} — ${res.message}`
          );
          continue;
        }
        if (res.value.status === RoomRegistrationStatus.EXPIRED) {
          transitioned += 1;
        } else {
          // The domain returned ok=true but no transition happened
          // (row was already terminal / expiresAt cleared / another
          // path fired). Idempotent behaviour — count it and move on.
          skipped += 1;
        }
      }
    }

    console.log(
      `[expire] scanned=${total} transitioned=${transitioned} skipped=${skipped} errored=${errored}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[expire] fatal", e);
  process.exit(1);
});

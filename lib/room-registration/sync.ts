import "server-only";

import {
  AccessGrantSource,
  Prisma,
  RoomRegistrationStatus
} from "@prisma/client";
import { shouldGrant, shouldRevoke } from "./state-machine";

// ─── syncRoomAccessEntitlement ────────────────────────────────────────
//
// The ONLY function permitted to mutate ParticipantAccess as a
// consequence of a RoomRegistration state change. Runs inside the
// same Prisma transaction as the state transition — atomicity is a
// pre-condition, not a promise this function makes on its own.
//
// Invariants (Sub-Phase C §10, §15):
//
//   • ParticipantAccess.source=ADMIN rows are NEVER read for
//     mutation. The `updateMany` conditional filters on
//     `source: REGISTRATION` so a concurrent admin toggling the
//     same pair cannot be silently overridden. `upsert` is NOT
//     used here for the grant path because we need the write to
//     be conditional on source; instead we do:
//       1. find any existing row (regardless of source)
//       2. if row exists AND source=ADMIN → do nothing, return
//       3. if row exists AND source=REGISTRATION → update it
//       4. if no row → create with source=REGISTRATION
//
//   • Revocation only touches source=REGISTRATION rows. If the
//     only PA row for the pair is source=ADMIN, revocation is a
//     no-op — admin intent stands.
//
//   • Status → action mapping:
//       FREE_CONFIRMED, PAID    →  grant (source=REGISTRATION)
//       REFUNDED, CANCELLED     →  revoke (source=REGISTRATION only)
//       PENDING_PAYMENT,
//       PAYMENT_FAILED, EXPIRED →  no-op (never grants access)
//
// The service intentionally does NOT emit an audit row here — the
// caller (state-transition operation) is responsible for exactly
// one audit event per user-visible transition, and this helper is
// its private tool.

type Tx = Prisma.TransactionClient;

export type SyncOutcome =
  | { action: "granted"; source: AccessGrantSource }
  | { action: "revoked"; source: AccessGrantSource }
  | { action: "no-op"; reason: SyncNoOpReason };

export type SyncNoOpReason =
  | "status-does-not-require-sync"
  | "admin-owned-grant-preserved"
  | "admin-owned-revoke-preserved"
  | "already-in-target-state";

export async function syncRoomAccessEntitlement(
  tx: Tx,
  input: {
    participantId: string;
    accessPointId: string;
    status: RoomRegistrationStatus;
  }
): Promise<SyncOutcome> {
  const { participantId, accessPointId, status } = input;

  if (shouldGrant(status)) {
    return await grantRegistrationOwned(tx, participantId, accessPointId);
  }

  if (shouldRevoke(status)) {
    return await revokeRegistrationOwned(tx, participantId, accessPointId);
  }

  // PENDING_PAYMENT, PAYMENT_FAILED, EXPIRED → nothing to do. The
  // sync service NEVER pre-emptively creates a denial row for a
  // registration that is not yet confirmed; that would create
  // false-negative results in the tri-state UI on /compte.
  return { action: "no-op", reason: "status-does-not-require-sync" };
}

async function grantRegistrationOwned(
  tx: Tx,
  participantId: string,
  accessPointId: string
): Promise<SyncOutcome> {
  const existing = await tx.participantAccess.findUnique({
    where: {
      participantId_accessPointId: { participantId, accessPointId }
    },
    select: { source: true, granted: true }
  });

  // Admin decision wins. If an admin has a row here (granted OR
  // revoked), the sync service does not touch it. Registration
  // grants only materialise where no admin has expressed intent.
  if (existing && existing.source === AccessGrantSource.ADMIN) {
    return { action: "no-op", reason: "admin-owned-grant-preserved" };
  }

  if (
    existing &&
    existing.source === AccessGrantSource.REGISTRATION &&
    existing.granted
  ) {
    return { action: "no-op", reason: "already-in-target-state" };
  }

  // Either no row (create) or an existing REGISTRATION-owned row
  // that needs updating back to granted=true (e.g., a prior refund
  // was later re-registered — the state machine forbids REFUNDED →
  // active on the RoomRegistration itself, but if a future phase
  // ever opens that door this write remains safe).
  if (!existing) {
    await tx.participantAccess.create({
      data: {
        participantId,
        accessPointId,
        granted: true,
        source: AccessGrantSource.REGISTRATION,
        grantedById: null,
        grantedAt: new Date(),
        revokedAt: null,
        revokedById: null
      }
    });
  } else {
    await tx.participantAccess.update({
      where: {
        participantId_accessPointId: { participantId, accessPointId }
      },
      data: {
        granted: true,
        grantedById: null,
        grantedAt: new Date(),
        revokedAt: null,
        revokedById: null
        // source deliberately not written — we already verified it
        // is REGISTRATION above; the update leaves the enum alone.
      }
    });
  }

  return {
    action: "granted",
    source: AccessGrantSource.REGISTRATION
  };
}

async function revokeRegistrationOwned(
  tx: Tx,
  participantId: string,
  accessPointId: string
): Promise<SyncOutcome> {
  // updateMany with a source predicate is the safest write here:
  //   • matches only REGISTRATION-owned rows
  //   • zero rows matched → returns count=0, silent no-op
  //   • never mutates ADMIN rows even under a concurrent write
  //   • no race: the DB primary key prevents duplicate rows
  const now = new Date();
  const res = await tx.participantAccess.updateMany({
    where: {
      participantId,
      accessPointId,
      source: AccessGrantSource.REGISTRATION,
      granted: true
    },
    data: {
      granted: false,
      revokedAt: now,
      revokedById: null
    }
  });

  if (res.count > 0) {
    return {
      action: "revoked",
      source: AccessGrantSource.REGISTRATION
    };
  }

  // If we didn't touch any row, one of three benign situations
  // holds: (a) there was no PA row at all (never granted); (b) the
  // only row is source=ADMIN (immune); (c) a REGISTRATION row exists
  // but is already granted=false (idempotent).
  const anyAdmin = await tx.participantAccess.findFirst({
    where: {
      participantId,
      accessPointId,
      source: AccessGrantSource.ADMIN
    },
    select: { source: true }
  });
  if (anyAdmin) {
    return { action: "no-op", reason: "admin-owned-revoke-preserved" };
  }

  return { action: "no-op", reason: "already-in-target-state" };
}

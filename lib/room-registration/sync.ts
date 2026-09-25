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
// Invariants:
//
//   • ParticipantAccess.source=ADMIN rows are NEVER mutated. Admin
//     intent takes precedence over the registration-owned entitlement.
//   • Revocation only touches source=REGISTRATION rows.
//   • Status → action mapping (FREE-only):
//       FREE_CONFIRMED  →  grant (source=REGISTRATION)
//       CANCELLED       →  revoke (source=REGISTRATION only)
//
// The caller is responsible for exactly one audit event per user-
// visible transition; this helper is its private tool.

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

import "server-only";

import { Prisma, RegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/admin/audit";
import {
  generateBadgeToken,
  hashBadgeToken,
  timingSafeHexEqual,
  MIN_TOKEN_LENGTH
} from "./token";
import { BadgeError } from "./errors";

// ─── Public shapes ────────────────────────────────────────────────────────
// The service returns raw tokens *only* from mutations. Callers must show
// them to the participant / admin once and then discard — they are never
// retrievable again because we only store their hash.

export type IssueResult = {
  credentialId: string;
  rawToken: string;
};

export type RotateResult = {
  credentialId: string;
  rawToken: string;
  previousCredentialId: string | null;
};

export type RevokeResult = {
  // NOOP means "already revoked, nothing to do"; REVOKED means "we just did".
  status: "REVOKED" | "NOOP";
};

// verify() never throws for expected outcomes. The reason discriminant is
// for the caller to decide how much to expose to the end user.
export type VerifyResult =
  | { ok: true; credentialId: string; participantId: string }
  | {
      ok: false;
      reason: "INVALID" | "REVOKED" | "EXPIRED" | "PARTICIPANT_CANCELLED";
    };

// ─── issue ────────────────────────────────────────────────────────────────
// Issue a fresh BadgeCredential for a Participant. Throws:
//   • BadgeError("PARTICIPANT_NOT_FOUND") if the participant does not exist.
//   • BadgeError("ACTIVE_EXISTS") if the participant already has an ACTIVE
//     credential — callers who mean "replace" should use rotate() instead.
//
// The transaction guarantees single-active in the happy path; the partial
// unique index on ("participantId") WHERE status = 'ACTIVE' is the DB-level
// last line of defence against a race.
export async function issueBadgeCredential(
  participantId: string,
  opts?: { expiresAt?: Date | null }
): Promise<IssueResult> {
  const rawToken = generateBadgeToken();
  const tokenHash = hashBadgeToken(rawToken);

  const credentialId = await prisma.$transaction(async (tx) => {
    const participant = await tx.participant.findUnique({
      where: { id: participantId },
      select: { id: true }
    });
    if (!participant) throw new BadgeError("PARTICIPANT_NOT_FOUND");

    const existing = await tx.badgeCredential.findFirst({
      where: { participantId, status: "ACTIVE" },
      select: { id: true }
    });
    if (existing) throw new BadgeError("ACTIVE_EXISTS");

    try {
      const created = await tx.badgeCredential.create({
        data: {
          participantId,
          tokenHash,
          status: "ACTIVE",
          expiresAt: opts?.expiresAt ?? null
        },
        select: { id: true }
      });
      return created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Concurrent issue lost the race to the partial unique index.
        throw new BadgeError("ACTIVE_EXISTS");
      }
      throw err;
    }
  });

  await audit({
    action: "badge.issue",
    entity: "Participant",
    entityId: participantId,
    meta: { credentialId }
  });

  return { credentialId, rawToken };
}

// ─── verify ───────────────────────────────────────────────────────────────
// Hash-based O(1) lookup. Returns a discriminated union — never throws for
// bad input, so scanner code paths are simple. Does NOT audit; the caller
// (check-in flow) records the scan with the appropriate AccessPoint context.
export async function verifyBadgeToken(
  rawToken: unknown
): Promise<VerifyResult> {
  if (typeof rawToken !== "string" || rawToken.length < MIN_TOKEN_LENGTH) {
    return { ok: false, reason: "INVALID" };
  }
  const tokenHash = hashBadgeToken(rawToken);

  const cred = await prisma.badgeCredential.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      status: true,
      expiresAt: true,
      participantId: true,
      participant: { select: { status: true } }
    }
  });
  if (!cred) return { ok: false, reason: "INVALID" };

  // Defence in depth: verify the returned hash matches the computed one in
  // constant time. Under normal Postgres behaviour this is guaranteed by the
  // unique index; the extra check guards against exotic failure modes.
  if (!timingSafeHexEqual(cred.tokenHash, tokenHash)) {
    return { ok: false, reason: "INVALID" };
  }

  if (cred.status === "REVOKED") return { ok: false, reason: "REVOKED" };
  if (cred.status === "EXPIRED") return { ok: false, reason: "EXPIRED" };
  if (cred.expiresAt && cred.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (cred.status !== "ACTIVE") {
    // PENDING → not usable yet.
    return { ok: false, reason: "INVALID" };
  }

  if (cred.participant.status === RegistrationStatus.CANCELLED) {
    return { ok: false, reason: "PARTICIPANT_CANCELLED" };
  }

  return {
    ok: true,
    credentialId: cred.id,
    participantId: cred.participantId
  };
}

// ─── revoke ───────────────────────────────────────────────────────────────
// Idempotent: revoking an already-REVOKED credential returns NOOP without
// touching the row. Throws:
//   • BadgeError("CREDENTIAL_NOT_FOUND") on missing id.
//   • BadgeError("ADMIN_NOT_FOUND") if revokedById is set and does not
//     resolve to an AdminUser row.
export async function revokeBadgeCredential(
  credentialId: string,
  revokedById?: string | null,
  reason?: string | null
): Promise<RevokeResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    if (revokedById) {
      const admin = await tx.adminUser.findUnique({
        where: { id: revokedById },
        select: { id: true }
      });
      if (!admin) throw new BadgeError("ADMIN_NOT_FOUND");
    }

    const cred = await tx.badgeCredential.findUnique({
      where: { id: credentialId },
      select: { id: true, status: true, participantId: true }
    });
    if (!cred) throw new BadgeError("CREDENTIAL_NOT_FOUND");

    if (cred.status === "REVOKED") {
      return {
        status: "NOOP" as const,
        participantId: cred.participantId
      };
    }

    await tx.badgeCredential.update({
      where: { id: credentialId },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedById: revokedById ?? null,
        revokedReason: reason ?? null
      }
    });
    return {
      status: "REVOKED" as const,
      participantId: cred.participantId
    };
  });

  if (outcome.status === "REVOKED") {
    await audit({
      userId: revokedById ?? null,
      action: "badge.revoke",
      entity: "Participant",
      entityId: outcome.participantId,
      meta: { credentialId, reason: reason ?? null }
    });
  }

  return { status: outcome.status };
}

// ─── rotate ───────────────────────────────────────────────────────────────
// Atomic: revoke the current ACTIVE credential (if any) and create a new
// ACTIVE credential pointing at it via rotatedFromId. If the participant has
// no ACTIVE credential yet, this behaves like issue() but records
// previousCredentialId = null. Throws:
//   • BadgeError("PARTICIPANT_NOT_FOUND") on missing participant.
//   • BadgeError("ADMIN_NOT_FOUND") if revokedById is set and unknown.
//   • BadgeError("CONCURRENT_ROTATION") if two rotations raced and the DB
//     partial unique index rolled us back — the caller can safely retry.
export async function rotateBadgeCredential(
  participantId: string,
  revokedById?: string | null,
  reason?: string | null
): Promise<RotateResult> {
  const rawToken = generateBadgeToken();
  const tokenHash = hashBadgeToken(rawToken);

  const result = await prisma.$transaction(async (tx) => {
    const participant = await tx.participant.findUnique({
      where: { id: participantId },
      select: { id: true }
    });
    if (!participant) throw new BadgeError("PARTICIPANT_NOT_FOUND");

    if (revokedById) {
      const admin = await tx.adminUser.findUnique({
        where: { id: revokedById },
        select: { id: true }
      });
      if (!admin) throw new BadgeError("ADMIN_NOT_FOUND");
    }

    const previous = await tx.badgeCredential.findFirst({
      where: { participantId, status: "ACTIVE" },
      select: { id: true }
    });

    if (previous) {
      await tx.badgeCredential.update({
        where: { id: previous.id },
        data: {
          status: "REVOKED",
          revokedAt: new Date(),
          revokedById: revokedById ?? null,
          revokedReason: reason ?? "rotated"
        }
      });
    }

    try {
      const created = await tx.badgeCredential.create({
        data: {
          participantId,
          tokenHash,
          status: "ACTIVE",
          rotatedFromId: previous?.id ?? null
        },
        select: { id: true }
      });
      return {
        credentialId: created.id,
        previousCredentialId: previous?.id ?? null
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new BadgeError("CONCURRENT_ROTATION");
      }
      throw err;
    }
  });

  await audit({
    userId: revokedById ?? null,
    action: "badge.rotate",
    entity: "Participant",
    entityId: participantId,
    meta: {
      newCredentialId: result.credentialId,
      previousCredentialId: result.previousCredentialId,
      reason: reason ?? null
    }
  });

  return {
    credentialId: result.credentialId,
    rawToken,
    previousCredentialId: result.previousCredentialId
  };
}

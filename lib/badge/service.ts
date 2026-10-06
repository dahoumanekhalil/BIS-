import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, RegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  deriveBadgeToken,
  hashBadgeToken,
  timingSafeHexEqual,
  loadBadgeQrSecret,
  MIN_TOKEN_LENGTH
} from "./token";
import { generateCheckinCode } from "./checkin-code";
import { BadgeError } from "./errors";

// ─── Policy (authoritative) ──────────────────────────────────────────────
// • A participant has ONE persistent ACTIVE credential. Its QR token is
//   derived (HMAC) so it can be re-displayed identically, any number of
//   times, without storing the raw token.
// • There is NO subscriber-facing mutation here. The only operations that
//   replace a credential are `regenerateBadgeCredential` (administrator
//   identity REQUIRED in its signature) and the one-time legacy cutover in
//   scripts/badge-cutover.ts (which calls `reissueLegacyCredential`).
// • First issuance (`issueBadgeCredential`) only works for a participant
//   with NO credential history. After an admin revoke, nothing but an
//   admin regeneration can create a new credential (durable revocation).
// • Every mutation writes its AuditLog row INSIDE the same transaction. If
//   the audit row cannot be written, the whole operation rolls back.
// • Raw tokens are never logged and never placed in audit metadata.

// ─── Public shapes ────────────────────────────────────────────────────────

export type IssueResult = {
  credentialId: string;
  rawToken: string;
};

export type RegenerateResult = {
  credentialId: string;
  previousCredentialId: string | null;
  sequence: number;
  rawToken: string;
};

export type RevokeResult = {
  // NOOP means "already revoked, nothing to do"; REVOKED means "we just did".
  status: "REVOKED" | "NOOP";
};

export type CurrentTokenResult =
  | {
      ok: true;
      credentialId: string;
      sequence: number;
      issuedAt: Date;
      rawToken: string;
    }
  | {
      ok: false;
      // NONE      — participant has never had a credential
      // REVOKED   — no ACTIVE credential and an admin revoked the last one
      // LEGACY    — ACTIVE credential predates the persistent scheme
      //             (raw token unrecoverable; an admin must regenerate)
      // EXPIRED   — ACTIVE credential past expiresAt
      reason: "NONE" | "REVOKED" | "LEGACY" | "EXPIRED";
    };

export type VerifyResult =
  | { ok: true; credentialId: string; participantId: string }
  | {
      ok: false;
      reason: "INVALID" | "REVOKED" | "EXPIRED" | "PARTICIPANT_CANCELLED";
    };

type Tx = Prisma.TransactionClient;

// Per-admin hourly ceilings. Counted from the audit trail INSIDE the same
// transaction, serialised per admin with an advisory lock, so parallel
// requests cannot all slip under the limit.
export const REGENERATE_PER_ADMIN_PER_HOUR = 30;

async function assertAdminBudget(
  tx: Tx,
  adminId: string,
  action: string,
  limit: number
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"badge-budget:" + adminId}))`;
  const n = await tx.auditLog.count({
    where: {
      userId: adminId,
      action,
      createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }
    }
  });
  if (n >= limit) throw new BadgeError("RATE_LIMITED");
}

const REASON_MIN = 5;
const REASON_MAX = 500;

// ─── Internal helpers ─────────────────────────────────────────────────────

// Serialises every credential mutation for one participant. Two concurrent
// operations on the same participant queue behind this row lock, so the
// loser observes the winner's committed state and gets a deterministic
// CONFLICT (never a half-applied state, never two ACTIVE rows).
async function lockParticipant(tx: Tx, participantId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Participant" WHERE "id" = ${participantId} FOR UPDATE`;
  if (rows.length === 0) throw new BadgeError("PARTICIPANT_NOT_FOUND");
}

// Strict audit: runs on the transaction client and THROWS on failure so the
// credential change and its evidence commit (or fail) together.
async function auditStrict(
  tx: Tx,
  args: {
    userId: string | null;
    action: string;
    participantId: string;
    meta: Prisma.InputJsonObject;
  }
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: args.userId,
      action: args.action,
      entity: "Participant",
      entityId: args.participantId,
      meta: args.meta
    }
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

function normalizeReason(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (r.length < REASON_MIN || r.length > REASON_MAX) {
    throw new BadgeError("REASON_REQUIRED");
  }
  return r;
}

// Creates the next persistent credential for a participant. Caller MUST hold
// the participant lock and have already revoked any ACTIVE credential.
async function createPersistentCredential(
  tx: Tx,
  args: {
    participantId: string;
    rotatedFromId: string | null;
    createdById: string | null;
    expiresAt?: Date | null;
  }
): Promise<{ id: string; sequence: number; rawToken: string }> {
  const agg = await tx.badgeCredential.aggregate({
    where: { participantId: args.participantId },
    _max: { sequence: true }
  });
  const sequence = (agg._max.sequence ?? 0) + 1;
  const id = randomUUID();
  const rawToken = deriveBadgeToken(id, sequence);
  try {
    await tx.badgeCredential.create({
      data: {
        id,
        participantId: args.participantId,
        tokenHash: hashBadgeToken(rawToken),
        status: "ACTIVE",
        sequence,
        rotatedFromId: args.rotatedFromId,
        createdById: args.createdById,
        expiresAt: args.expiresAt ?? null
      },
      select: { id: true }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new BadgeError("CONFLICT");
    throw err;
  }
  return { id, sequence, rawToken };
}

// ─── issue (first issuance only) ──────────────────────────────────────────
// System issuance for a participant with NO credential history. Throws:
//   • PARTICIPANT_NOT_FOUND
//   • ACTIVE_EXISTS   — an ACTIVE credential already exists
//   • HISTORY_EXISTS  — only revoked/expired history exists: a replacement
//                       is an ADMINISTRATIVE decision (regenerate).
//   • SECRET_NOT_CONFIGURED
export async function issueBadgeCredential(
  participantId: string,
  opts?: { expiresAt?: Date | null }
): Promise<IssueResult> {
  loadBadgeQrSecret(); // fail closed early

  return prisma.$transaction(async (tx) => {
    await lockParticipant(tx, participantId);

    const existing = await tx.badgeCredential.findFirst({
      where: { participantId },
      select: { status: true },
      orderBy: { issuedAt: "desc" }
    });
    if (existing) {
      const active = await tx.badgeCredential.findFirst({
        where: { participantId, status: "ACTIVE" },
        select: { id: true }
      });
      throw new BadgeError(active ? "ACTIVE_EXISTS" : "HISTORY_EXISTS");
    }

    const created = await createPersistentCredential(tx, {
      participantId,
      rotatedFromId: null,
      createdById: null,
      expiresAt: opts?.expiresAt ?? null
    });
    await auditStrict(tx, {
      userId: null,
      action: "badge.issue",
      participantId,
      meta: { credentialId: created.id, sequence: created.sequence }
    });
    return { credentialId: created.id, rawToken: created.rawToken };
  });
}

// ─── regenerate (ADMINISTRATOR ONLY) ──────────────────────────────────────
// The single path that replaces a participant's credential. Atomically:
//   lock participant → check admin → (optimistic) check the credential the
//   admin saw is still the ACTIVE one → revoke it → create the next
//   persistent ACTIVE credential (same participantId) → rotate the text
//   check-in code printed on the badge → write the audit row.
//
// `expectedCredentialId` is the id of the ACTIVE credential the admin was
// looking at (null if they saw none). If it no longer matches, nothing is
// changed and CONFLICT is thrown: this makes duplicate clicks, retries after
// a timeout, two admins at once, and revoke-vs-regenerate races all resolve
// deterministically with no state corruption.
//
// Never creates a Participant. Never deletes a credential. The participant
// id is unchanged by construction.
export async function regenerateBadgeCredential(input: {
  participantId: string;
  adminId: string;
  reason: string;
  expectedCredentialId: string | null;
}): Promise<RegenerateResult> {
  const { participantId, adminId, expectedCredentialId } = input;
  if (!adminId) throw new BadgeError("ADMIN_NOT_FOUND");
  const reason = normalizeReason(input.reason);
  loadBadgeQrSecret(); // fail closed early

  return prisma.$transaction(async (tx) => {
    await lockParticipant(tx, participantId);

    const admin = await tx.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, status: true }
    });
    if (!admin || admin.status !== "ACTIVE") {
      throw new BadgeError("ADMIN_NOT_FOUND");
    }
    await assertAdminBudget(
      tx,
      adminId,
      "badge.regenerate",
      REGENERATE_PER_ADMIN_PER_HOUR
    );

    const previous = await tx.badgeCredential.findFirst({
      where: { participantId, status: "ACTIVE" },
      select: { id: true }
    });
    if ((previous?.id ?? null) !== expectedCredentialId) {
      throw new BadgeError("CONFLICT");
    }

    if (previous) {
      const revoked = await tx.badgeCredential.updateMany({
        where: { id: previous.id, status: "ACTIVE" },
        data: {
          status: "REVOKED",
          revokedAt: new Date(),
          revokedById: adminId,
          revokedReason: reason
        }
      });
      if (revoked.count !== 1) throw new BadgeError("CONFLICT");
    }

    const created = await createPersistentCredential(tx, {
      participantId,
      rotatedFromId: previous?.id ?? null,
      createdById: adminId
    });

    // The text check-in code is printed on the same badge face as the QR;
    // an old badge must not stay usable through it. Fresh CSPRNG code.
    try {
      await tx.participant.update({
        where: { id: participantId },
        data: { checkinCode: generateCheckinCode() },
        select: { id: true }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new BadgeError("CONFLICT");
      throw err;
    }

    await auditStrict(tx, {
      userId: adminId,
      action: "badge.regenerate",
      participantId,
      meta: {
        oldCredentialId: previous?.id ?? null,
        newCredentialId: created.id,
        sequence: created.sequence,
        reason,
        textCodeRotated: true
      }
    });

    return {
      credentialId: created.id,
      previousCredentialId: previous?.id ?? null,
      sequence: created.sequence,
      rawToken: created.rawToken
    };
  });
}

// ─── legacy cutover (operator script only) ────────────────────────────────
// Replaces a LEGACY hash-only ACTIVE credential (sequence NULL) with a
// persistent one for the SAME participant. Refuses anything else, so it can
// never be used to rotate a persistent credential or to resurrect a revoked
// participant. Called only by scripts/badge-cutover.ts.
export async function reissueLegacyCredential(
  participantId: string
): Promise<{ credentialId: string; previousCredentialId: string } | null> {
  loadBadgeQrSecret();
  return prisma.$transaction(async (tx) => {
    await lockParticipant(tx, participantId);
    const legacy = await tx.badgeCredential.findFirst({
      where: { participantId, status: "ACTIVE", sequence: null },
      select: { id: true, expiresAt: true }
    });
    if (!legacy) return null;

    const revoked = await tx.badgeCredential.updateMany({
      where: { id: legacy.id, status: "ACTIVE", sequence: null },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedById: null,
        revokedReason: "persistent-qr-cutover"
      }
    });
    if (revoked.count !== 1) throw new BadgeError("CONFLICT");

    const created = await createPersistentCredential(tx, {
      participantId,
      rotatedFromId: legacy.id,
      createdById: null,
      // Keep the legacy expiry: a cutover must not turn an expiring
      // credential into a non-expiring one.
      expiresAt: legacy.expiresAt
    });
    await auditStrict(tx, {
      userId: null,
      action: "badge.cutover",
      participantId,
      meta: {
        oldCredentialId: legacy.id,
        newCredentialId: created.id,
        sequence: created.sequence,
        reason: "persistent-qr-cutover",
        operator: "badge-cutover-script"
      }
    });
    return { credentialId: created.id, previousCredentialId: legacy.id };
  });
}

// ─── current token (read-only display) ────────────────────────────────────
// Re-derives the CURRENT credential's token. Pure read: never mutates, so
// viewing / refreshing / another device / another session always yields the
// same QR. The caller must render it immediately and never log it.
// Throws SECRET_NOT_CONFIGURED / SECRET_MISMATCH on misconfiguration.
export async function getCurrentBadgeToken(
  participantId: string,
  // Pass the transaction client when called inside an interactive
  // transaction, so the read uses the SAME connection (no second pool
  // connection held while the first waits).
  db: Pick<Tx, "badgeCredential"> = prisma
): Promise<CurrentTokenResult> {
  const active = await db.badgeCredential.findFirst({
    where: { participantId, status: "ACTIVE" },
    select: {
      id: true,
      tokenHash: true,
      sequence: true,
      issuedAt: true,
      expiresAt: true
    }
  });
  if (!active) {
    const latest = await db.badgeCredential.findFirst({
      where: { participantId },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      select: { status: true }
    });
    if (!latest) return { ok: false, reason: "NONE" };
    return { ok: false, reason: "REVOKED" };
  }
  if (active.sequence === null) return { ok: false, reason: "LEGACY" };
  if (active.expiresAt && active.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "EXPIRED" };
  }

  const rawToken = deriveBadgeToken(active.id, active.sequence);
  if (!timingSafeHexEqual(hashBadgeToken(rawToken), active.tokenHash)) {
    // Secret changed/rotated, or the row was tampered with. Fail closed.
    throw new BadgeError("SECRET_MISMATCH");
  }
  return {
    ok: true,
    credentialId: active.id,
    sequence: active.sequence,
    issuedAt: active.issuedAt,
    rawToken
  };
}

// ─── verify ───────────────────────────────────────────────────────────────
// Hash-based O(1) lookup. Returns a discriminated union — never throws for
// bad input, so scanner code paths are simple. Does NOT audit; the caller
// (check-in flow) records the scan with the appropriate AccessPoint context.
// Does NOT need the QR secret: validation is by sha256 lookup only.
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
// Idempotent. Revocation is DURABLE: nothing a subscriber can do re-creates
// a credential afterwards; only an administrative regeneration can.
// Throws CREDENTIAL_NOT_FOUND / ADMIN_NOT_FOUND. The audit row is written in
// the same transaction.
export async function revokeBadgeCredential(
  credentialId: string,
  revokedById?: string | null,
  reason?: string | null
): Promise<RevokeResult> {
  return prisma.$transaction(async (tx) => {
    if (revokedById) {
      const admin = await tx.adminUser.findUnique({
        where: { id: revokedById },
        select: { id: true, status: true }
      });
      if (!admin || admin.status !== "ACTIVE") {
        throw new BadgeError("ADMIN_NOT_FOUND");
      }
    }

    const first = await tx.badgeCredential.findUnique({
      where: { id: credentialId },
      select: { participantId: true }
    });
    if (!first) throw new BadgeError("CREDENTIAL_NOT_FOUND");

    // Same lock as regenerate → revoke-vs-regenerate is serialised.
    await lockParticipant(tx, first.participantId);

    const res = await tx.badgeCredential.updateMany({
      where: { id: credentialId, status: { not: "REVOKED" } },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedById: revokedById ?? null,
        revokedReason: reason ?? null
      }
    });
    if (res.count === 0) return { status: "NOOP" as const };

    await auditStrict(tx, {
      userId: revokedById ?? null,
      action: "badge.revoke",
      participantId: first.participantId,
      meta: { credentialId, reason: reason ?? null }
    });
    return { status: "REVOKED" as const };
  });
}

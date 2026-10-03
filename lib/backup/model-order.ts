import "server-only";

import { Prisma } from "@prisma/client";

// ─── Curated dependency-safe model order for backup / restore ──────────────
//
// This module encodes the ONLY authoritative list of Prisma models that the
// backup subsystem is allowed to serialize. It is deliberately hand-curated
// (NOT derived at runtime from `Prisma.dmmf.datamodel`) for two reasons:
//
//   1. SECURITY: adding a new model to the schema must force an explicit
//      code review of "does this belong in a backup? what are its FK
//      dependencies?". If the answer is "yes", the developer adds it here
//      in the correct dependency position. If the answer is "no" (e.g.
//      because it's an ephemeral cache that should not persist across a
//      restore), the developer adds it to `EXCLUDED_MODELS` with a
//      justifying comment. Either way, the choice is auditable.
//
//   2. CORRECTNESS: the FK graph implies a partial order for restore-time
//      insert. Automatic derivation from DMMF would pick SOME topological
//      sort, but not necessarily one that matches human intent (e.g.,
//      keeping AdminUser before Speaker so the optional
//      Speaker.adminUserId FK inserts without deferral).
//
// SCHEMA-DRIFT GUARD: `assertModelCoverage()` runs at module load and
// throws if the schema has grown or shrunk vs. the curated list. This
// closes the "developer added a model and forgot to backup it" gap.

/**
 * Backup export order — parents-first, children-last. This is also the
 * order the restore engine (Phase 7) will INSERT rows into an empty DB.
 * See §"Phase 4 Export order" in BACKUP_RESTORE_IMPLEMENTATION_PLAN.md
 * for the reasoning per row.
 */
export const MODEL_ORDER = [
  // ── Roots (no outbound FKs) ──
  "Event",
  "AdminUser",
  "AccountUser",
  "AccessPoint",
  "SiteContent",
  "EmailTemplate",
  "EmailMessage", // participantId/sentByUserId are unlinked strings, not FKs
  "RolePermissionOverride",
  "BackupSchedule",

  // ── Depend on Event / AdminUser / AccessPoint ──
  "Speaker", // → Event, AdminUser (optional)
  "Space", // → Event
  "Partner", // → Event
  "Session", // → Event, Space (optional)
  "SessionSpeaker", // → Session, Speaker

  // ── Depend on AccountUser + Event ──
  "Participant", // → Event, AccountUser (optional)
  "OnboardingSession", // → Participant
  "Application", // → Event, Participant (optional)

  // ── Depend on Participant / AccessPoint ──
  "ParticipantAccess", // → Participant, AccessPoint
  "RoomRegistration", // → Participant, AccessPoint
  "BadgeCredential", // → Participant + self (rotatedFromId, nullable)

  "AccessPointTeamMember", // → AccessPoint, AdminUser

  // ── Session artefacts (depend on their owners) ──
  "AccountSession", // → AccountUser
  "AdminSession", // → AdminUser
  "EmailVerificationToken", // → AccountUser
  "PasswordResetToken", // → AccountUser
  "EmailTemplateVersion", // → EmailTemplate

  // ── Audit / operational history (depend on many) ──
  "CheckIn", // → Participant, AdminUser, AccessPoint, BadgeCredential (all nullable)
  "AuditLog", // → AdminUser (nullable)

  // ── Backup subsystem's own history (depends on AdminUser + self) ──
  "Backup", // → AdminUser (nullable, x2)
  "RestoreOperation" // → Backup (RESTRICT), Backup (SetNull), AdminUser (RESTRICT)
] as const;

export type BackupModelName = (typeof MODEL_ORDER)[number];

/**
 * Reverse of MODEL_ORDER — used by the restore engine (Phase 7) to
 * DELETE rows in FK-safe order before re-inserting.
 */
export const DROP_ORDER = [...MODEL_ORDER].reverse() as readonly BackupModelName[];

/**
 * Models INTENTIONALLY excluded from backup / restore. If a future model
 * is intentionally excluded (e.g., ephemeral cache), add it here with a
 * justifying comment AND update `assertModelCoverage` below.
 */
export const EXCLUDED_MODELS = new Set<string>([
  // Google Drive off-site replication metadata is intentionally
  // excluded (Layer A carry-over — first surfaced by the Layer G
  // regression gate).
  //
  //   * `BackupReplication` holds `uploadSessionUri` — a Drive
  //     resumable-upload session URI that is bearer-equivalent
  //     (see docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §G, §R).
  //     Serialising it into a backup file would embed a live
  //     credential into the ciphertext. The value is ephemeral (~7d
  //     expiry) and self-healable, so its inclusion adds risk without
  //     restoring recoverable state.
  //   * `BackupReplicationConfig` holds `folderId` + `folderMarker`.
  //     These are NOT secrets, but the marker-based re-discovery flow
  //     (§E.3) is designed so that after any DB restore the operator's
  //     next `backup:drive-bootstrap` invocation re-derives the
  //     folderId. Bundling the row into a backup would pin a stale
  //     folderId across environments (dev restored from prod), which
  //     the marker discovery explicitly wants to avoid.
  //
  // Post-restore, the replication worker's self-heal scan (§L.2) will
  // enqueue every VERIFIED backup that lacks a replication row within
  // one worker tick — no operator action required.
  "BackupReplication",
  "BackupReplicationConfig"
]);

/**
 * Schema-drift guard. Compares the curated list against `Prisma.ModelName`
 * (which is generated from `prisma/schema.prisma`). Any mismatch means
 * the schema has grown or shrunk and this module MUST be updated before
 * the next backup runs.
 *
 * Called at first use by the dump engine — not at module import — so a
 * failing check does not crash the Next.js boot for unrelated code paths.
 */
export function assertModelCoverage(): void {
  const generated = new Set(Object.keys(Prisma.ModelName));
  const curated = new Set<string>(MODEL_ORDER);
  const covered = new Set([...curated, ...EXCLUDED_MODELS]);

  const missingFromCoverage: string[] = [];
  for (const name of generated) {
    if (!covered.has(name)) missingFromCoverage.push(name);
  }
  const strangers: string[] = [];
  for (const name of curated) {
    if (!generated.has(name)) strangers.push(name);
  }

  if (missingFromCoverage.length > 0 || strangers.length > 0) {
    const parts: string[] = [];
    if (missingFromCoverage.length > 0) {
      parts.push(
        `models in schema but not classified in lib/backup/model-order.ts: ${missingFromCoverage.join(", ")}`
      );
    }
    if (strangers.length > 0) {
      parts.push(
        `models listed in lib/backup/model-order.ts but no longer in schema: ${strangers.join(", ")}`
      );
    }
    throw new Error(
      `Backup subsystem model coverage drifted. Fix before running any backup or restore. ${parts.join("; ")}.`
    );
  }
}

/**
 * Prisma model-name → delegate accessor. Prisma exposes each model on
 * the client as a camelCased property (`Backup` → `prisma.backup`). This
 * helper is the single source of truth for that mapping — callers pass
 * a `PrismaClient` instance and a model name from `MODEL_ORDER`, and
 * receive the appropriate delegate.
 */
export function delegateFor<T>(
  client: T,
  model: BackupModelName
): {
  findMany(args?: {
    take?: number;
    skip?: number;
    cursor?: Record<string, string>;
    orderBy?: unknown;
  }): Promise<Array<Record<string, unknown>>>;
  count(): Promise<number>;
} {
  const key = camelCase(model);
  const delegate = (client as unknown as Record<string, unknown>)[key];
  if (!delegate) {
    throw new Error(`Prisma client has no delegate for model "${model}" (property "${key}").`);
  }
  return delegate as ReturnType<typeof delegateFor<T>>;
}

function camelCase(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

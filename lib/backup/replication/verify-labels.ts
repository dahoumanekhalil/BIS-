import "server-only";

// UI labels for remote verification state (§J.4 honesty gate).
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §J.4.
//
// The single most important honesty rule in this whole subsystem:
//   * NEVER label a `METADATA_ONLY` result as `SHA-256 OK`.
//   * NEVER conflate Google's MD5 metadata with our own SHA-256.
//   * A user reading an admin screen must be able to tell exactly what
//     was actually verified.
//
// The labels are French to match the admin UI's language. Every
// literal is spelled out here rather than inlined in a page component
// so a search for a regressing string will find exactly one hit.

import type {
  BackupReplicationErrorCode,
  BackupReplicationVerifyLevel
} from "@prisma/client";

// ─── Exact wording — DO NOT change without an ADR ─────────────────────────
// The strings below are asserted by test suite `backup-drive-verify-remote`.
// Any drift in wording is a security-review blocker (see §J.4).

export const LABEL_METADATA_OK = "Vérification distante : métadonnées OK";
export const LABEL_FULL_SHA256_OK = "Vérification distante : SHA-256 complet OK";
export const LABEL_NONE = "Vérification distante : non effectuée";

/**
 * Build the failure label. The reader sees the classified errorCode
 * only (a stable snake-case enum). Never a raw exception message,
 * never a URL, never a token.
 */
export function labelForFailure(errorCode: BackupReplicationErrorCode): string {
  return `Vérification distante : échec — ${errorCode}`;
}

/**
 * Resolve the display label for a `BackupReplication` row projection.
 * The caller passes the row's `lastVerifyLevel` and `errorCode`.
 *
 * Semantics:
 *   * `errorCode != NONE`   → failure label with the code.
 *   * `lastVerifyLevel = FULL_SHA256`  → full SHA-256 label.
 *   * `lastVerifyLevel = METADATA_ONLY` → metadata-only label.
 *   * `lastVerifyLevel = NONE` → not-verified label.
 *
 * The precedence "errorCode before verifyLevel" matches the plan's
 * §K.10 rule: a deep-verify failure keeps the row status COMPLETED
 * but surfaces the mismatch. The admin's expectation reading the
 * label is "is the remote object trustworthy right now?" — an
 * errorCode says "no, and here is why". A stale `FULL_SHA256` verify
 * that later mismatched is exactly this state.
 */
export function remoteVerifyLabel(input: {
  lastVerifyLevel: BackupReplicationVerifyLevel;
  errorCode: BackupReplicationErrorCode;
}): string {
  if (input.errorCode !== "NONE") {
    return labelForFailure(input.errorCode);
  }
  switch (input.lastVerifyLevel) {
    case "FULL_SHA256":
      return LABEL_FULL_SHA256_OK;
    case "METADATA_ONLY":
      return LABEL_METADATA_OK;
    case "NONE":
      return LABEL_NONE;
  }
}

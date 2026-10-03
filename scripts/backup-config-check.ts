// Standalone CLI: verify the backup subsystem's environment configuration
// without producing any side-effects (no dump, no verify, no DB write).
//
// Usage:
//   npx tsx scripts/backup-config-check.ts
//
// Exit code 0  → every required config item is OK.
// Exit code 1  → at least one item is MISSING / MALFORMED / TOO_SHORT.
//
// Prints ONLY the status enum values, never the underlying secret material.
// Suitable for a production deploy-gate script.

// Standalone Node CLI — deliberately does NOT import "server-only"
// because tsx / node run it directly; the transitive `lib/backup/config`
// module is guarded by its own "server-only" import which will refuse
// bundling into a client build.

import { backupConfigStatus, loadBackupTickSecret } from "../lib/backup/config";
import { googleDriveConfigStatus } from "../lib/backup/replication/config";

async function main(): Promise<void> {
  const status = backupConfigStatus();
  const issues: string[] = [];

  process.stdout.write("─── Backup subsystem config check ───\n");
  const rows: Array<[string, string]> = [
    ["encryptionKey (BACKUP_ENCRYPTION_KEY)", status.encryptionKey],
    ["storageDir    (BACKUP_STORAGE_DIR)", status.storageDir],
    ["tickSecret    (INTERNAL_BACKUP_TICK_SECRET)", status.tickSecret]
  ];
  for (const [label, value] of rows) {
    const badge = value === "OK" ? "OK  " : "FAIL";
    process.stdout.write(`  [${badge}] ${label.padEnd(45)} → ${value}\n`);
    if (value !== "OK") {
      issues.push(`${label} → ${value}`);
    }
  }

  // Cross-check: even if the tick secret is present, confirm the
  // ≥24-char floor is enforced by the actual loader (not just a
  // string-length check that could drift over time).
  try {
    loadBackupTickSecret();
  } catch (err) {
    const msg =
      err instanceof Error ? err.constructor.name : "unknown-error";
    // We deliberately do NOT emit err.message — it may hint at length
    // policy details that are already documented in the README.
    issues.push(`tick secret loader threw: ${msg}`);
  }

  // ─── Google Drive off-site replication (Layer C + Q) ───────────────────
  // Fail-closed rule (§Q.3): a DISABLED replication is a valid deploy
  // state — the local backup subsystem is unaffected. But an ENABLED
  // flag with any non-OK credentials/folder value is a configuration
  // error and blocks the deploy. `reachable` is a live probe owned by
  // the drive client (Layer B/D) — this passive check always reports
  // NOT_CHECKED and does not fail the deploy.
  process.stdout.write("\n─── Google Drive replication ───\n");
  let drive;
  try {
    drive = await googleDriveConfigStatus();
  } catch (err) {
    // The status function is documented to never reject — surface any
    // unexpected throw as an issue rather than crashing the CLI.
    const name = err instanceof Error ? err.constructor.name : "unknown-error";
    process.stdout.write(`  [FAIL] googleDriveConfigStatus threw: ${name}\n`);
    issues.push(`googleDriveConfigStatus threw: ${name}`);
    finish(issues);
    return;
  }

  const disabledDetail = "(not checked while disabled)";
  const flagBadge = drive.flag === "ENABLED" ? "OK  " : "INFO";
  process.stdout.write(
    `  [${flagBadge}] flag        (GOOGLE_DRIVE_BACKUP_ENABLED)      → ${drive.flag}\n`
  );

  if (drive.flag === "DISABLED") {
    process.stdout.write(
      `  [INFO] credentials                                 → ${disabledDetail}\n`
    );
    process.stdout.write(
      `  [INFO] folder                                      → ${disabledDetail}\n`
    );
    process.stdout.write(
      `  [INFO] reachable                                   → ${disabledDetail}\n`
    );
  } else {
    const credBadge = drive.credentials === "OK" ? "OK  " : "FAIL";
    process.stdout.write(
      `  [${credBadge}] credentials                                 → ${drive.credentials}\n`
    );
    if (drive.credentials !== "OK") {
      issues.push(`drive credentials → ${drive.credentials}`);
    }

    const folderBadge = drive.folder === "OK" ? "OK  " : "FAIL";
    process.stdout.write(
      `  [${folderBadge}] folder                                      → ${drive.folder}\n`
    );
    if (drive.folder !== "OK") {
      issues.push(`drive folder → ${drive.folder}`);
    }

    // `reachable` is informational at this layer. A future extension of
    // the CLI (post Layer B) can flip this to fail on UNREACHABLE.
    process.stdout.write(
      `  [INFO] reachable                                   → ${drive.reachable}\n`
    );
  }

  finish(issues);
}

function finish(issues: string[]): void {
  process.stdout.write("\n");
  if (issues.length > 0) {
    process.stdout.write(`Configuration NOT ready. ${issues.length} issue(s):\n`);
    for (const s of issues) process.stdout.write(`  - ${s}\n`);
    process.stdout.write(
      "\nSee BACKUP_RESTORE_OPERATOR_RUNBOOK.md § Key management for setup.\n"
    );
    process.exit(1);
  }
  process.stdout.write("Configuration OK. Backup subsystem is deploy-ready.\n");
  process.exit(0);
}

main().catch((err) => {
  // Defensive: if `main` somehow throws (should not — every error path is
  // handled internally), fail with a clean non-zero exit and a name-only
  // diagnostic. Never print the raw error message — it may include env
  // fragments if a downstream loader ever changes its policy.
  const name = err instanceof Error ? err.constructor.name : "unknown-error";
  process.stderr.write(`backup-config-check crashed: ${name}\n`);
  process.exit(1);
});

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

function main(): void {
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

main();

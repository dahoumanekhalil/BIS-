// DR-NONPROD local backup + verification (W.1 Gate F).
//
// Runs the real production backup pipeline (`runBackupDump` + `verifyBackup`)
// against the dedicated DR database so §F can produce a REAL encrypted,
// manifest-backed, cryptographically verified backup from the deterministic
// DR dataset. This is PRE-DR PREPARATION EVIDENCE only — it is NOT itself
// DR success (W.2 is the remote round-trip).
//
// IMPORTANT:
//   * Refuses to run unless DR_ENVIRONMENT_LABEL=DR-NONPROD.
//   * Writes to BACKUP_STORAGE_DIR (dedicated DR path, outside the app tree).
//   * Does NOT contact Google Drive. Does NOT execute W.2 or W.3.

import { runBackupDump } from "../lib/backup/dump";
import { verifyBackup } from "../lib/backup/verify";

if (process.env.DR_ENVIRONMENT_LABEL !== "DR-NONPROD") {
  process.stderr.write(
    "Refusing to run DR backup: DR_ENVIRONMENT_LABEL != 'DR-NONPROD'.\n"
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const dump = await runBackupDump({ kind: "MANUAL", createdById: null });
  process.stdout.write(
    `[dump] OK — backupId=${dump.backupId} sizeBytes=${dump.sizeBytes} rows=${dump.totalRows}\n`
  );
  const verify = await verifyBackup({
    backupId: dump.backupId,
    persist: true
  });
  process.stdout.write(
    `[verify] outcome=${verify.outcome} code=${verify.code} stage=${verify.stage}\n`
  );
  if (verify.outcome !== "VERIFIED") {
    process.stderr.write("DR backup failed verification — aborting.\n");
    process.exit(2);
  }
  process.stdout.write(
    `[verify] OK — contentSha256=${verify.contentSha256?.slice(0, 16)}… totalRows=${verify.totalRows} schemaCompatible=${verify.schemaCompatible}\n`
  );
}

main().catch((err) => {
  process.stderr.write(
    "DR backup failed: " +
      (err instanceof Error ? err.constructor.name : "unknown") +
      "\n" +
      (err instanceof Error && err.message ? err.message + "\n" : "")
  );
  process.exit(1);
});

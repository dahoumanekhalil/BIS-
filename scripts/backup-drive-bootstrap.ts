// Google Drive folder bootstrap for backup off-site replication
// (Layer B.3 — docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md).
//
// Usage (after `scripts/google-drive-authorize.ts` produced a refresh
// token that was pasted into the operator's secret manager):
//
//   GOOGLE_DRIVE_CLIENT_ID="…" GOOGLE_DRIVE_CLIENT_SECRET="…" \
//   GOOGLE_DRIVE_REFRESH_TOKEN="…" \
//     npx tsx scripts/backup-drive-bootstrap.ts
//
// Bootstrap responsibilities (in order):
//   1. Load + validate the OAuth env via Layer C's loader (no duplicate
//      env parsing). Skips the `GOOGLE_DRIVE_BACKUP_ENABLED` flag —
//      bootstrap is done BEFORE flipping the flag.
//   2. Instantiate an OAuth2Client and prove the refresh token works
//      by calling `about.get(fields: 'storageQuota')`. Print quota
//      TOTALS ONLY — never the account email or user id.
//   3. Locate the app-managed folder by `appProperties.marker` (Layer E)
//      — the identity anchor that survives folder renames. Multiple
//      matches → refuse (DUPLICATE_FOLDER_DETECTED).
//   4. If none found, create it with the configured `folderName` and
//      the marker in `appProperties`.
//   5. Persist `folderId` on the `BackupReplicationConfig` singleton
//      and set `bootstrappedAt` + `lastReconciledAt`.
//   6. Print the folder id (safe — not secret; visible in Drive URLs)
//      and the Drive URL for manual visual confirmation.
//
// Absolute rules enforced here:
//   * Never print the client secret, refresh token, access token, or
//     Authorization header.
//   * All error paths use `err.constructor.name` — never `err.message`.
//   * No files are written to disk. All state lives in the DB row.

import { google } from "googleapis";
import type { drive_v3 } from "googleapis";

import { prisma } from "../lib/db";
import { loadGoogleDriveConfigForBootstrap } from "../lib/backup/replication/config";
import { classifyGoogleError } from "../lib/backup/replication/classifier";
import {
  APP_PROPERTY_MARKER_KEY,
  FOLDER_MIME_TYPE,
  assertSafeFolderMarker
} from "../lib/backup/replication/folder";

const CONFIG_ID = "google_drive";

// Bytes → human string, TOTALS ONLY. No account identifier ever printed.
function formatBytes(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "unknown";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(2)} ${units[u]}`;
}

function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

async function verifyCredentials(drive: drive_v3.Drive): Promise<void> {
  // Only request `storageQuota` — do NOT request `user` (which returns
  // email + display name). Even totals are enough to prove the token
  // works AND give the operator visibility into headroom.
  const resp = await drive.about.get({ fields: "storageQuota" });
  const quota = resp.data.storageQuota;
  if (!quota) {
    process.stdout.write("[ok] credentials verified (quota unknown)\n");
    return;
  }
  const limit = formatBytes(quota.limit);
  const usage = formatBytes(quota.usage);
  const inDrive = formatBytes(quota.usageInDrive);
  process.stdout.write(
    `[ok] credentials verified — quota total ${limit}, used ${usage} ` +
      `(in Drive: ${inDrive})\n`
  );
}

async function findExistingFolder(
  drive: drive_v3.Drive,
  marker: string
): Promise<{ id: string; name: string } | "none" | "duplicate"> {
  // Layer E shared validator. Defense-in-depth against a DB-admin
  // edit that could break out of the Drive `q=` quoted-string grammar.
  assertSafeFolderMarker(marker);
  // With scope `drive.file` we can only see files the app itself created.
  // The very first bootstrap will have no matches; subsequent runs
  // (idempotent re-bootstrap, DB-restore recovery) must find exactly one.
  const q =
    `appProperties has { key='${APP_PROPERTY_MARKER_KEY}' and value='${marker}' } ` +
    `and mimeType='${FOLDER_MIME_TYPE}' ` +
    `and trashed=false`;
  const resp = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 10,
    spaces: "drive"
  });
  const files = resp.data.files ?? [];
  if (files.length === 0) return "none";
  if (files.length > 1) return "duplicate";
  const only = files[0];
  if (!only || typeof only.id !== "string" || only.id.length === 0) {
    return "none";
  }
  return { id: only.id, name: only.name ?? "" };
}

async function createFolder(
  drive: drive_v3.Drive,
  folderName: string,
  marker: string
): Promise<{ id: string }> {
  const resp = await drive.files.create({
    fields: "id",
    requestBody: {
      name: folderName,
      mimeType: FOLDER_MIME_TYPE,
      appProperties: { [APP_PROPERTY_MARKER_KEY]: marker }
    }
  });
  const id = resp.data.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("drive_create_returned_no_id");
  }
  return { id };
}

async function main(): Promise<void> {
  const cfg = loadGoogleDriveConfigForBootstrap();

  // Read folder naming defaults from the singleton row — this is the
  // authoritative source for `folderName` + `folderMarker`, seeded by
  // Layer A's SQL delta.
  const singleton = await prisma.backupReplicationConfig.findUnique({
    where: { id: CONFIG_ID },
    select: {
      folderId: true,
      folderName: true,
      folderMarker: true
    }
  });
  if (!singleton) {
    process.stderr.write(
      `BackupReplicationConfig row '${CONFIG_ID}' is missing. Apply ` +
        "prisma/sql/2026-backup-drive-replication.sql or run " +
        "`npm run db:push` first.\n"
    );
    process.exit(1);
  }

  const oauth = new google.auth.OAuth2({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret
  });
  oauth.setCredentials({ refresh_token: cfg.refreshToken });
  // G2 finding M2: NEVER mutate `google.options` at bootstrap time.
  // The bootstrap script is short-lived (`about.get` + at most one
  // `files.list` + one `files.create`), so we rely on gaxios's default
  // per-request timeout. If a hung TLS connection ever pins the
  // bootstrap script, the operator can Ctrl-C — this is an interactive
  // CLI, not a daemon. Per-call timeouts in the long-running worker
  // are Layer G's responsibility (see `getResolvedGoogleDriveHttpTimeoutMs`).
  const drive = google.drive({ version: "v3", auth: oauth });

  try {
    await verifyCredentials(drive);
  } catch (err) {
    const c = classifyGoogleError(err);
    process.stderr.write(
      `[fail] verifyCredentials: ${c.sanitizedMessage}\n`
    );
    process.exit(2);
  }

  process.stdout.write(
    `\nLooking for existing folder (marker='${singleton.folderMarker}') ...\n`
  );

  let existing;
  try {
    existing = await findExistingFolder(drive, singleton.folderMarker);
  } catch (err) {
    const c = classifyGoogleError(err);
    process.stderr.write(`[fail] findExistingFolder: ${c.sanitizedMessage}\n`);
    process.exit(3);
  }

  if (existing === "duplicate") {
    // G2 finding M4: emit the marker on its own line rather than
    // embedding it into a URL — avoids any risk of a marker character
    // producing a malformed / misleading link.
    process.stderr.write(
      "[fail] DUPLICATE_FOLDER_DETECTED — more than one folder in Drive " +
        "carries the app marker. Manually remove the stale duplicate " +
        "and rerun. Marker value:\n"
    );
    process.stderr.write(`  ${singleton.folderMarker}\n`);
    process.exit(4);
  }

  let folderId: string;
  let auditAction: "folder.discovered" | "folder.bootstrap";
  if (existing === "none") {
    process.stdout.write("[ok] no existing folder; creating one ...\n");
    try {
      const created = await createFolder(
        drive,
        singleton.folderName,
        singleton.folderMarker
      );
      folderId = created.id;
      auditAction = "folder.bootstrap";
    } catch (err) {
      const c = classifyGoogleError(err);
      process.stderr.write(`[fail] createFolder: ${c.sanitizedMessage}\n`);
      process.exit(5);
    }
  } else {
    process.stdout.write(
      `[ok] discovered existing folder (name='${existing.name}')\n`
    );
    folderId = existing.id;
    auditAction = "folder.discovered";
  }

  // Cross-check env override.
  if (
    cfg.folderIdFromEnv !== null &&
    cfg.folderIdFromEnv !== folderId
  ) {
    process.stderr.write(
      "[fail] MISMATCH — GOOGLE_DRIVE_FOLDER_ID env override does not " +
        "match the folder id found in Drive. Unset the env override or " +
        "reconcile manually before proceeding.\n"
    );
    process.exit(6);
  }

  const now = new Date();
  await prisma.backupReplicationConfig.update({
    where: { id: CONFIG_ID },
    data: {
      folderId,
      bootstrappedAt:
        auditAction === "folder.bootstrap" && singleton.folderId === null
          ? now
          : undefined,
      lastReconciledAt: now
    }
  });

  await prisma.auditLog.create({
    data: {
      action: `backup.replication.${auditAction}`,
      entity: "BackupReplicationConfig",
      entityId: CONFIG_ID,
      // Meta is JSON — folder id + marker are safe (not secrets); no
      // credentials touched. `bootstrappedAt` is timestamp-only.
      meta: {
        destination: "GOOGLE_DRIVE",
        folderId,
        folderMarker: singleton.folderMarker,
        folderName: singleton.folderName
      }
    }
  });

  process.stdout.write("\n─── Bootstrap complete ───\n");
  process.stdout.write(`  folderId : ${folderId}\n`);
  process.stdout.write(`  URL      : ${driveFolderUrl(folderId)}\n`);
  process.stdout.write(
    "\nOpen the URL in your browser and confirm the folder exists.\n" +
      "Then set GOOGLE_DRIVE_BACKUP_ENABLED=true in the deployment " +
      "environment and restart the app.\n"
  );

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  // Defensive catch — every operational error path above already
  // handled its own sanitized reporting. This is for unexpected
  // exceptions (e.g. missing config row, DB down). Emit name only.
  const name = err instanceof Error ? err.constructor.name : "Error";
  process.stderr.write(`Bootstrap script failed: ${name}\n`);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});

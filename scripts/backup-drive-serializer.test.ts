// Layer F browser-projection safety tests.
// Run with: npm run test:backup-drive-serializer
//
// The single load-bearing invariant this suite proves:
//
//   `serializeReplicationForBrowser(row)` NEVER returns a value whose
//   JSON-stringified form contains the row's `uploadSessionUri`,
//   `uploadSessionExpiresAt`, or `uploadBytesSent`.
//
// Method: build a `BackupReplication`-shaped object where every hidden
// field contains a deliberately sensitive-looking sentinel string. Run
// the projection. Grep the JSON output for every sentinel. Assert none
// appear. Also assert every expected public field IS present.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { BackupReplication } from "@prisma/client";

import {
  REPLICATION_FIELDS_NEVER_PUBLIC,
  serializeReplicationForBrowser
} from "../lib/backup/replication/serializer";

// Sensitive-looking sentinel values planted in every field that the
// projection must NOT expose. Every string is unmistakable so a grep
// leaves no ambiguity.
const SENTINEL = {
  uploadSessionUri:
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION_URI_SENTINEL_MUST_NOT_LEAK",
  uploadSessionExpires: new Date("2027-01-01T00:00:00Z"),
  uploadBytesSent: BigInt("999999999999999")
};

function makeRow(overrides: Partial<BackupReplication> = {}): BackupReplication {
  const now = new Date("2026-09-29T12:34:56Z");
  const row: BackupReplication = {
    id: "rep-id-1",
    backupId: "backup-id-1",
    destination: "GOOGLE_DRIVE",
    status: "UPLOADING",
    remoteBinFileId: "drive-bin-id",
    remoteManifestFileId: "drive-manifest-id",
    remoteFolderId: "drive-folder-id",
    remoteBinSize: BigInt(1024),
    remoteManifestSize: BigInt(512),
    remoteBinMd5: "d41d8cd98f00b204e9800998ecf8427e",
    remoteManifestMd5: "d41d8cd98f00b204e9800998ecf8427e",
    attestedContentSha256: null,
    lastVerifyLevel: "METADATA_ONLY",
    lastVerifiedAt: now,
    uploadSessionUri: SENTINEL.uploadSessionUri,
    uploadSessionExpiresAt: SENTINEL.uploadSessionExpires,
    uploadBytesSent: SENTINEL.uploadBytesSent,
    uploadStartedAt: now,
    uploadCompletedAt: null,
    lastAttemptAt: now,
    attemptCount: 3,
    nextRetryAt: null,
    errorCode: "NONE",
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as BackupReplication;
  return row;
}

describe("serializeReplicationForBrowser — hidden-field guarantees", () => {
  test("JSON output never contains uploadSessionUri sentinel", () => {
    const row = makeRow();
    const view = serializeReplicationForBrowser(row);
    const json = JSON.stringify(view);
    assert.ok(
      !json.includes("SESSION_URI_SENTINEL_MUST_NOT_LEAK"),
      "uploadSessionUri leaked into the browser projection"
    );
  });

  test("JSON output never contains uploadSessionExpiresAt value", () => {
    const row = makeRow();
    const view = serializeReplicationForBrowser(row);
    const json = JSON.stringify(view);
    // The sentinel Date's ISO form MUST NOT appear.
    assert.ok(
      !json.includes(SENTINEL.uploadSessionExpires.toISOString()),
      "uploadSessionExpiresAt leaked into the browser projection"
    );
  });

  test("JSON output never contains uploadBytesSent value", () => {
    const row = makeRow();
    const view = serializeReplicationForBrowser(row);
    const json = JSON.stringify(view);
    assert.ok(
      !json.includes(SENTINEL.uploadBytesSent.toString()),
      "uploadBytesSent leaked into the browser projection"
    );
  });

  test("the projection object has no forbidden key", () => {
    const row = makeRow();
    const view = serializeReplicationForBrowser(row);
    const keys = Object.keys(view);
    for (const forbidden of REPLICATION_FIELDS_NEVER_PUBLIC) {
      assert.ok(
        !keys.includes(forbidden),
        `projection must not include ${forbidden}`
      );
    }
  });

  test("expected public fields ARE present (audit + operational visibility)", () => {
    const row = makeRow();
    const view = serializeReplicationForBrowser(row);
    const mustHave = [
      "id",
      "backupId",
      "destination",
      "status",
      "errorCode",
      "errorMessage",
      "lastVerifyLevel",
      "attestedContentSha256",
      "lastVerifiedAt",
      "uploadStartedAt",
      "uploadCompletedAt",
      "lastAttemptAt",
      "attemptCount",
      "nextRetryAt",
      "remoteFolderId",
      "remoteBinFileId",
      "remoteManifestFileId",
      "remoteBinSize",
      "remoteManifestSize",
      "remoteBinMd5",
      "remoteManifestMd5",
      "createdAt",
      "updatedAt"
    ];
    for (const k of mustHave) {
      assert.ok(k in view, `projection is missing public field: ${k}`);
    }
  });

  test("BigInt sizes are serialized to decimal strings (JSON-safe)", () => {
    const row = makeRow();
    const view = serializeReplicationForBrowser(row);
    assert.equal(typeof view.remoteBinSize, "string");
    assert.equal(view.remoteBinSize, "1024");
    assert.equal(typeof view.remoteManifestSize, "string");
    assert.equal(view.remoteManifestSize, "512");
  });

  test("dates are serialized to ISO strings; nulls stay null", () => {
    const row = makeRow({ uploadCompletedAt: null, lastAttemptAt: null });
    const view = serializeReplicationForBrowser(row);
    assert.equal(view.uploadCompletedAt, null);
    assert.equal(view.lastAttemptAt, null);
    assert.equal(view.createdAt, "2026-09-29T12:34:56.000Z");
    assert.equal(view.updatedAt, "2026-09-29T12:34:56.000Z");
  });

  test("even a FAILED row with uploadSessionUri still present does not leak", () => {
    // Failed replications keep uploadSessionUri around for admin
    // resume — the projection must still hide it.
    const row = makeRow({ status: "FAILED", errorCode: "SERVER_ERROR" });
    const view = serializeReplicationForBrowser(row);
    assert.ok(
      !JSON.stringify(view).includes("SESSION_URI_SENTINEL_MUST_NOT_LEAK"),
      "FAILED row must still hide uploadSessionUri"
    );
    assert.equal(view.status, "FAILED");
    assert.equal(view.errorCode, "SERVER_ERROR");
  });
});

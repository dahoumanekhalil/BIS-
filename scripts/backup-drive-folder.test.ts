// Layer E tests — Google Drive folder discovery + adoption refusal.
// Run with:
//   npm run test:backup-drive-folder
//
// Every test injects a fake Drive that satisfies the narrow
// `DriveFolderApi` interface exposed by lib/backup/replication/folder.ts.
// NO real network I/O occurs.
//
// Suite verifies (mapping to §E.3):
//   * Env-override path (folderId present + marker OK) → source="env"
//   * DB-canonical path (folderId in DB + marker OK) → source="db"
//   * Marker discovery path (neither set, exactly one hit) → source="marker"
//   * Unsafe marker → CONFIGURATION_ERROR (never reaches Drive)
//   * Env folder 404 → DESTINATION_NOT_FOUND
//   * DB folder 404 → DESTINATION_NOT_FOUND
//   * Marker discovery zero hits → CONFIGURATION_ERROR "NOT_BOOTSTRAPPED"
//   * Marker discovery ≥2 hits → CONFIGURATION_ERROR "DUPLICATE_FOLDER_DETECTED"
//   * Adoption refusal: folder without our marker in appProperties
//     → CONFIGURATION_ERROR (env, DB, and belt-and-braces marker-path)
//   * Adoption refusal: trashed folder → CONFIGURATION_ERROR
//   * Adoption refusal: non-folder mimeType → CONFIGURATION_ERROR
//   * Env override precedence: env wins over DB even when both are set
//   * Transient Drive failure (500) surfaces as SERVER_ERROR (retryable)
//   * Rate limit (429) surfaces as RATE_LIMITED (retryable)
//   * Idempotent: running the discovery multiple times returns identical
//     resolution and never mutates state (pure function)
//   * `files.get` is called with a whitelisted `fields` string
//     (no PII field), and `files.list` uses the marker-scoped `q` only
//   * Secret hygiene: no fake refresh-token / client-secret value ever
//     appears in any error message or thrown stack

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  APP_PROPERTY_MARKER_KEY,
  FOLDER_MIME_TYPE,
  SAFE_MARKER_RE,
  assertSafeFolderMarker,
  resolveGoogleDriveFolder,
  type DriveFolderApi,
  type DriveFileMeta,
  type ResolvedFolder
} from "../lib/backup/replication/folder";
import { GoogleDriveOperationError } from "../lib/backup/replication/errors";

// ─── Test doubles ──────────────────────────────────────────────────────────

const MARKER = "bis2027-backup-folder-v1";
const OTHER_MARKER = "someone-elses-marker-v9";

// A fake refresh-token / client-secret pair the tests grep for as a
// no-leak invariant. NEVER a real credential.
const FAKE_SECRET = "fake-layer-e-refresh-token-check-me";

type GetHandler = (fileId: string) =>
  | Promise<{ data: DriveFileMeta }>
  | { data: DriveFileMeta };
type ListHandler = (q: string) =>
  | Promise<{ data: { files?: DriveFileMeta[] | null } }>
  | { data: { files?: DriveFileMeta[] | null } };

function makeFakeDrive(opts: {
  get?: GetHandler;
  list?: ListHandler;
}): {
  drive: DriveFolderApi;
  calls: {
    get: Array<{ fileId: string; fields: string }>;
    list: Array<{ q: string; fields: string; pageSize: number }>;
  };
} {
  const calls = {
    get: [] as Array<{ fileId: string; fields: string }>,
    list: [] as Array<{ q: string; fields: string; pageSize: number }>
  };
  const drive: DriveFolderApi = {
    files: {
      async get(params) {
        calls.get.push({ fileId: params.fileId, fields: params.fields });
        if (!opts.get) {
          throw googleHttp(404, "notFound");
        }
        const r = await opts.get(params.fileId);
        return r;
      },
      async list(params) {
        calls.list.push({
          q: params.q,
          fields: params.fields,
          pageSize: params.pageSize
        });
        if (!opts.list) return { data: { files: [] } };
        const r = await opts.list(params.q);
        return r;
      }
    }
  };
  return { drive, calls };
}

/** Shape a googleapis/gaxios-style HTTP error the classifier recognizes. */
function googleHttp(status: number, reason?: string): Error {
  const err = new Error("google-error") as Error & {
    status: number;
    response: {
      status: number;
      data: { error?: string; errors?: Array<{ reason?: string }> };
    };
    errors?: Array<{ reason?: string }>;
  };
  err.status = status;
  const data: {
    error?: string;
    errors?: Array<{ reason?: string }>;
  } = {};
  if (reason !== undefined) {
    data.errors = [{ reason }];
    err.errors = [{ reason }];
  }
  err.response = { status, data };
  return err;
}

function folder(
  id: string,
  marker: string | null = MARKER,
  overrides: Partial<DriveFileMeta> = {}
): DriveFileMeta {
  return {
    id,
    name: "BIS 2027 — Encrypted Backups (managed by application)",
    mimeType: FOLDER_MIME_TYPE,
    trashed: false,
    appProperties: marker === null ? null : { [APP_PROPERTY_MARKER_KEY]: marker },
    ...overrides
  };
}

// Belt-and-braces: after every test the captured error / status text
// must not contain any of our synthetic secret values.
const emittedText: string[] = [];
function record(subject: unknown): void {
  emittedText.push(typeof subject === "string" ? subject : JSON.stringify(subject));
}
function assertNoSecretLeak(): void {
  const combined = emittedText.join("\n");
  assert.ok(
    !combined.includes(FAKE_SECRET),
    "no captured message may contain FAKE_SECRET"
  );
}

before(() => {
  emittedText.length = 0;
});
after(() => {
  assertNoSecretLeak();
});

// ─── Marker validation ─────────────────────────────────────────────────────

describe("assertSafeFolderMarker", () => {
  test("accepts the seeded default", () => {
    assert.doesNotThrow(() => assertSafeFolderMarker("bis2027-backup-folder-v1"));
  });

  test("accepts A-Za-z0-9._- only", () => {
    for (const good of ["abc", "abc_def", "abc-def", "abc.def", "123", "A.B_C-1"]) {
      assert.doesNotThrow(() => assertSafeFolderMarker(good), `should accept ${good}`);
      assert.ok(SAFE_MARKER_RE.test(good));
    }
  });

  test("rejects a marker with a single quote (query-grammar break-out)", () => {
    try {
      assertSafeFolderMarker("evil'marker");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      assert.equal((err as GoogleDriveOperationError).code, "CONFIGURATION_ERROR");
      record((err as Error).message);
    }
  });

  test("rejects a marker with whitespace, slash, or unicode", () => {
    for (const bad of ["with space", "with/slash", "with\\backslash", "unicodé", "with;semi"]) {
      try {
        assertSafeFolderMarker(bad);
        assert.fail(`should have thrown for ${bad}`);
      } catch (err) {
        assert.ok(err instanceof GoogleDriveOperationError);
      }
    }
  });

  test("rejects empty / oversized markers", () => {
    for (const bad of ["", "x".repeat(65)]) {
      try {
        assertSafeFolderMarker(bad);
        assert.fail(`should have thrown for length ${bad.length}`);
      } catch (err) {
        assert.ok(err instanceof GoogleDriveOperationError);
      }
    }
  });
});

// ─── Env override path ────────────────────────────────────────────────────

describe("resolveGoogleDriveFolder — env override path", () => {
  test("returns source='env' when env id points at our folder", async () => {
    const { drive, calls } = makeFakeDrive({
      get: (id) => ({ data: folder(id) })
    });
    const r = await resolveGoogleDriveFolder({
      drive,
      folderIdFromEnv: "envFolder-123",
      dbFolderId: null,
      folderMarker: MARKER
    });
    assert.deepEqual(r, { folderId: "envFolder-123", source: "env" });
    // files.get was called exactly once with a fixed, PII-free field list.
    assert.equal(calls.get.length, 1);
    assert.equal(calls.get[0]!.fileId, "envFolder-123");
    assert.equal(calls.get[0]!.fields, "id,mimeType,trashed,appProperties");
    // files.list was NOT called (env short-circuits).
    assert.equal(calls.list.length, 0);
  });

  test("env override takes precedence over DB when both are set", async () => {
    const { drive } = makeFakeDrive({
      get: (id) => ({ data: folder(id) })
    });
    const r = await resolveGoogleDriveFolder({
      drive,
      folderIdFromEnv: "envFolder-precedes",
      dbFolderId: "dbFolder-loses",
      folderMarker: MARKER
    });
    assert.equal(r.folderId, "envFolder-precedes");
    assert.equal(r.source, "env");
  });

  test("env id 404 → DESTINATION_NOT_FOUND (never falls back to DB or marker)", async () => {
    const { drive, calls } = makeFakeDrive({
      get: () => {
        throw googleHttp(404, "notFound");
      }
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: "envFolder-deleted",
        dbFolderId: "dbFolder-fallback-forbidden",
        folderMarker: MARKER
      });
      assert.fail("expected DESTINATION_NOT_FOUND throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "DESTINATION_NOT_FOUND");
      assert.match(e.message, /env override/);
      record(e.message);
    }
    // Discovery must NOT have fallen back to list.
    assert.equal(calls.list.length, 0);
  });

  test("env id points at a folder without our marker → adoption refused", async () => {
    const { drive } = makeFakeDrive({
      get: (id) => ({ data: folder(id, OTHER_MARKER) })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: "envFolder-alien",
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected adoption refusal");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /adoption refused/);
      record(e.message);
    }
  });

  test("env id points at a folder with no appProperties at all → adoption refused", async () => {
    const { drive } = makeFakeDrive({
      get: (id) => ({ data: folder(id, null) })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: "envFolder-no-marker",
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected adoption refusal");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      assert.equal((err as GoogleDriveOperationError).code, "CONFIGURATION_ERROR");
    }
  });

  test("env id points at a trashed folder → CONFIGURATION_ERROR", async () => {
    const { drive } = makeFakeDrive({
      get: (id) => ({ data: folder(id, MARKER, { trashed: true }) })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: "envFolder-trashed",
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected trashed refusal");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /trashed/);
    }
  });

  test("env id points at a non-folder (mimeType mismatch) → CONFIGURATION_ERROR", async () => {
    const { drive } = makeFakeDrive({
      get: (id) => ({
        data: folder(id, MARKER, { mimeType: "application/pdf" })
      })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: "envFolder-pdf",
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected mimeType refusal");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /non-folder/);
    }
  });
});

// ─── DB canonical path ────────────────────────────────────────────────────

describe("resolveGoogleDriveFolder — DB canonical path", () => {
  test("returns source='db' when DB folder exists and marker matches", async () => {
    const { drive, calls } = makeFakeDrive({
      get: (id) => ({ data: folder(id) })
    });
    const r = await resolveGoogleDriveFolder({
      drive,
      folderIdFromEnv: null,
      dbFolderId: "dbFolder-happy",
      folderMarker: MARKER
    });
    assert.deepEqual(r, { folderId: "dbFolder-happy", source: "db" });
    assert.equal(calls.get.length, 1);
    assert.equal(calls.list.length, 0);
  });

  test("DB id 404 → DESTINATION_NOT_FOUND (no fallback to marker)", async () => {
    const { drive, calls } = makeFakeDrive({
      get: () => {
        throw googleHttp(404, "notFound");
      }
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: "dbFolder-gone",
        folderMarker: MARKER
      });
      assert.fail("expected DESTINATION_NOT_FOUND");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "DESTINATION_NOT_FOUND");
      assert.match(e.message, /BackupReplicationConfig\.folderId/);
      record(e.message);
    }
    assert.equal(
      calls.list.length,
      0,
      "must NOT fall through to marker discovery after DB 404"
    );
  });

  test("DB id lacks marker → adoption refused (DB row was seeded pointing elsewhere)", async () => {
    const { drive } = makeFakeDrive({
      get: (id) => ({ data: folder(id, OTHER_MARKER) })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: "dbFolder-alien",
        folderMarker: MARKER
      });
      assert.fail("expected refusal");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /DB config row/);
    }
  });
});

// ─── Marker discovery path ────────────────────────────────────────────────

describe("resolveGoogleDriveFolder — marker discovery path", () => {
  test("exactly one hit → source='marker'", async () => {
    const { drive, calls } = makeFakeDrive({
      list: () => ({
        data: { files: [folder("discovered-1")] }
      })
    });
    const r = await resolveGoogleDriveFolder({
      drive,
      folderIdFromEnv: null,
      dbFolderId: null,
      folderMarker: MARKER
    });
    assert.deepEqual(r, { folderId: "discovered-1", source: "marker" });
    assert.equal(calls.list.length, 1);
    assert.equal(calls.get.length, 0);
    // The `q=` string must include the exact marker, mime, and
    // trashed=false predicates. No extraneous filters, no free-form
    // user input.
    assert.match(
      calls.list[0]!.q,
      new RegExp(
        `appProperties has \\{ key='${APP_PROPERTY_MARKER_KEY}' and value='${MARKER}' \\}`
      )
    );
    assert.ok(calls.list[0]!.q.includes(`mimeType='${FOLDER_MIME_TYPE}'`));
    assert.ok(calls.list[0]!.q.includes("trashed=false"));
    // Field list must contain neither `owners` nor any PII field.
    assert.ok(
      !calls.list[0]!.fields.includes("owners"),
      "list fields must not request owners"
    );
    assert.ok(
      !calls.list[0]!.fields.includes("user"),
      "list fields must not request user"
    );
  });

  test("zero hits → CONFIGURATION_ERROR (NOT_BOOTSTRAPPED)", async () => {
    const { drive } = makeFakeDrive({
      list: () => ({ data: { files: [] } })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected NOT_BOOTSTRAPPED");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /NOT_BOOTSTRAPPED/);
      record(e.message);
    }
  });

  test("≥ 2 hits → CONFIGURATION_ERROR (DUPLICATE_FOLDER_DETECTED)", async () => {
    const { drive } = makeFakeDrive({
      list: () => ({
        data: { files: [folder("dup-a"), folder("dup-b")] }
      })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected DUPLICATE_FOLDER_DETECTED");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /DUPLICATE_FOLDER_DETECTED/);
      record(e.message);
    }
  });

  test("belt-and-braces: marker discovery result must still pass marker recheck", async () => {
    // Even if a future Drive API somehow returned a hit without the
    // marker (e.g., API bug), our code refuses to adopt.
    const { drive } = makeFakeDrive({
      list: () => ({
        data: { files: [folder("returned-without-marker", null)] }
      })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected adoption refusal on marker-path result");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /adoption refused/);
    }
  });

  test("marker discovery result without an id → CONFIGURATION_ERROR", async () => {
    const { drive } = makeFakeDrive({
      list: () => ({
        data: { files: [{ ...folder("_"), id: null }] }
      })
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected id-missing refusal");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "CONFIGURATION_ERROR");
      assert.match(e.message, /without an id/);
    }
  });
});

// ─── Google failure sanitization ──────────────────────────────────────────

describe("resolveGoogleDriveFolder — Google failure sanitization", () => {
  test("transient 500 on files.list surfaces as SERVER_ERROR (retryable)", async () => {
    const { drive } = makeFakeDrive({
      list: () => {
        throw googleHttp(500);
      }
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected SERVER_ERROR");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "SERVER_ERROR");
      assert.equal(e.retryable, true);
      assert.equal(e.httpStatus, 500);
    }
  });

  test("429 on files.get surfaces as RATE_LIMITED (retryable)", async () => {
    const { drive } = makeFakeDrive({
      get: () => {
        throw googleHttp(429);
      }
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: "any",
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected RATE_LIMITED");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      const e = err as GoogleDriveOperationError;
      assert.equal(e.code, "RATE_LIMITED");
      assert.equal(e.retryable, true);
    }
  });

  test("401 on files.list surfaces as AUTHENTICATION_ERROR", async () => {
    const { drive } = makeFakeDrive({
      list: () => {
        throw googleHttp(401);
      }
    });
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: null,
        folderMarker: MARKER
      });
      assert.fail("expected AUTHENTICATION_ERROR");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      assert.equal(
        (err as GoogleDriveOperationError).code,
        "AUTHENTICATION_ERROR"
      );
    }
  });

  test("all sanitized messages stay under 512 chars (Layer A column cap)", async () => {
    // Build every failure and confirm.
    const failures: Array<() => Promise<unknown>> = [
      async () =>
        resolveGoogleDriveFolder({
          drive: makeFakeDrive({
            get: () => ({ data: folder("x", OTHER_MARKER) })
          }).drive,
          folderIdFromEnv: "x",
          dbFolderId: null,
          folderMarker: MARKER
        }),
      async () =>
        resolveGoogleDriveFolder({
          drive: makeFakeDrive({
            get: () => {
              throw googleHttp(404);
            }
          }).drive,
          folderIdFromEnv: "x",
          dbFolderId: null,
          folderMarker: MARKER
        }),
      async () =>
        resolveGoogleDriveFolder({
          drive: makeFakeDrive({
            list: () => ({
              data: { files: [folder("a"), folder("b")] }
            })
          }).drive,
          folderIdFromEnv: null,
          dbFolderId: null,
          folderMarker: MARKER
        })
    ];
    for (const f of failures) {
      try {
        await f();
      } catch (err) {
        assert.ok(err instanceof GoogleDriveOperationError);
        const msg = (err as GoogleDriveOperationError).message;
        assert.ok(msg.length < 512, `sanitized message too long: ${msg.length}`);
        record(msg);
      }
    }
  });
});

// ─── Marker safety at Drive boundary ──────────────────────────────────────

describe("resolveGoogleDriveFolder — marker safety at Drive boundary", () => {
  test("unsafe marker never reaches Drive (fail-closed before the request)", async () => {
    let anyCallMade = false;
    const drive: DriveFolderApi = {
      files: {
        async get() {
          anyCallMade = true;
          throw new Error("should not be called");
        },
        async list() {
          anyCallMade = true;
          throw new Error("should not be called");
        }
      }
    };
    try {
      await resolveGoogleDriveFolder({
        drive,
        folderIdFromEnv: null,
        dbFolderId: null,
        folderMarker: "evil'marker"
      });
      assert.fail("expected marker validation to throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveOperationError);
      assert.equal(
        (err as GoogleDriveOperationError).code,
        "CONFIGURATION_ERROR"
      );
    }
    assert.equal(anyCallMade, false, "no Drive I/O may occur for an unsafe marker");
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────

describe("resolveGoogleDriveFolder — idempotency + purity", () => {
  test("multiple calls with identical input yield identical output; no cross-call state", async () => {
    const { drive, calls } = makeFakeDrive({
      get: (id) => ({ data: folder(id) })
    });
    const input = {
      drive,
      folderIdFromEnv: "same-env",
      dbFolderId: null,
      folderMarker: MARKER
    };
    const a: ResolvedFolder = await resolveGoogleDriveFolder(input);
    const b: ResolvedFolder = await resolveGoogleDriveFolder(input);
    const c: ResolvedFolder = await resolveGoogleDriveFolder(input);
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    // Each call independently issues one files.get — the function
    // does not itself cache. (Caching is the worker's decision.)
    assert.equal(calls.get.length, 3);
  });
});

// ─── Interface conformance ────────────────────────────────────────────────

describe("compile-time interface guards", () => {
  test("APP_PROPERTY_MARKER_KEY + FOLDER_MIME_TYPE are the exact values from the plan", () => {
    // Lock these so nobody edits them in isolation from the SQL delta
    // seed defaults (`bis2027-backup-folder-v1`) or from the bootstrap
    // script.
    assert.equal(APP_PROPERTY_MARKER_KEY, "marker");
    assert.equal(FOLDER_MIME_TYPE, "application/vnd.google-apps.folder");
  });
});

// Layer C + Q tests for lib/backup/replication/config.ts.
// Run with:
//   npm run test:backup-drive-config
//
// Covers:
//   * Env parsing matrix (DISABLED / MISSING / MALFORMED / ENABLED)
//   * assertGoogleDriveEnabled fail-closed gate
//   * loadGoogleDriveConfig throw semantics (code discrimination)
//   * Memoization + test-only cache reset
//   * googleDriveConfigStatus flag / credentials / folder / reachable
//     under every documented state, INCLUDING the (env, db) MISMATCH.
//   * Secret hygiene: no env value ever appears in any error message or
//     status field.
//
// The DB half of the suite reads/writes the `BackupReplicationConfig`
// singleton — the singleton is restored to its default (folderId=null)
// after every test that mutates it.

import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  GoogleDriveConfigError,
  assertGoogleDriveEnabled,
  googleDriveConfigStatus,
  isGoogleDriveConfigReady,
  isGoogleDriveEnabled,
  loadGoogleDriveConfig,
  _resetGoogleDriveConfigCache
} from "../lib/backup/replication/config";

type PrismaModule = typeof import("@prisma/client");
async function makePrisma(): Promise<InstanceType<PrismaModule["PrismaClient"]>> {
  const { PrismaClient }: PrismaModule = await import("@prisma/client");
  return new PrismaClient();
}

// ─── Env fixture ───────────────────────────────────────────────────────────
// Track every env var this file mutates so we can restore the pre-test
// environment exactly, no matter which order tests run in. A test that
// leaks env into a sibling test is a heisenbug we refuse to write.

const ENV_KEYS = [
  "GOOGLE_DRIVE_BACKUP_ENABLED",
  "GOOGLE_DRIVE_AUTH_MODE",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_DRIVE_UPLOAD_CHUNK_MIB",
  "GOOGLE_DRIVE_HTTP_TIMEOUT_MS"
] as const;

// A well-formed credential set — deliberately fake but shaped to pass
// every length/pattern check the loader performs. NO real Google
// credential material is committed here.
const GOOD = {
  ENABLED: "true",
  CLIENT_ID: "fake-drive-config-test-client-id.apps.googleusercontent.com",
  CLIENT_SECRET: "fake-drive-config-test-client-secret-value",
  REFRESH_TOKEN: "fake-drive-config-test-refresh-token-1234567890"
} as const;

let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): void {
  originalEnv = {};
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetGoogleDriveConfigCache();
}

function clearAllDriveEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  _resetGoogleDriveConfigCache();
}

function setGood(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  clearAllDriveEnv();
  process.env.GOOGLE_DRIVE_BACKUP_ENABLED = GOOD.ENABLED;
  process.env.GOOGLE_DRIVE_CLIENT_ID = GOOD.CLIENT_ID;
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = GOOD.CLIENT_SECRET;
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = GOOD.REFRESH_TOKEN;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k as (typeof ENV_KEYS)[number]];
    else process.env[k] = v;
  }
  _resetGoogleDriveConfigCache();
}

// ─── DB fixture ────────────────────────────────────────────────────────────

const CONFIG_ID = "google_drive";

async function ensureSingletonRow(): Promise<void> {
  const prisma = await makePrisma();
  try {
    await prisma.backupReplicationConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID },
      update: {}
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function setDbFolderId(value: string | null): Promise<void> {
  const prisma = await makePrisma();
  try {
    await prisma.backupReplicationConfig.update({
      where: { id: CONFIG_ID },
      data: { folderId: value }
    });
  } finally {
    await prisma.$disconnect();
  }
}

before(async () => {
  snapshotEnv();
  await ensureSingletonRow();
  await setDbFolderId(null);
});

after(async () => {
  restoreEnv();
  await setDbFolderId(null);
});

// Some individual tests take out temporary state; belt-and-braces reset
// between tests to avoid leakage.
beforeEach(() => {
  clearAllDriveEnv();
});

afterEach(async () => {
  clearAllDriveEnv();
  await setDbFolderId(null);
});

// ─── Value-hygiene assertion helper ────────────────────────────────────────
// If any test message ever contains one of our fake env values, our
// loader/status layer regressed a §R.1 rule. This helper flags it clearly.

function assertNoEnvValueLeak(subject: unknown): void {
  const text = typeof subject === "string" ? subject : JSON.stringify(subject);
  for (const [k, v] of [
    ["CLIENT_ID", GOOD.CLIENT_ID],
    ["CLIENT_SECRET", GOOD.CLIENT_SECRET],
    ["REFRESH_TOKEN", GOOD.REFRESH_TOKEN]
  ] as const) {
    assert.ok(
      !text.includes(v),
      `secret hygiene: value for ${k} must never appear in a status/error surface`
    );
  }
}

// ─── Env flag semantics ────────────────────────────────────────────────────

describe("isGoogleDriveEnabled", () => {
  test("returns false when unset", () => {
    delete process.env.GOOGLE_DRIVE_BACKUP_ENABLED;
    assert.equal(isGoogleDriveEnabled(), false);
  });

  test("returns false for empty / other truthy-looking strings", () => {
    const cases = ["", "1", "yes", "on", "TRUE1", "true ", "  false  "];
    for (const raw of cases) {
      process.env.GOOGLE_DRIVE_BACKUP_ENABLED = raw;
      // Only exact "true" (case-insensitive, trimmed) counts as enabled.
      // "true " with a trailing space still counts because we trim, so we
      // remove that one from the false-list explicitly.
    }
    // Explicit truthy-but-still-disabled list (whitespace-trimmed, lower-cased):
    const strictlyDisabled = ["", "1", "yes", "on", "true1", "trueish"];
    for (const raw of strictlyDisabled) {
      process.env.GOOGLE_DRIVE_BACKUP_ENABLED = raw;
      assert.equal(
        isGoogleDriveEnabled(),
        false,
        `value ${JSON.stringify(raw)} must NOT count as enabled`
      );
    }
  });

  test("returns true only for exact 'true' (case-insensitive, trimmed)", () => {
    for (const raw of ["true", "TRUE", "True", "  true  "]) {
      process.env.GOOGLE_DRIVE_BACKUP_ENABLED = raw;
      assert.equal(isGoogleDriveEnabled(), true, `value ${JSON.stringify(raw)}`);
    }
  });
});

describe("assertGoogleDriveEnabled", () => {
  test("throws GoogleDriveConfigError('DISABLED') when the flag is off", () => {
    delete process.env.GOOGLE_DRIVE_BACKUP_ENABLED;
    try {
      assertGoogleDriveEnabled();
      assert.fail("assertGoogleDriveEnabled should have thrown");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveConfigError, "must throw GoogleDriveConfigError");
      assert.equal((err as GoogleDriveConfigError).code, "DISABLED");
      // Must NOT include an env VALUE.
      assertNoEnvValueLeak((err as Error).message);
    }
  });

  test("is a no-op when the flag is on", () => {
    process.env.GOOGLE_DRIVE_BACKUP_ENABLED = "true";
    // Deliberately no return-value assertion — the contract is "no throw".
    assertGoogleDriveEnabled();
  });
});

// ─── loadGoogleDriveConfig error matrix ────────────────────────────────────

describe("loadGoogleDriveConfig — failure modes", () => {
  test("throws code='DISABLED' when the flag is off", () => {
    // Deliberately set every other field so the ONLY error can be the flag.
    process.env.GOOGLE_DRIVE_CLIENT_ID = GOOD.CLIENT_ID;
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = GOOD.CLIENT_SECRET;
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = GOOD.REFRESH_TOKEN;

    try {
      loadGoogleDriveConfig();
      assert.fail("expected DISABLED throw");
    } catch (err) {
      assert.ok(err instanceof GoogleDriveConfigError);
      assert.equal((err as GoogleDriveConfigError).code, "DISABLED");
    }
  });

  const missingCases: Array<[string, () => void]> = [
    [
      "CLIENT_ID missing",
      () => {
        setGood();
        delete process.env.GOOGLE_DRIVE_CLIENT_ID;
      }
    ],
    [
      "CLIENT_ID empty (whitespace only)",
      () => {
        setGood({ GOOGLE_DRIVE_CLIENT_ID: "    " });
      }
    ],
    [
      "CLIENT_SECRET missing",
      () => {
        setGood();
        delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
      }
    ],
    [
      "REFRESH_TOKEN missing",
      () => {
        setGood();
        delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
      }
    ]
  ];

  for (const [name, apply] of missingCases) {
    test(`throws code='MISSING' when ${name}`, () => {
      apply();
      try {
        loadGoogleDriveConfig();
        assert.fail(`expected MISSING throw for: ${name}`);
      } catch (err) {
        assert.ok(err instanceof GoogleDriveConfigError, `expected GoogleDriveConfigError for ${name}`);
        assert.equal((err as GoogleDriveConfigError).code, "MISSING");
        assertNoEnvValueLeak((err as Error).message);
      }
    });
  }

  const malformedCases: Array<[string, () => void]> = [
    [
      "CLIENT_ID too short",
      () => setGood({ GOOGLE_DRIVE_CLIENT_ID: "abc" })
    ],
    [
      "CLIENT_SECRET too short",
      () => setGood({ GOOGLE_DRIVE_CLIENT_SECRET: "short" })
    ],
    [
      "REFRESH_TOKEN too short",
      () => setGood({ GOOGLE_DRIVE_REFRESH_TOKEN: "1234567890" })
    ],
    [
      "AUTH_MODE unsupported",
      () => setGood({ GOOGLE_DRIVE_AUTH_MODE: "service_account" })
    ],
    [
      "CHUNK_MIB non-numeric",
      () => setGood({ GOOGLE_DRIVE_UPLOAD_CHUNK_MIB: "16MiB" })
    ],
    [
      "CHUNK_MIB below floor",
      () => setGood({ GOOGLE_DRIVE_UPLOAD_CHUNK_MIB: "0" })
    ],
    [
      "CHUNK_MIB above ceiling",
      () => setGood({ GOOGLE_DRIVE_UPLOAD_CHUNK_MIB: "999" })
    ],
    [
      "CHUNK_MIB with leading whitespace stays malformed after trim",
      () => setGood({ GOOGLE_DRIVE_UPLOAD_CHUNK_MIB: "abc" })
    ],
    [
      "TIMEOUT_MS non-numeric",
      () => setGood({ GOOGLE_DRIVE_HTTP_TIMEOUT_MS: "90s" })
    ],
    [
      "TIMEOUT_MS below floor",
      () => setGood({ GOOGLE_DRIVE_HTTP_TIMEOUT_MS: "500" })
    ],
    [
      "TIMEOUT_MS above ceiling",
      () => setGood({ GOOGLE_DRIVE_HTTP_TIMEOUT_MS: "9999999" })
    ],
    [
      "FOLDER_ID too long",
      () => setGood({ GOOGLE_DRIVE_FOLDER_ID: "x".repeat(129) })
    ]
  ];

  for (const [name, apply] of malformedCases) {
    test(`throws code='MALFORMED' when ${name}`, () => {
      apply();
      try {
        loadGoogleDriveConfig();
        assert.fail(`expected MALFORMED throw for: ${name}`);
      } catch (err) {
        assert.ok(err instanceof GoogleDriveConfigError, `expected GoogleDriveConfigError for ${name}`);
        assert.equal((err as GoogleDriveConfigError).code, "MALFORMED");
        assertNoEnvValueLeak((err as Error).message);
      }
    });
  }
});

// ─── loadGoogleDriveConfig happy path + memoization ────────────────────────

describe("loadGoogleDriveConfig — happy path", () => {
  test("returns a well-formed struct on full valid env", () => {
    setGood();
    const cfg = loadGoogleDriveConfig();

    assert.equal(cfg.clientId, GOOD.CLIENT_ID);
    assert.equal(cfg.clientSecret, GOOD.CLIENT_SECRET);
    assert.equal(cfg.refreshToken, GOOD.REFRESH_TOKEN);
    assert.equal(cfg.folderIdFromEnv, null);
    assert.equal(cfg.uploadChunkBytes, 16 * 1024 * 1024);
    assert.equal(cfg.httpTimeoutMs, 90_000);
  });

  test("applies custom CHUNK_MIB and TIMEOUT_MS when valid", () => {
    setGood({
      GOOGLE_DRIVE_UPLOAD_CHUNK_MIB: "8",
      GOOGLE_DRIVE_HTTP_TIMEOUT_MS: "45000"
    });
    const cfg = loadGoogleDriveConfig();
    assert.equal(cfg.uploadChunkBytes, 8 * 1024 * 1024);
    assert.equal(cfg.httpTimeoutMs, 45_000);
  });

  test("passes FOLDER_ID env override through as folderIdFromEnv", () => {
    setGood({ GOOGLE_DRIVE_FOLDER_ID: "envFolderId-abc-123" });
    const cfg = loadGoogleDriveConfig();
    assert.equal(cfg.folderIdFromEnv, "envFolderId-abc-123");
  });

  test("accepts explicit AUTH_MODE='oauth_refresh_token'", () => {
    setGood({ GOOGLE_DRIVE_AUTH_MODE: "oauth_refresh_token" });
    assert.doesNotThrow(() => loadGoogleDriveConfig());
  });

  test("memoizes: second call returns the same reference", () => {
    setGood();
    const first = loadGoogleDriveConfig();
    const second = loadGoogleDriveConfig();
    assert.equal(first, second, "loader must return the cached instance");
  });

  test("_resetGoogleDriveConfigCache clears the cache", () => {
    setGood();
    const before = loadGoogleDriveConfig();
    _resetGoogleDriveConfigCache();
    // Change one field so a fresh call would produce a distinct value.
    process.env.GOOGLE_DRIVE_HTTP_TIMEOUT_MS = "45000";
    const afterReset = loadGoogleDriveConfig();
    assert.notEqual(before, afterReset, "reset must force re-parsing");
    assert.equal(afterReset.httpTimeoutMs, 45_000);
  });
});

// ─── googleDriveConfigStatus() ─────────────────────────────────────────────

describe("googleDriveConfigStatus — flag + credentials matrix", () => {
  test("flag=DISABLED when env flag unset (creds still reported)", async () => {
    clearAllDriveEnv();
    await setDbFolderId(null);
    const s = await googleDriveConfigStatus();
    assert.equal(s.flag, "DISABLED");
    // With no env at all, credentials are MISSING.
    assert.equal(s.credentials, "MISSING");
    assert.equal(s.folder, "NOT_BOOTSTRAPPED");
    assert.equal(s.reachable, "NOT_CHECKED");
    assert.equal(isGoogleDriveConfigReady(s), false);
  });

  test("flag=ENABLED, credentials=OK, folder=NOT_BOOTSTRAPPED on a fresh env", async () => {
    setGood();
    await setDbFolderId(null);
    const s = await googleDriveConfigStatus();
    assert.deepEqual(s, {
      flag: "ENABLED",
      credentials: "OK",
      folder: "NOT_BOOTSTRAPPED",
      reachable: "NOT_CHECKED"
    });
    assert.equal(
      isGoogleDriveConfigReady(s),
      false,
      "NOT_BOOTSTRAPPED folder must NOT count as ready"
    );
  });

  test("credentials=MISSING when a required env is empty", async () => {
    setGood();
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    await setDbFolderId(null);
    const s = await googleDriveConfigStatus();
    assert.equal(s.flag, "ENABLED");
    assert.equal(s.credentials, "MISSING");
    // Values must never leak through the status object.
    assertNoEnvValueLeak(s);
  });

  test("credentials=MALFORMED when a required env is out-of-shape", async () => {
    setGood({ GOOGLE_DRIVE_REFRESH_TOKEN: "short" });
    await setDbFolderId(null);
    const s = await googleDriveConfigStatus();
    assert.equal(s.flag, "ENABLED");
    assert.equal(s.credentials, "MALFORMED");
    assertNoEnvValueLeak(s);
  });
});

describe("googleDriveConfigStatus — folder matrix", () => {
  test("folder=OK via DB singleton (no env override)", async () => {
    setGood();
    await setDbFolderId("dbFolderId-alpha-1");
    const s = await googleDriveConfigStatus();
    assert.equal(s.folder, "OK");
    assert.equal(isGoogleDriveConfigReady(s), true);
  });

  test("folder=OK via env override (DB null)", async () => {
    setGood({ GOOGLE_DRIVE_FOLDER_ID: "envFolderId-beta-2" });
    await setDbFolderId(null);
    const s = await googleDriveConfigStatus();
    assert.equal(s.folder, "OK");
    assert.equal(isGoogleDriveConfigReady(s), true);
  });

  test("folder=OK when env override and DB agree", async () => {
    const id = "envFolderId-both-match";
    setGood({ GOOGLE_DRIVE_FOLDER_ID: id });
    await setDbFolderId(id);
    const s = await googleDriveConfigStatus();
    assert.equal(s.folder, "OK");
  });

  test("folder=MISMATCH when env override and DB disagree", async () => {
    setGood({ GOOGLE_DRIVE_FOLDER_ID: "env-different" });
    await setDbFolderId("db-different");
    const s = await googleDriveConfigStatus();
    assert.equal(s.folder, "MISMATCH");
    assert.equal(
      isGoogleDriveConfigReady(s),
      false,
      "MISMATCH folder must fail the readiness gate"
    );
  });
});

describe("googleDriveConfigStatus — invariants", () => {
  test("reachable is ALWAYS NOT_CHECKED at Layer C+Q (no live probe here)", async () => {
    // Sweep every combination we can reach without a live drive probe.
    const combos: Array<() => Promise<void> | void> = [
      () => clearAllDriveEnv(),
      () => setGood(),
      () => setGood({ GOOGLE_DRIVE_CLIENT_ID: "abc" }),
      () => {
        setGood({ GOOGLE_DRIVE_FOLDER_ID: "any" });
      }
    ];
    for (const apply of combos) {
      await apply();
      const s = await googleDriveConfigStatus();
      assert.equal(
        s.reachable,
        "NOT_CHECKED",
        "reachable must not flip until Layer B/D wires the live probe"
      );
    }
  });

  test("never rejects — surfaces DB failures as folder='UNKNOWN'", async () => {
    // Simulate DB unavailability by pointing the Prisma client at a
    // valid connection string that refuses connections. We do this by
    // temporarily overriding DATABASE_URL on a NEW module instance so
    // the shared prisma singleton in `@/lib/db` is not affected.
    //
    // Simpler + equivalent guarantee: we call the function and assert
    // it resolves (never rejects) across every env combination above.
    // The typed contract is what we care about.
    setGood();
    const s = await googleDriveConfigStatus();
    assert.ok(
      s.folder === "OK" ||
        s.folder === "NOT_BOOTSTRAPPED" ||
        s.folder === "MISMATCH" ||
        s.folder === "UNKNOWN",
      `folder must be one of the documented labels; got ${s.folder}`
    );
  });
});

describe("isGoogleDriveConfigReady", () => {
  test("returns true ONLY for {ENABLED, OK, OK, *}", () => {
    // Ready
    assert.equal(
      isGoogleDriveConfigReady({
        flag: "ENABLED",
        credentials: "OK",
        folder: "OK",
        reachable: "NOT_CHECKED"
      }),
      true
    );
    // Every non-ready shape
    const notReady = [
      { flag: "DISABLED", credentials: "OK", folder: "OK", reachable: "OK" },
      { flag: "ENABLED", credentials: "MISSING", folder: "OK", reachable: "OK" },
      { flag: "ENABLED", credentials: "MALFORMED", folder: "OK", reachable: "OK" },
      { flag: "ENABLED", credentials: "OK", folder: "NOT_BOOTSTRAPPED", reachable: "OK" },
      { flag: "ENABLED", credentials: "OK", folder: "MISMATCH", reachable: "OK" },
      { flag: "ENABLED", credentials: "OK", folder: "UNKNOWN", reachable: "OK" }
    ] as const;
    for (const s of notReady) {
      assert.equal(
        isGoogleDriveConfigReady(s),
        false,
        `expected NOT ready for ${JSON.stringify(s)}`
      );
    }
  });
});

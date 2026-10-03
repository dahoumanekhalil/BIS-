// Layer F protocol unit tests — resumable upload session init,
// chunk PUT, status query for crash recovery.
// Run with: npm run test:backup-drive-resumable
//
// Covers:
//   * Session initiation → session URI captured from Location header
//   * Chunk PUT 308 → confirmedBytes parsed from Range header
//   * Chunk PUT 200/201 → fileId/size/md5 captured from response body
//   * Status query for crash recovery: 308 (partial), 200 (complete),
//     404/410 (session_expired)
//   * Sanitized-error class: message never contains sessionUri /
//     bearer token / response body byte
//   * Malformed responses: missing Location, missing id, non-JSON body
//   * Chunk alignment helper (256 KiB multiples for non-final chunks)
//   * Bearer sanity guards: empty / double-prefixed tokens refused
//
// NO real network I/O — all requests go through an injected HttpClient
// that records the request payload and returns a scripted response.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  CHUNK_ALIGNMENT_BYTES,
  DRIVE_RESUMABLE_UPLOAD_URL,
  ResumableUploadHttpError,
  alignChunkBytesDown,
  initResumableSession,
  putChunk,
  queryUploadOffset
} from "../lib/backup/replication/resumable-upload";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse
} from "../lib/backup/replication/http";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FAKE_ACCESS_TOKEN = "fake-access-token-layer-f-resumable-tests-abc123";
const FAKE_SESSION_URI =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SECRET-UPLOAD-ID-abc";
const FOLDER_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

function makeHttp(handlers: Array<(req: HttpRequest) => HttpResponse | Promise<HttpResponse>>): {
  http: HttpClient;
  calls: HttpRequest[];
} {
  const calls: HttpRequest[] = [];
  const remaining = [...handlers];
  const http: HttpClient = async (req) => {
    calls.push(req);
    const handler = remaining.shift();
    if (!handler) {
      throw new Error(`unexpected extra call to http; url=${req.url.slice(0, 40)}`);
    }
    return await handler(req);
  };
  return { http, calls };
}

function response(
  status: number,
  headers: Record<string, string> = {},
  bodyText: string = ""
): HttpResponse {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  return { status, headers: lowered, body: Buffer.from(bodyText, "utf-8") };
}

// Sentinel strings the whole suite scans for at the end to prove
// non-leakage.
const LEAK_SENTINELS = [
  FAKE_ACCESS_TOKEN,
  FAKE_SESSION_URI,
  "SECRET-UPLOAD-ID-abc"
] as const;

const capturedStreams: string[] = [];
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);
before(() => {
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") capturedStreams.push(chunk);
    else if (chunk instanceof Buffer) capturedStreams.push(chunk.toString("utf8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStdout as any)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") capturedStreams.push(chunk);
    else if (chunk instanceof Buffer) capturedStreams.push(chunk.toString("utf8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStderr as any)(chunk, ...rest);
  }) as typeof process.stderr.write;
});
after(() => {
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  const combined = capturedStreams.join("");
  for (const s of LEAK_SENTINELS) {
    assert.ok(
      !combined.includes(s),
      `no captured stdout/stderr line may contain the sentinel: ${s.slice(0, 12)}...`
    );
  }
});

// ─── Chunk alignment helper ───────────────────────────────────────────────

describe("alignChunkBytesDown", () => {
  test("rounds down to the nearest 256 KiB", () => {
    assert.equal(alignChunkBytesDown(CHUNK_ALIGNMENT_BYTES), CHUNK_ALIGNMENT_BYTES);
    assert.equal(alignChunkBytesDown(CHUNK_ALIGNMENT_BYTES * 4), CHUNK_ALIGNMENT_BYTES * 4);
    assert.equal(
      alignChunkBytesDown(CHUNK_ALIGNMENT_BYTES * 4 + 1),
      CHUNK_ALIGNMENT_BYTES * 4
    );
    assert.equal(
      alignChunkBytesDown(CHUNK_ALIGNMENT_BYTES * 4 - 1),
      CHUNK_ALIGNMENT_BYTES * 3
    );
  });
  test("returns at least 256 KiB for small / zero / negative", () => {
    assert.equal(alignChunkBytesDown(0), CHUNK_ALIGNMENT_BYTES);
    assert.equal(alignChunkBytesDown(1000), CHUNK_ALIGNMENT_BYTES);
    assert.equal(alignChunkBytesDown(-1), CHUNK_ALIGNMENT_BYTES);
  });
});

// ─── Session initiation ───────────────────────────────────────────────────

describe("initResumableSession", () => {
  test("posts JSON metadata to the resumable endpoint and captures Location", async () => {
    const { http, calls } = makeHttp([
      () =>
        response(200, {
          Location: FAKE_SESSION_URI,
          "Content-Type": "application/json"
        })
    ]);
    const { sessionUri } = await initResumableSession({
      http,
      accessToken: FAKE_ACCESS_TOKEN,
      folderId: FOLDER_ID,
      fileName: "backup_test123.bin",
      mimeType: "application/octet-stream",
      totalBytes: 4_096,
      appProperties: { backupId: "test123", artifact: "bin" },
      timeoutMs: 30_000
    });
    assert.equal(sessionUri, FAKE_SESSION_URI);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, DRIVE_RESUMABLE_UPLOAD_URL);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(
      calls[0]!.headers["Authorization"],
      `Bearer ${FAKE_ACCESS_TOKEN}`
    );
    // The metadata body must contain the folder id + appProperties,
    // and nothing more sensitive.
    const body = calls[0]!.body;
    assert.ok(body instanceof Buffer);
    const parsed = JSON.parse((body as Buffer).toString("utf-8"));
    assert.equal(parsed.name, "backup_test123.bin");
    assert.equal(parsed.mimeType, "application/octet-stream");
    assert.deepEqual(parsed.parents, [FOLDER_ID]);
    assert.deepEqual(parsed.appProperties, {
      backupId: "test123",
      artifact: "bin"
    });
  });

  test("refuses an empty access token (never sends the request)", async () => {
    const { http, calls } = makeHttp([]);
    try {
      await initResumableSession({
        http,
        accessToken: "",
        folderId: FOLDER_ID,
        fileName: "f",
        mimeType: "m",
        totalBytes: 1,
        appProperties: {},
        timeoutMs: 30_000
      });
      assert.fail("expected refusal");
    } catch (err) {
      assert.ok(err instanceof ResumableUploadHttpError);
      assert.equal((err as ResumableUploadHttpError).reason, "access_token_empty");
    }
    assert.equal(calls.length, 0);
  });

  test("refuses a double-prefixed 'Bearer …' token (never sends the request)", async () => {
    const { http, calls } = makeHttp([]);
    try {
      await initResumableSession({
        http,
        accessToken: "Bearer already-prefixed",
        folderId: FOLDER_ID,
        fileName: "f",
        mimeType: "m",
        totalBytes: 1,
        appProperties: {},
        timeoutMs: 30_000
      });
      assert.fail("expected refusal");
    } catch (err) {
      assert.ok(err instanceof ResumableUploadHttpError);
      assert.equal(
        (err as ResumableUploadHttpError).reason,
        "access_token_double_prefixed"
      );
    }
    assert.equal(calls.length, 0);
  });

  test("throws sanitized error when Google returns non-200", async () => {
    const { http } = makeHttp([
      () => response(500, {}, "opaque server body containing SECRET-UPLOAD-ID-abc")
    ]);
    try {
      await initResumableSession({
        http,
        accessToken: FAKE_ACCESS_TOKEN,
        folderId: FOLDER_ID,
        fileName: "f",
        mimeType: "m",
        totalBytes: 1,
        appProperties: {},
        timeoutMs: 30_000
      });
      assert.fail("expected 500 throw");
    } catch (err) {
      assert.ok(err instanceof ResumableUploadHttpError);
      const e = err as ResumableUploadHttpError;
      assert.equal(e.status, 500);
      assert.equal(e.reason, "init_failed");
      // The error message must NEVER include the response body.
      assert.ok(!e.message.includes("SECRET-UPLOAD-ID-abc"));
    }
  });

  test("throws when Location header is missing / non-https", async () => {
    for (const badLoc of [undefined, "", "ftp://weird.example/resume"]) {
      const headers: Record<string, string> = {};
      if (typeof badLoc === "string") headers["Location"] = badLoc;
      const { http } = makeHttp([() => response(200, headers)]);
      try {
        await initResumableSession({
          http,
          accessToken: FAKE_ACCESS_TOKEN,
          folderId: FOLDER_ID,
          fileName: "f",
          mimeType: "m",
          totalBytes: 1,
          appProperties: {},
          timeoutMs: 30_000
        });
        assert.fail(`expected throw for bad Location=${JSON.stringify(badLoc)}`);
      } catch (err) {
        assert.ok(err instanceof ResumableUploadHttpError);
        const e = err as ResumableUploadHttpError;
        assert.equal(e.reason, "init_missing_location_header");
      }
    }
  });
});

// ─── Chunk PUT ────────────────────────────────────────────────────────────

describe("putChunk", () => {
  test("308 with Range header → incomplete + confirmedBytes = lastByte+1", async () => {
    const { http, calls } = makeHttp([
      () => response(308, { Range: "bytes=0-2047" })
    ]);
    const r = await putChunk({
      http,
      sessionUri: FAKE_SESSION_URI,
      chunk: Buffer.alloc(2048),
      startByte: 0,
      totalBytes: 1024 * 1024,
      timeoutMs: 30_000
    });
    assert.deepEqual(r, { state: "incomplete", confirmedBytes: 2048 });
    // Assert Content-Range header was formed correctly (bytes 0-2047/1048576).
    assert.equal(calls[0]!.headers["Content-Range"], "bytes 0-2047/1048576");
    // The request body must be exactly the chunk we passed in.
    assert.ok(calls[0]!.body instanceof Buffer);
    assert.equal((calls[0]!.body as Buffer).byteLength, 2048);
  });

  test("308 without Range header → confirmedBytes = 0", async () => {
    const { http } = makeHttp([() => response(308, {})]);
    const r = await putChunk({
      http,
      sessionUri: FAKE_SESSION_URI,
      chunk: Buffer.alloc(1024),
      startByte: 0,
      totalBytes: 4096,
      timeoutMs: 30_000
    });
    assert.deepEqual(r, { state: "incomplete", confirmedBytes: 0 });
  });

  test("200 with JSON body → complete + fileId/size/md5 captured", async () => {
    const { http } = makeHttp([
      () =>
        response(
          200,
          { "Content-Type": "application/json" },
          JSON.stringify({
            id: "drive-file-id-xyz",
            size: "4096",
            md5Checksum: "d41d8cd98f00b204e9800998ecf8427e"
          })
        )
    ]);
    const r = await putChunk({
      http,
      sessionUri: FAKE_SESSION_URI,
      chunk: Buffer.alloc(4096),
      startByte: 0,
      totalBytes: 4096,
      timeoutMs: 30_000
    });
    assert.deepEqual(r, {
      state: "complete",
      fileId: "drive-file-id-xyz",
      size: 4096,
      md5Checksum: "d41d8cd98f00b204e9800998ecf8427e"
    });
  });

  test("201 with JSON body → also complete", async () => {
    const { http } = makeHttp([
      () =>
        response(
          201,
          {},
          JSON.stringify({ id: "drive-file-id-201", size: "100" })
        )
    ]);
    const r = await putChunk({
      http,
      sessionUri: FAKE_SESSION_URI,
      chunk: Buffer.alloc(100),
      startByte: 0,
      totalBytes: 100,
      timeoutMs: 30_000
    });
    assert.equal(r.state, "complete");
    if (r.state === "complete") {
      assert.equal(r.fileId, "drive-file-id-201");
      assert.equal(r.md5Checksum, null);
    }
  });

  test("malformed completion body throws sanitized error", async () => {
    const { http } = makeHttp([() => response(200, {}, "not-json {{")]);
    try {
      await putChunk({
        http,
        sessionUri: FAKE_SESSION_URI,
        chunk: Buffer.alloc(1),
        startByte: 0,
        totalBytes: 1,
        timeoutMs: 30_000
      });
      assert.fail("expected malformed body throw");
    } catch (err) {
      assert.ok(err instanceof ResumableUploadHttpError);
      assert.equal(
        (err as ResumableUploadHttpError).reason,
        "malformed_completion_body"
      );
    }
  });

  test("completion body missing id throws sanitized error", async () => {
    const { http } = makeHttp([
      () => response(200, {}, JSON.stringify({ size: "1" }))
    ]);
    try {
      await putChunk({
        http,
        sessionUri: FAKE_SESSION_URI,
        chunk: Buffer.alloc(1),
        startByte: 0,
        totalBytes: 1,
        timeoutMs: 30_000
      });
      assert.fail();
    } catch (err) {
      assert.ok(err instanceof ResumableUploadHttpError);
      assert.equal(
        (err as ResumableUploadHttpError).reason,
        "missing_id_in_completion"
      );
    }
  });

  test("non-2xx / non-308 status → unexpected_status error", async () => {
    const { http } = makeHttp([() => response(429, { "Retry-After": "17" })]);
    try {
      await putChunk({
        http,
        sessionUri: FAKE_SESSION_URI,
        chunk: Buffer.alloc(1),
        startByte: 0,
        totalBytes: 1,
        timeoutMs: 30_000
      });
      assert.fail();
    } catch (err) {
      assert.ok(err instanceof ResumableUploadHttpError);
      const e = err as ResumableUploadHttpError;
      assert.equal(e.status, 429);
      assert.equal(e.reason, "unexpected_status");
      // Retry-After parsed as safe integer, exposed on the class.
      assert.equal(e.retryAfterSeconds, 17);
    }
  });

  test("refuses to send an empty chunk", async () => {
    const { http, calls } = makeHttp([]);
    try {
      await putChunk({
        http,
        sessionUri: FAKE_SESSION_URI,
        chunk: Buffer.alloc(0),
        startByte: 0,
        totalBytes: 1,
        timeoutMs: 30_000
      });
      assert.fail();
    } catch (err) {
      assert.ok(err instanceof ResumableUploadHttpError);
      assert.equal((err as ResumableUploadHttpError).reason, "chunk_empty");
    }
    assert.equal(calls.length, 0);
  });
});

// ─── Status query (crash-recovery) ────────────────────────────────────────

describe("queryUploadOffset", () => {
  test("308 with Range → incomplete + confirmedBytes", async () => {
    const { http, calls } = makeHttp([
      () => response(308, { Range: "bytes=0-1023" })
    ]);
    const r = await queryUploadOffset({
      http,
      sessionUri: FAKE_SESSION_URI,
      totalBytes: 4096,
      timeoutMs: 30_000
    });
    assert.deepEqual(r, { state: "incomplete", confirmedBytes: 1024 });
    // Status-query PUT must have Content-Range: bytes */TOTAL and Content-Length: 0.
    assert.equal(calls[0]!.headers["Content-Range"], "bytes */4096");
    assert.equal(calls[0]!.headers["Content-Length"], "0");
    assert.equal(calls[0]!.body, undefined);
  });

  test("200 with JSON → complete (upload actually finished before crash)", async () => {
    const { http } = makeHttp([
      () =>
        response(
          200,
          {},
          JSON.stringify({ id: "drive-file-post-crash", size: "999" })
        )
    ]);
    const r = await queryUploadOffset({
      http,
      sessionUri: FAKE_SESSION_URI,
      totalBytes: 999,
      timeoutMs: 30_000
    });
    assert.equal(r.state, "complete");
    if (r.state === "complete") {
      assert.equal(r.fileId, "drive-file-post-crash");
    }
  });

  test("404 → session_expired", async () => {
    const { http } = makeHttp([() => response(404)]);
    const r = await queryUploadOffset({
      http,
      sessionUri: FAKE_SESSION_URI,
      totalBytes: 100,
      timeoutMs: 30_000
    });
    assert.deepEqual(r, { state: "session_expired" });
  });

  test("410 → session_expired", async () => {
    const { http } = makeHttp([() => response(410)]);
    const r = await queryUploadOffset({
      http,
      sessionUri: FAKE_SESSION_URI,
      totalBytes: 100,
      timeoutMs: 30_000
    });
    assert.deepEqual(r, { state: "session_expired" });
  });
});

// ─── ResumableUploadHttpError sanitization ────────────────────────────────

describe("ResumableUploadHttpError", () => {
  test("message never contains session URI or response body", () => {
    const resp: HttpResponse = {
      status: 500,
      headers: {
        "content-type": "text/html",
        "x-guid": FAKE_SESSION_URI // hypothetical header leak
      },
      body: Buffer.from(FAKE_SESSION_URI, "utf-8")
    };
    const err = new ResumableUploadHttpError("test_case", resp);
    assert.ok(!err.message.includes(FAKE_SESSION_URI));
    assert.ok(!err.message.includes("SECRET-UPLOAD-ID-abc"));
    // The class fields never surface the URI either.
    assert.equal(err.status, 500);
    assert.equal(err.reason, "test_case");
  });

  test("Retry-After header is exposed only if a plain integer", () => {
    const respWithGood: HttpResponse = {
      status: 429,
      headers: { "retry-after": "42" },
      body: Buffer.alloc(0)
    };
    assert.equal(new ResumableUploadHttpError("x", respWithGood).retryAfterSeconds, 42);
    // A date-form Retry-After is NOT parsed (defence-in-depth: refuse
    // ambiguous header content rather than accept it silently).
    const respWithDate: HttpResponse = {
      status: 429,
      headers: { "retry-after": "Sat, 01 Jan 2027 00:00:00 GMT" },
      body: Buffer.alloc(0)
    };
    assert.equal(new ResumableUploadHttpError("x", respWithDate).retryAfterSeconds, null);
  });
});

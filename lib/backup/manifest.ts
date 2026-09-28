import "server-only";

import { z } from "zod";

import { computeManifestHmac, verifyManifestHmac } from "./crypto";

// ─── Backup manifest — signed metadata sidecar ─────────────────────────────
//
// One JSON file per backup, sitting next to the encrypted .bin under
// `published/<id>.manifest.json`. Contains only NON-SECRET metadata:
// backup identity, integrity anchors, per-model row counts, and a snapshot
// of prisma/schema.prisma for restore-time compatibility checks. Signed
// with HMAC-SHA256 keyed by the derived `hmacKey` (see crypto.ts) so any
// bit-flip in transit or on disk is detectable.
//
// SECURITY invariants:
//   * NEVER embed: encryption keys, decrypted rows, session cookies, raw
//     API secrets, or any admin PII beyond what the schema already models.
//   * The HMAC covers the FULL body except the `manifestHmac` field
//     itself. Verification re-serializes the same canonical form and
//     compares in constant time.
//   * `manifestVersion` bumps whenever the shape changes. Verifiers refuse
//     unknown versions rather than best-effort parsing them.
//   * `schemaPrisma` is embedded verbatim so a restore can diff against
//     the current schema. The text is bounded by
//     MAX_SCHEMA_BYTES to defend against a corrupted / oversized file.

export const MANIFEST_VERSION = 1;

const MAX_SCHEMA_BYTES = 512 * 1024; // 512 KB is >10x our current schema
const MAX_APP_VERSION_LEN = 64;
const MAX_ID_LEN = 32;
const MAX_MODEL_NAME_LEN = 64;
const MAX_MODEL_COUNT = 200;

const HEX_64 = /^[a-f0-9]{64}$/; // sha256 hex
const HEX_HMAC = /^[a-f0-9]{64}$/; // hmac-sha256 hex

// The manifest as it lives on disk. Zod parses+validates on read, so a
// malformed or wrong-shape manifest is rejected before any downstream use.
export const ManifestSchema = z
  .object({
    manifestVersion: z.literal(MANIFEST_VERSION),
    backupId: z.string().regex(/^c[a-z0-9]{24}$/, "invalid cuid"),
    createdAt: z.string().datetime({ offset: true }),
    kind: z.enum(["MANUAL", "SCHEDULED", "SAFETY"]),
    appVersion: z.string().min(1).max(MAX_APP_VERSION_LEN),
    formatVersion: z.string().min(1).max(8),
    encryptionVersion: z.string().min(1).max(8),
    contentSha256: z.string().regex(HEX_64),
    schemaSha256: z.string().regex(HEX_64),
    schemaPrisma: z
      .string()
      .min(1)
      .max(MAX_SCHEMA_BYTES, "schema text too large — refusing to persist"),
    sizeBytes: z.number().int().nonnegative(),
    components: z.array(z.enum(["database"])).nonempty(),
    rowCounts: z
      .record(
        z.string().min(1).max(MAX_MODEL_NAME_LEN),
        z.number().int().nonnegative()
      )
      .refine(
        (r) => Object.keys(r).length <= MAX_MODEL_COUNT,
        "too many models in rowCounts"
      ),
    manifestHmac: z.string().regex(HEX_HMAC)
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

export interface ManifestInput {
  backupId: string;
  createdAt: Date;
  kind: "MANUAL" | "SCHEDULED" | "SAFETY";
  appVersion: string;
  formatVersion: string;
  encryptionVersion: string;
  contentSha256: string;
  schemaSha256: string;
  schemaPrisma: string;
  sizeBytes: number;
  rowCounts: Record<string, number>;
}

/**
 * Build a signed manifest ready to be written to disk. Returns the JSON
 * bytes (Buffer) — callers do not need to re-serialize.
 *
 * The HMAC is computed over the SAME canonical bytes that verification
 * re-generates, so a hostile editor cannot smuggle whitespace or key-
 * order changes past the signature.
 */
export function buildSignedManifest(hmacKey: Buffer, input: ManifestInput): Buffer {
  const unsigned = canonicalize({
    manifestVersion: MANIFEST_VERSION,
    backupId: input.backupId,
    createdAt: input.createdAt.toISOString(),
    kind: input.kind,
    appVersion: input.appVersion,
    formatVersion: input.formatVersion,
    encryptionVersion: input.encryptionVersion,
    contentSha256: input.contentSha256,
    schemaSha256: input.schemaSha256,
    schemaPrisma: input.schemaPrisma,
    sizeBytes: input.sizeBytes,
    components: ["database"],
    rowCounts: input.rowCounts
  });
  const hmac = computeManifestHmac(hmacKey, unsigned).toString("hex");
  // The wire format includes the HMAC as an additional key. We reparse the
  // canonical unsigned body, add manifestHmac, and re-canonicalize so the
  // final output remains deterministic and readable.
  const parsed = JSON.parse(unsigned.toString("utf8")) as Record<string, unknown>;
  parsed.manifestHmac = hmac;
  return canonicalize(parsed);
}

/**
 * Parse and cryptographically verify a manifest read from disk. Returns
 * the typed manifest on success. Throws with a discriminating error name
 * so the verifier can distinguish parse errors from HMAC failures for
 * telemetry.
 */
export function parseAndVerifyManifest(hmacKey: Buffer, raw: Buffer | string): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch (err) {
    throw new ManifestParseError(
      `Manifest JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ManifestParseError(
      `Manifest schema validation failed: ${parsed.error.message}`
    );
  }
  const manifest = parsed.data;

  // Re-serialize WITHOUT the HMAC field to reconstruct the exact bytes
  // that were signed at write time.
  const bodyForHmac = canonicalize(stripHmac(manifest));
  const ok = verifyManifestHmac(hmacKey, bodyForHmac, manifest.manifestHmac);
  if (!ok) {
    throw new ManifestHmacError("Manifest HMAC verification failed.");
  }
  return manifest;
}

/**
 * Read-only parse (no HMAC check) for cases where the caller only needs
 * to inspect the manifest structure — e.g., a diagnostic dashboard view.
 * NEVER used by the verify or restore engines — those always call
 * `parseAndVerifyManifest`.
 */
export function parseManifestUnverified(raw: Buffer | string): Manifest {
  const json = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  return ManifestSchema.parse(json);
}

export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestParseError";
  }
}

export class ManifestHmacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestHmacError";
  }
}

// ─── Canonicalization ──────────────────────────────────────────────────────
//
// Deterministic JSON serialization: sorted keys at every object level, no
// whitespace, arrays kept in the caller's order (they are semantically
// ordered — e.g., rowCounts is a record, not an array). Guarantees that
// two callers who build the "same" manifest byte-for-byte agree, so the
// HMAC signature is stable across implementations.

function canonicalize(value: unknown): Buffer {
  return Buffer.from(canonicalizeToString(value), "utf8");
}

function canonicalizeToString(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite number in manifest.");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeToString).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalizeToString(obj[k])
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`Unsupported value type in manifest: ${typeof value}`);
}

function stripHmac(m: Manifest): Omit<Manifest, "manifestHmac"> {
  const clone: Record<string, unknown> = { ...m };
  delete clone.manifestHmac;
  return clone as Omit<Manifest, "manifestHmac">;
}

import "server-only";

// ─── Deterministic value coercion for backup NDJSON records ─────────────────
//
// Every row read from Prisma passes through `coerceRow` before being written
// to the NDJSON stream. The wire form is designed so that a matching
// decoder (Phase 7 restore) can reconstruct exact JS values without
// ambiguity:
//
//   null            → null
//   number          → JSON number (Infinity/NaN throw)
//   string          → JSON string
//   boolean         → JSON boolean
//   bigint          → {"$n":"<decimal string>"}
//   Date            → {"$d":"<ISO 8601 UTC>"}
//   Buffer          → {"$b":"<base64url>"}
//   Prisma Decimal  → {"$dec":"<decimal string>"}   (defensive — no Decimal columns today)
//   Array           → JSON array (recursive coerce)
//   Plain object    → JSON object (recursive coerce)
//   undefined       → OMITTED from the enclosing object (Prisma never returns undefined for
//                     non-optional fields; optional fields come back as null)
//
// The wire form uses reserved `$`-prefixed single-key wrappers. Prisma
// `Json` fields (which are already parsed to JS values) are coerced
// recursively — if a legitimate `Json` payload contains `$d`, the
// wrapper would create ambiguity. We defensively DISALLOW keys that
// start with `$` in `Json` payloads at write time — but only inside
// `Json` fields, not at the row envelope. This is enforced by the
// serializer's `coerceValue`.

export class BackupSerializerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupSerializerError";
  }
}

/**
 * Coerce a single row into its wire-form object. Returns a plain object
 * ready to embed under `{"__row":{"model":"…","data": <here>}}`.
 */
export function coerceRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (v === undefined) continue;
    out[key] = coerceValue(v, key);
  }
  return out;
}

/**
 * Serialize a wire-form record to a single NDJSON line INCLUDING the
 * trailing newline. Callers write the returned string as UTF-8 bytes
 * to the pipeline.
 */
export function serializeRecord(record: unknown): string {
  return JSON.stringify(record) + "\n";
}

/**
 * Coerce a single value. Recursive. Rejects unsupported types
 * (functions, symbols) rather than silently dropping them — silent drop
 * would produce a backup that restores incompletely.
 */
export function coerceValue(v: unknown, path: string): unknown {
  if (v === null) return null;

  const t = typeof v;
  if (t === "boolean" || t === "string") return v;
  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new BackupSerializerError(
        `Non-finite number at "${path}": backup format refuses NaN/Infinity.`
      );
    }
    return v;
  }
  if (t === "bigint") {
    return { $n: (v as bigint).toString(10) };
  }
  if (t === "function" || t === "symbol") {
    throw new BackupSerializerError(
      `Unsupported value type at "${path}": ${t}.`
    );
  }
  if (t === "undefined") {
    throw new BackupSerializerError(`Unexpected undefined at "${path}".`);
  }

  // Object-shaped values below this point.
  if (v instanceof Date) {
    const iso = v.toISOString();
    if (!iso) throw new BackupSerializerError(`Invalid Date at "${path}".`);
    return { $d: iso };
  }

  if (isBufferLike(v)) {
    return { $b: bufferToBase64Url(v as Uint8Array) };
  }

  // Defensive: Prisma Decimal (if present in a future schema) is a
  // class-like object with a `toFixed` method. We serialize via toString
  // to preserve precision.
  if (isPrismaDecimalLike(v)) {
    return { $dec: (v as { toString(): string }).toString() };
  }

  if (Array.isArray(v)) {
    return v.map((item, i) => coerceValue(item, `${path}[${i}]`));
  }

  // Plain object. Refuse `$`-prefixed keys anywhere below the row
  // envelope — the row envelope's keys come from the Prisma schema
  // (which never uses `$` prefixes) and are set directly in coerceRow.
  // Every value passing through coerceValue is either a scalar column
  // value or a nested Prisma Json field; neither should ever contain
  // `$` keys in practice.
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (key.startsWith("$")) {
        throw new BackupSerializerError(
          `Reserved key prefix at "${path}.${key}" — object keys inside a row's field cannot start with "$" (would collide with wire-form wrappers).`
        );
      }
      const child = obj[key];
      if (child === undefined) continue;
      out[key] = coerceValue(child, `${path}.${key}`);
    }
    return out;
  }

  throw new BackupSerializerError(`Unknown value type at "${path}".`);
}

function isBufferLike(v: unknown): boolean {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return true;
  return v instanceof Uint8Array;
}

function bufferToBase64Url(u8: Uint8Array): string {
  return Buffer.from(u8).toString("base64url");
}

function isPrismaDecimalLike(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toFixed?: unknown }).toFixed === "function" &&
    typeof (v as { toString: unknown }).toString === "function" &&
    (v as { constructor?: { name?: string } }).constructor?.name === "Decimal"
  );
}

// ─── Symmetric decoder (used by Phase 7 restore + tests here) ────────────────
//
// Reverse of `coerceValue`. Kept next to the encoder so any format change
// forces both sides to update in lockstep. Not called by the dump engine
// itself — exposed for tests that round-trip a row and for Phase 7.

export function decodeValue(v: unknown, path: string): unknown {
  if (v === null) return null;

  const t = typeof v;
  if (t === "boolean" || t === "string" || t === "number") return v;

  if (Array.isArray(v)) {
    return v.map((item, i) => decodeValue(item, `${path}[${i}]`));
  }

  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);

    // Single-key wrappers: $n, $d, $b, $dec.
    if (keys.length === 1) {
      const [only] = keys;
      const inner = obj[only];
      if (only === "$n" && typeof inner === "string") {
        return BigInt(inner);
      }
      if (only === "$d" && typeof inner === "string") {
        // Strict ISO-8601 UTC shape — `Date.prototype.toISOString()`
        // is the only shape the encoder emits. Loose parsing (e.g.,
        // `new Date("2026")` succeeding as Jan 1 UTC) would let a
        // tampered NDJSON stream shift dates.
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(inner)) {
          throw new BackupSerializerError(
            `Invalid $d shape at "${path}" — must be strict ISO-8601 UTC.`
          );
        }
        const d = new Date(inner);
        if (Number.isNaN(d.valueOf())) {
          throw new BackupSerializerError(`Invalid $d value at "${path}".`);
        }
        return d;
      }
      if (only === "$b" && typeof inner === "string") {
        return Buffer.from(inner, "base64url");
      }
      if (only === "$dec" && typeof inner === "string") {
        // Return as string; caller in Phase 7 will hand to Prisma which
        // will re-parse into Prisma.Decimal at write time.
        return inner;
      }
    }

    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = decodeValue(obj[key], `${path}.${key}`);
    }
    return out;
  }

  throw new BackupSerializerError(`Unknown wire value at "${path}".`);
}

export function decodeRow(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BackupSerializerError("Row `data` must be a plain object.");
  }
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    out[key] = decodeValue(src[key], key);
  }
  return out;
}

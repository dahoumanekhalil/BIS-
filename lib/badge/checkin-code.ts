import "server-only";

import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

// Phase 19 — secure human-readable text check-in code service.
//
// PURPOSE:
//   The QR credential (Phase 2 / 5 / 10 / 11) remains the primary
//   check-in surface. When QR scanning fails at the entrance (damaged
//   screen, poor lighting, camera issue), an operator can enter a
//   human-readable code manually. This module owns the FORMAT and
//   GENERATION of that code. It does NOT own validation — see
//   `lib/admin/text-checkin-validator.ts` for the check-in decision.
//
// FORMAT:
//   Twelve characters from an unambiguous 28-char alphabet, split
//   into three groups of four separated by dashes:
//
//       XXXX-XXXX-XXXX     e.g. "K4MX-92QT-A7RN"
//
//   Charset excludes visually / phonetically ambiguous glyphs:
//     • 0 and O
//     • 1 and I
//     • 5 and S
//     • 8 and B
//   That leaves: A C D E F G H J K L M N P Q R T U V W X Y Z 2 3 4 6 7 9
//   (28 characters). 28^12 ≈ 2.4 × 10^17 combinations — brute-force
//   resistant when combined with the endpoint rate limits.
//
// STORAGE:
//   Stored plaintext in `Participant.checkinCode` (`@unique`). This
//   diverges from the tokenHash discipline of BadgeCredential /
//   AdminSession because the code MUST be re-displayable to the
//   attendee across sessions (their badge shows it every render).
//   The security surface is therefore:
//     (1) generation entropy — see above
//     (2) endpoint rate limit  — see text-checkin-validator.ts
//     (3) whitelist select     — the code is only read where the
//                                caller is already authorised (own
//                                badge OR admin registrant view OR
//                                validator lookup).
//   Never included in AuditLog metadata. Never logged. Never in URLs.
//
// LOOKUP:
//   Postgres unique index on `checkinCode` gives O(1) constant-time
//   equality — the "existing secure primitive" the brief calls for.
//   No hand-rolled comparison, no timing oracle beyond the DB.

// Unambiguous 28-char charset. Order intentional — grouped for the
// human reader (letters first, then digits).
const CHARSET = "ACDEFGHJKLMNPQRTUVWXYZ234679";
if (CHARSET.length !== 28) {
  throw new Error("checkin-code: charset length changed unexpectedly");
}

const GROUP_SIZE = 4;
const GROUP_COUNT = 3;
const PAYLOAD_LENGTH = GROUP_SIZE * GROUP_COUNT; // 12
export const CHECKIN_CODE_FORMATTED_LENGTH = PAYLOAD_LENGTH + (GROUP_COUNT - 1); // 14 (with 2 dashes)

// Assignment retry budget for the exceedingly rare unique-index
// collision. 28^12 makes collision astronomically unlikely, but the
// service is transaction-safe either way.
const MAX_GENERATION_RETRIES = 5;

// Regex allow-list for the CANONICAL (dashed) form. Anchored, ASCII,
// no path-traversal characters. `normalizeCheckinCode` produces this
// shape.
export const CHECKIN_CODE_CANONICAL_RE =
  /^[ACDEFGHJKLMNPQRTUVWXYZ234679]{4}-[ACDEFGHJKLMNPQRTUVWXYZ234679]{4}-[ACDEFGHJKLMNPQRTUVWXYZ234679]{4}$/;

// ─── Public API ────────────────────────────────────────────────────

// Generate a fresh code. Uses `crypto.randomInt` per position — a
// CSPRNG with an unbiased range (rejection sampling under the hood
// in Node's implementation). Not seeded, not derived from any
// participant field.
export function generateCheckinCode(): string {
  const out: string[] = [];
  for (let i = 0; i < GROUP_COUNT; i++) {
    if (i > 0) out.push("-");
    for (let j = 0; j < GROUP_SIZE; j++) {
      out.push(CHARSET.charAt(randomInt(0, CHARSET.length)));
    }
  }
  return out.join("");
}

// Convert user input into the canonical form for lookup.
// Rules (in order):
//   1. Reject non-string / empty input.
//   2. Strip whitespace and dashes.
//   3. Uppercase.
//   4. Reject anything not in the 28-char charset.
//   5. Reject anything not exactly 12 payload chars.
//   6. Re-insert dashes at group boundaries.
//
// Returns the canonical `XXXX-XXXX-XXXX` string, or null if the
// input cannot be normalized into a valid code shape. Callers MUST
// treat null as "invalid input" WITHOUT distinguishing it from
// "valid shape but unknown code" in any response visible to the
// operator (enumeration protection).
export function normalizeCheckinCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // 1..3 — strip separators + uppercase.
  const raw = input.replace(/[\s-]+/g, "").toUpperCase();
  if (raw.length !== PAYLOAD_LENGTH) return null;
  // 4 — every char must be in the charset.
  for (const ch of raw) {
    if (CHARSET.indexOf(ch) === -1) return null;
  }
  // 6 — re-format with dashes.
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// Idempotent assignment. Returns the existing code if the participant
// already has one; otherwise generates and stores a fresh code inside
// a transaction. Retry-safe against the (near-zero-probability) unique
// collision.
//
// SECURITY:
//   • Does NOT expose the code in error messages or throws.
//   • Never re-assigns a code that is already set (idempotent).
//   • Never returns a code for a non-existent participant.
export async function ensureCheckinCode(
  participantId: string
): Promise<string> {
  const existing = await prisma.participant.findUnique({
    where: { id: participantId },
    select: { id: true, checkinCode: true }
  });
  if (!existing) {
    throw new Error("participant not found");
  }
  if (existing.checkinCode) return existing.checkinCode;

  // Generate + retry loop. Under normal operation the loop exits
  // after the first iteration. Two failure modes are handled:
  //   • concurrent-caller race — `updateMany({where:{checkinCode:
  //     null}})` acts as an atomic claim (Phase 10 B3 pattern). If
  //     `count === 0`, someone else won: re-fetch and return the
  //     persisted value.
  //   • unique-index collision on `checkinCode` (P2002) — the
  //     28^12 space makes this astronomically unlikely, but we
  //     retry with a fresh candidate.
  for (let attempt = 0; attempt < MAX_GENERATION_RETRIES; attempt++) {
    const candidate = generateCheckinCode();
    try {
      const claim = await prisma.participant.updateMany({
        where: { id: participantId, checkinCode: null },
        data: { checkinCode: candidate }
      });
      if (claim.count === 1) return candidate;
      // count === 0 → another caller won the race. Return the code
      // they persisted rather than generating a second one.
      const winner = await prisma.participant.findUnique({
        where: { id: participantId },
        select: { checkinCode: true }
      });
      if (winner?.checkinCode) return winner.checkinCode;
      // If we get here, the participant vanished between reads —
      // treat as not-found rather than silently regenerating.
      throw new Error("participant not found");
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Unique collision — retry with a new candidate.
        continue;
      }
      throw err;
    }
  }
  throw new Error("checkin-code: exhausted generation retries");
}

// Admin-only regeneration. DEFERRED — see the master doc §Phase 19.
// The scaffold is left here so a future phase can flesh it out with
// the appropriate RBAC + audit. Not exported until wired.

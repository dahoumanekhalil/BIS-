"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/admin/auth";
import { validateMainEntranceQrCore } from "@/lib/admin/main-entrance-validator";
import { validateRoomQrCore } from "@/lib/admin/room-validator";
import type { ScannerValidationResult } from "./action-types";

// Phase 10 / 11 — QR validation server actions.
//
// Two separate exports, one per AccessPoint type. The scanner client
// picks which one to call based on the `accessPointType` prop passed
// down from the server-rendered scanner page (which itself resolved
// the AccessPoint from the URL slug and enforced Phase 9's type-aware
// permission gate).
//
// Each action:
//
//   1. requirePermission(...)  — STRICT, no legacy fallback.
//      • MAIN → access.validate.main
//      • ROOM → access.validate.room
//   2. Zod-parses the slug and rawToken shapes.
//   3. Delegates to the pure validator core, which re-resolves the
//      AccessPoint from the DB, re-checks active/type, verifies the
//      badge, and writes CheckIn / AuditLog server-side.
//
// The client cannot supply participantId, accessPointId, or any
// authorization claim. rawToken is treated as opaque and never
// logged or persisted.

// Same schema as the scanner route page — anchored, lowercase,
// ASCII-only, 2..48 chars. Rejects path-traversal and homograph
// attempts before any DB access.
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// The rawToken shape is validated inside verifyBadgeToken
// (MIN_TOKEN_LENGTH + hash lookup). Here we cap the string length
// to prevent hostile clients from pushing megabyte payloads through
// the server action. 1 KiB is generous compared to the ~43-char
// base64url tokens the badge service emits.
const rawTokenSchema = z.string().max(1024);

// ─── Phase 10 — MAIN_ENTRANCE ────────────────────────────────────
export async function validateMainEntranceQrScan(input: {
  rawToken: string;
  slug: string;
}): Promise<ScannerValidationResult> {
  const { user } = await requirePermission("access.validate.main");

  const slug = slugSchema.safeParse(input.slug);
  if (!slug.success) {
    return {
      ok: false,
      outcome: "ACCESS_POINT_UNKNOWN",
      message: "Point d'accès introuvable."
    };
  }
  const rawToken = rawTokenSchema.safeParse(input.rawToken);
  if (!rawToken.success) {
    return {
      ok: false,
      outcome: "BADGE_INVALID",
      message: "Badge non reconnu."
    };
  }

  return validateMainEntranceQrCore({
    user: { id: user.id },
    slug: slug.data,
    rawToken: rawToken.data
  });
}

// ─── Phase 11 — ROOM ─────────────────────────────────────────────
export async function validateRoomQrScan(input: {
  rawToken: string;
  slug: string;
}): Promise<ScannerValidationResult> {
  const { user } = await requirePermission("access.validate.room");

  const slug = slugSchema.safeParse(input.slug);
  if (!slug.success) {
    return {
      ok: false,
      outcome: "ACCESS_POINT_UNKNOWN",
      message: "Salle introuvable."
    };
  }
  const rawToken = rawTokenSchema.safeParse(input.rawToken);
  if (!rawToken.success) {
    return {
      ok: false,
      outcome: "BADGE_INVALID",
      message: "Badge non reconnu."
    };
  }

  return validateRoomQrCore({
    user: { id: user.id },
    slug: slug.data,
    rawToken: rawToken.data
  });
}

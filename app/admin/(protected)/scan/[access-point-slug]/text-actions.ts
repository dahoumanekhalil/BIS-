"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/admin/auth";
import { clientIp } from "@/lib/client-ip";
import {
  validateMainEntranceTextCore,
  validateRoomTextCore
} from "@/lib/admin/text-checkin-validator";
import type { ScannerValidationResult } from "./action-types";

// Phase 19 — text-code check-in server actions.
//
// Structural mirror of the QR actions (Phase 10 / 11) but with a
// different validator core and STRICT permission checks. No new
// permission introduced — text-code validation reuses the SAME
// scanner permissions:
//
//   MAIN_ENTRANCE → access.validate.main
//   ROOM          → access.validate.room
//
// The client sends only `code` (raw text input) and `slug` (echoed
// from the scanner route). The server:
//   • authenticates the operator via requirePermission
//   • resolves the AccessPoint by slug
//   • normalizes + hash-looks-up the code
//   • runs the SAME downstream authorization + CheckIn write as QR
//   • audits with action="checkin.scan.text"

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// 14 chars max canonical (XXXX-XXXX-XXXX). Bound at 32 to allow for
// user-typed whitespace / lowercase before normalization drops it.
const codeSchema = z.string().min(1).max(32);

export async function validateMainEntranceTextScan(input: {
  code: string;
  slug: string;
}): Promise<ScannerValidationResult> {
  const { user } = await requirePermission("access.validate.main");
  return runValidation({
    input,
    userId: user.id,
    kind: "MAIN"
  });
}

export async function validateRoomTextScan(input: {
  code: string;
  slug: string;
}): Promise<ScannerValidationResult> {
  const { user } = await requirePermission("access.validate.room");
  return runValidation({
    input,
    userId: user.id,
    kind: "ROOM"
  });
}

async function runValidation({
  input,
  userId,
  kind
}: {
  input: { code: string; slug: string };
  userId: string;
  kind: "MAIN" | "ROOM";
}): Promise<ScannerValidationResult> {
  const slug = slugSchema.safeParse(input.slug);
  if (!slug.success) {
    return {
      ok: false,
      outcome: "ACCESS_POINT_UNKNOWN",
      message:
        kind === "MAIN"
          ? "Point d'accès introuvable."
          : "Salle introuvable."
    };
  }
  const code = codeSchema.safeParse(input.code);
  if (!code.success) {
    return {
      ok: false,
      outcome: "BADGE_INVALID",
      message: "Code non reconnu."
    };
  }
  const ip = await clientIp();
  const core =
    kind === "MAIN"
      ? validateMainEntranceTextCore
      : validateRoomTextCore;
  return core({
    user: { id: userId },
    slug: slug.data,
    code: code.data,
    ip
  });
}

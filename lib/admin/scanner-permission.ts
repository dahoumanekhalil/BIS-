// Pure type→permission mapping for Phase 9 scanner routes.
//
// Lives outside the server-action tree because it is imported by a "use
// server" file and by tests. No React, no Prisma, no server-only marker —
// pure data.
//
// SECURITY: the scanner route MUST resolve the AccessPoint from the DB
// first, and only THEN pass the resolved `type` to this helper. Never
// route based on the URL slug string itself — see the Phase 8 audit's
// Phase 9 prerequisites (§14, "URL is authorization-adjacent, not
// authorization-authoritative").
//
// The legacy `checkin.validate` permission is DELIBERATELY NOT accepted
// here. That decision was made in the pre-Phase-5 hardening pass and
// documented in the master doc's Phase 3 completion record:
//
//   • `checkin.validate` → authorizes ONLY the legacy manual
//                          /admin/check-in ticket-code flow.
//   • `access.validate.main` → MAIN_ENTRANCE QR scanner (Phase 9+).
//   • `access.validate.room` → ROOM QR scanner (Phase 9+).
import type { AccessPointType } from "@prisma/client";
import type { Permission } from "@/lib/admin/rbac";

export function requiredScannerPermission(
  type: AccessPointType
): Permission {
  switch (type) {
    case "MAIN_ENTRANCE":
      return "access.validate.main";
    case "ROOM":
      return "access.validate.room";
  }
}

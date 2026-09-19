// Pure tri-state helper for ParticipantAccess. Lives in its own file — no
// React, no Prisma, no server-only — so it can be imported by both server
// components and standalone tests (which run under Node without Next.js's
// React runtime available).
//
// See lib/account/participant.ts for the query that produces the input,
// and the "3–4 hardening" note in the master implementation doc for why
// the tri-state exists.
export type AccessState = "granted" | "denied" | "unassigned";

export function accessStateFor(
  accessPermissions: ReadonlyArray<{
    accessPointId: string;
    granted: boolean;
  }>,
  accessPointId: string
): AccessState {
  const row = accessPermissions.find((p) => p.accessPointId === accessPointId);
  if (!row) return "unassigned";
  return row.granted ? "granted" : "denied";
}

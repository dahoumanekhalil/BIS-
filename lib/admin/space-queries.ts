import "server-only";

import { prisma } from "@/lib/db";
import type { AccessPointType } from "@prisma/client";
import {
  readActivities,
  readExhibitors,
  readTopics,
  type SpaceActivity,
  type SpaceExhibitor,
  type SpaceTopic
} from "@/lib/admin/space-content";

// Phase 17 — read helpers for the Spaces admin surface.
//
// All queries whitelist-select. No password / session-token / audit
// metadata / raw QR credential reaches the caller. The Spaces UI is
// gated at `access.view` (read) + `settings.manage` (write) — same
// permissions Phase 8 uses for AccessPoint administration.

// Row shape for the list card. Counts are computed via `_count`.
export type SpaceListRow = {
  id: string;
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  order: number;
  admissionMode: "FREE" | "PAID" | null;
  activityCount: number;
  topicCount: number;
  exhibitorCount: number;
  teamCount: number;
  checkInCount: number;
  permissionCount: number;
};

export async function listSpaces(): Promise<SpaceListRow[]> {
  const rows = await prisma.accessPoint.findMany({
    orderBy: [{ type: "asc" }, { order: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      active: true,
      order: true,
      admissionMode: true,
      activities: true,
      topics: true,
      exhibitors: true,
      _count: {
        select: {
          teamMembers: true,
          checkIns: true,
          permissions: true
        }
      }
    }
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    type: r.type,
    active: r.active,
    order: r.order,
    admissionMode: r.admissionMode,
    activityCount: readActivities(r.activities).length,
    topicCount: readTopics(r.topics).length,
    exhibitorCount: readExhibitors(r.exhibitors).length,
    teamCount: r._count.teamMembers,
    checkInCount: r._count.checkIns,
    permissionCount: r._count.permissions
  }));
}

export type SpaceDetail = {
  id: string;
  slug: string;
  name: string;
  type: AccessPointType;
  active: boolean;
  order: number;
  description: string | null;
  admissionMode: "FREE" | "PAID" | null;
  activities: SpaceActivity[];
  topics: SpaceTopic[];
  exhibitors: SpaceExhibitor[];
  createdAt: Date;
  updatedAt: Date;
  team: Array<{
    adminUserId: string;
    assignedAt: Date;
    user: {
      id: string;
      name: string;
      email: string;
      role: string;
      status: string;
    };
  }>;
  counts: {
    checkIns: number;
    permissions: number;
  };
};

export async function getSpaceBySlug(
  slug: string
): Promise<SpaceDetail | null> {
  const r = await prisma.accessPoint.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      type: true,
      active: true,
      order: true,
      description: true,
      admissionMode: true,
      activities: true,
      topics: true,
      exhibitors: true,
      createdAt: true,
      updatedAt: true,
      teamMembers: {
        orderBy: { assignedAt: "desc" },
        select: {
          adminUserId: true,
          assignedAt: true,
          adminUser: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              status: true
            }
          }
        }
      },
      _count: {
        select: { checkIns: true, permissions: true }
      }
    }
  });
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    type: r.type,
    active: r.active,
    order: r.order,
    description: r.description,
    admissionMode: r.admissionMode,
    activities: readActivities(r.activities),
    topics: readTopics(r.topics),
    exhibitors: readExhibitors(r.exhibitors),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    team: r.teamMembers.map((tm) => ({
      adminUserId: tm.adminUserId,
      assignedAt: tm.assignedAt,
      user: tm.adminUser
    })),
    counts: {
      checkIns: r._count.checkIns,
      permissions: r._count.permissions
    }
  };
}

// Eligible-user picker for the "Ajouter un membre" flow. Returns
// active admin users that are NOT already on the team. Whitelist
// select — no passwordHash, no sessions.
export async function listAssignableAdmins(
  accessPointId: string
): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  return prisma.adminUser.findMany({
    where: {
      status: "ACTIVE",
      NOT: { teamMemberships: { some: { accessPointId } } }
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, role: true }
  });
}

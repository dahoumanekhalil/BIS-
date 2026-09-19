import { AdminRole, RegistrationTier } from "@prisma/client";
import { ROLE_PERMISSIONS, type Permission } from "./rbac";
import {
  OPS,
  OP_LABEL,
  OP_SHORT,
  STAFF_MODULES,
  type Op,
  type ModuleCategory,
  type StaffModule
} from "./role-catalog-data";

// Re-export pure data from the client-safe module to avoid duplication.
// Note: ModuleAccess is NOT re-exported here — the server-side version
// (defined below) has different fields than the client-safe one in role-catalog-data.ts.
export {
  OPS,
  OP_LABEL,
  OP_SHORT,
  STAFF_MODULES,
  type Op,
  type ModuleCategory,
  type StaffModule
};

// Public (attendee) modules — VVIP / VIP / Visitor / Sponsor
// These roles have no rows in AdminRole; capabilities are fixed.
export type PublicModule = {
  key: string;
  label: string;
  description: string;
  ops: Partial<Record<Op, true>>;
};

export const PUBLIC_MODULES: PublicModule[] = [
  {
    key: "profile",
    label: "Profil personnel",
    description: "Nom, coordonnées, préférences.",
    ops: { read: true, update: true }
  },
  {
    key: "password",
    label: "Mot de passe",
    description: "Changement de mot de passe.",
    ops: { update: true }
  },
  {
    key: "ticket",
    label: "Ticket & QR code",
    description: "Ticket d'entrée personnel.",
    ops: { read: true }
  },
  {
    key: "itinerary",
    label: "Mon itinéraire",
    description: "Programme personnel selon le tier.",
    ops: { read: true }
  },
  {
    key: "sessions",
    label: "Sessions publiques",
    description: "Programme du sommet (lecture seule).",
    ops: { read: true }
  }
];

// ---------------------------------------------------------------------------
// Role identity / display metadata
// ---------------------------------------------------------------------------

export type RoleTone =
  | "cobalt"
  | "navy"
  | "lime"
  | "gold"
  | "silver"
  | "slate"
  | "rose";

export type RoleId = string;

export type StaffRoleCard = {
  key: RoleId;
  kind: "staff";
  adminRole: AdminRole;
  name: string;
  tag: string;
  tone: RoleTone;
  initials: string;
  headline: string;
  summary: string;
};

export type PublicRoleCard = {
  key: RoleId;
  kind: "attendee";
  tier: RegistrationTier | "SPONSOR";
  name: string;
  tag: string;
  tone: RoleTone;
  initials: string;
  headline: string;
  summary: string;
};

export type RoleCard = StaffRoleCard | PublicRoleCard;

export const ROLE_CATALOG: RoleCard[] = [
  {
    key: "super_admin",
    kind: "staff",
    adminRole: AdminRole.SUPER_ADMIN,
    name: "Super Admin",
    tag: "Staff · Contrôle total",
    tone: "lime",
    initials: "SA",
    headline: "Possède la plateforme.",
    summary:
      "Accès à tous les modules, y compris finance, rôles et paramètres système. Aucune restriction."
  },
  {
    key: "admin",
    kind: "staff",
    adminRole: AdminRole.ADMIN,
    name: "Admin",
    tag: "Staff · Opérations",
    tone: "cobalt",
    initials: "AD",
    headline: "Gère les opérations quotidiennes.",
    summary:
      "Pilote toutes les opérations événementielles. N'a pas accès à la section argent (revenue, finance)."
  },
  {
    key: "sales",
    kind: "staff",
    adminRole: AdminRole.SALES,
    name: "Sales",
    tag: "Staff · Inscriptions",
    tone: "navy",
    initials: "SL",
    headline: "S'occupe des inscrits et du suivi commercial.",
    summary:
      "Voit la liste des inscrits et peut agir dessus — modifier, renvoyer un ticket, relancer par email."
  },
  {
    key: "vvip",
    kind: "attendee",
    tier: RegistrationTier.VVIP,
    name: "VVIP",
    tag: "Attendee · Top tier",
    tone: "gold",
    initials: "VV",
    headline: "Accès participant en lecture seule.",
    summary:
      "Se connecte pour voir ses informations, son ticket, son itinéraire privé et ses avantages. Ne peut rien modifier au-delà de son profil."
  },
  {
    key: "vip",
    kind: "attendee",
    tier: RegistrationTier.VIP,
    name: "VIP",
    tag: "Attendee",
    tone: "silver",
    initials: "VI",
    headline: "Accès participant en lecture seule.",
    summary:
      "Même périmètre que VVIP — profil, ticket, informations publiques. Aucun accès back-office."
  },
  {
    key: "visitor",
    kind: "attendee",
    tier: RegistrationTier.VISITOR,
    name: "Visitor",
    tag: "Attendee · Grand public",
    tone: "slate",
    initials: "VS",
    headline: "Accès participant en lecture seule.",
    summary:
      "Participant basique — profil, ticket et programme public. Aucun accès back-office."
  },
  {
    key: "sponsor",
    kind: "attendee",
    tier: "SPONSOR",
    name: "Sponsor",
    tag: "Partner",
    tone: "rose",
    initials: "SP",
    headline: "Espace sponsor en lecture seule.",
    summary:
      "Voit son profil sponsor, ses pass délégués et les informations publiques. Même périmètre qu'un VIP — aucun accès opérationnel."
  }
];

// ---------------------------------------------------------------------------
// Access computation
// ---------------------------------------------------------------------------

export type ModuleAccess = {
  key: string;
  label: string;
  description: string;
  category: ModuleCategory;
  granted: Partial<Record<Op, true>>;
  totalOps: number;
  grantedOps: number;
};

/** For staff roles: derive granted ops per module from ROLE_PERMISSIONS. */
export function computeStaffAccess(role: AdminRole): ModuleAccess[] {
  const perms = new Set<Permission>(ROLE_PERMISSIONS[role]);
  return STAFF_MODULES.map((m) => {
    const granted: Partial<Record<Op, true>> = {};
    let grantedOps = 0;
    let totalOps = 0;
    for (const op of OPS) {
      const perm = m.ops[op];
      if (perm == null) continue;
      totalOps += 1;
      if (perms.has(perm as Permission)) {
        granted[op] = true;
        grantedOps += 1;
      }
    }
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      category: m.category,
      granted,
      totalOps,
      grantedOps
    };
  });
}

/** For public roles: all four (VVIP/VIP/Visitor/Sponsor) share PUBLIC_MODULES. */
export function computePublicAccess(): ModuleAccess[] {
  return PUBLIC_MODULES.map((m) => {
    const granted: Partial<Record<Op, true>> = {};
    let grantedOps = 0;
    let totalOps = 0;
    for (const op of OPS) {
      const has = m.ops[op];
      if (has == null) continue;
      totalOps += 1;
      granted[op] = true;
      grantedOps += 1;
    }
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      category: "Personal" as ModuleCategory,
      granted,
      totalOps,
      grantedOps
    };
  });
}

export function getRoleCard(key: RoleId): RoleCard | undefined {
  return ROLE_CATALOG.find((r) => r.key === key);
}

export function getAccessForRole(card: RoleCard): ModuleAccess[] {
  return card.kind === "staff"
    ? computeStaffAccess(card.adminRole)
    : computePublicAccess();
}

// Pure data — safe to import from "use client" components.
// No Prisma, no rbac, no server-only imports.

export const OPS = [
  "create",
  "read",
  "update",
  "delete",
  "export",
  "email"
] as const;
export type Op = (typeof OPS)[number];

export const OP_LABEL: Record<Op, string> = {
  create: "Créer",
  read: "Voir",
  update: "Modifier",
  delete: "Supprimer",
  export: "Exporter",
  email: "Envoyer email"
};

export const OP_SHORT: Record<Op, string> = {
  create: "C",
  read: "R",
  update: "U",
  delete: "D",
  export: "E",
  email: "@"
};

export type ModuleCategory =
  | "Overview"
  | "Attendees"
  | "Event"
  | "Business"
  | "System"
  | "Personal";

export type StaffModule = {
  key: string;
  label: string;
  description: string;
  category: ModuleCategory;
  ops: Partial<Record<Op, string>>;
};

export const STAFF_MODULES: StaffModule[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    description: "Vue d'ensemble opérationnelle du sommet.",
    category: "Overview",
    ops: { read: "dashboard.view" }
  },
  {
    key: "registrants",
    label: "Registrants",
    description: "Liste des personnes inscrites, fiche détaillée, historique.",
    category: "Attendees",
    ops: {
      read: "registrants.view",
      update: "registrants.edit",
      delete: "registrants.delete",
      export: "registrants.export",
      email: "registrants.email"
    }
  },
  {
    key: "checkin",
    label: "Check-in",
    description: "Scan des badges et validation aux portes.",
    category: "Attendees",
    ops: {
      read: "checkin.view",
      update: "checkin.validate"
    }
  },
  {
    key: "gates",
    label: "Portes (Gates)",
    description: "Configuration des points d'accès.",
    category: "Event",
    ops: {
      read: "gates.view",
      create: "gates.manage",
      update: "gates.manage",
      delete: "gates.manage"
    }
  },
  {
    key: "amenities",
    label: "Amenities",
    description: "Services et prestations (VIP lounge, catering, etc.).",
    category: "Event",
    ops: {
      read: "amenities.view",
      create: "amenities.manage",
      update: "amenities.manage",
      delete: "amenities.manage"
    }
  },
  {
    key: "sessions",
    label: "Sessions",
    description: "Programme : keynotes, panels, workshops.",
    category: "Event",
    ops: {
      read: "sessions.view",
      create: "sessions.manage",
      update: "sessions.manage",
      delete: "sessions.manage"
    }
  },
  {
    key: "speakers",
    label: "Speakers",
    description: "Fiches intervenants et associations aux sessions.",
    category: "Event",
    ops: {
      read: "speakers.view",
      create: "speakers.manage",
      update: "speakers.manage",
      delete: "speakers.manage"
    }
  },
  {
    key: "itineraries",
    label: "Itinéraires",
    description: "Parcours personnalisés par tier.",
    category: "Event",
    ops: {
      read: "itineraries.view",
      create: "itineraries.manage",
      update: "itineraries.manage",
      delete: "itineraries.manage"
    }
  },
  {
    key: "sponsors",
    label: "Sponsors",
    description: "Partenaires et sponsors du sommet.",
    category: "Business",
    ops: {
      read: "sponsors.view",
      create: "sponsors.manage",
      update: "sponsors.manage",
      delete: "sponsors.manage"
    }
  },
  // Payment-removal: "Revenue & Finance" catalog entry was deleted
  // alongside /admin/revenue and the `revenue.view` / `revenue.reconcile`
  // permissions. Room-payment operations were retired when BIS 2027
  // switched to FREE-only room registration.
  {
    key: "analytics",
    label: "Analytics",
    description: "Métriques d'engagement et de conversion.",
    category: "Business",
    ops: { read: "analytics.view" }
  },
  {
    key: "users",
    label: "Utilisateurs",
    description: "Gestion des comptes admin.",
    category: "System",
    ops: {
      read: "users.manage",
      create: "users.manage",
      update: "users.manage",
      delete: "users.manage"
    }
  },
  {
    key: "roles",
    label: "Rôles & Permissions",
    description: "Cette page. Définition des rôles et de leurs droits.",
    category: "System",
    ops: {
      read: "roles.manage",
      create: "roles.manage",
      update: "roles.manage",
      delete: "roles.manage"
    }
  },
  {
    key: "audit",
    label: "Audit log",
    description: "Journal d'activité admin (immuable).",
    category: "System",
    ops: { read: "audit.view" }
  },
  {
    key: "settings",
    label: "Paramètres",
    description: "Configuration globale de la plateforme.",
    category: "System",
    ops: {
      read: "settings.manage",
      update: "settings.manage"
    }
  }
];

export type ModuleAccess = {
  key: string;
  label: string;
  description: string;
  category: ModuleCategory;
  granted: Partial<Record<Op, boolean>>;
};
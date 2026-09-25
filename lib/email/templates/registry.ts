// Centralised registry of variables that admin-authored templates can
// reference. Names are the same the code-catalog templates already use
// (see `lib/admin/email-templates.ts` EMAIL_VARIABLES) so a DB override
// receives the same variable bag its code-catalog counterpart does.
//
// The registry is used to:
//   â€¢ populate the "Available variables" panel in the editor
//   â€¢ validate a template at activation time (unknown vars are rejected)
//   â€¢ generate example-value substitutions for the admin preview

export type TemplateVariable = {
  key: string;
  label: string;
  description: string;
  example: string;
  categories: Array<
    | "profile"
    | "event"
    | "auth"
    | "registration"
    | "room"
    | "contact"
    | "admin"
  >;
};

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  // Profile
  { key: "firstName", label: "PrÃ©nom", description: "PrÃ©nom du destinataire", example: "Fatima", categories: ["profile"] },
  { key: "lastName", label: "Nom", description: "Nom de famille du destinataire", example: "Zohra", categories: ["profile"] },
  { key: "fullName", label: "Nom complet", description: "PrÃ©nom + nom", example: "Fatima Zohra", categories: ["profile"] },
  { key: "email", label: "Email", description: "Adresse email du destinataire", example: "fatima@example.com", categories: ["profile"] },

  // Event
  { key: "eventDate", label: "Dates de l'Ã©vÃ©nement", description: "Plage de dates BIS 2027", example: "3 â€“ 5 janvier 2017", categories: ["event"] },
  { key: "eventVenue", label: "Lieu de l'Ã©vÃ©nement", description: "Site principal de l'Ã©vÃ©nement", example: "CIC Alger", categories: ["event"] },

  // Auth
  { key: "verificationUrl", label: "Lien de vÃ©rification", description: "URL de vÃ©rification d'email (single-use)", example: "https://bis-algeria.dz/api/auth/verify-email?token=â€¦", categories: ["auth"] },
  { key: "resetUrl", label: "Lien de rÃ©initialisation", description: "URL de reset de mot de passe (single-use)", example: "https://bis-algeria.dz/auth/mot-de-passe-reset?token=â€¦", categories: ["auth"] },
  { key: "expiresInHours", label: "Expiration (heures)", description: "DurÃ©e de validitÃ© du lien", example: "24", categories: ["auth"] },
  { key: "issuedAt", label: "Ã‰mis le", description: "Horodatage ISO", example: "2027-11-14T09:00:00Z", categories: ["auth", "admin"] },

  // Registration
  { key: "tier", label: "Tarif", description: "Niveau d'inscription", example: "Standard", categories: ["registration"] },
  { key: "gate", label: "Porte", description: "Porte d'entrÃ©e assignÃ©e", example: "A", categories: ["registration"] },
  { key: "ticketCode", label: "Code du billet", description: "Code alphanumÃ©rique du billet", example: "BIS-2027-A7X9", categories: ["registration"] },

  // Room registration (Payment-removal Phase 3: rooms are FREE-only,
  // so `roomPrice` and `roomCurrency` are dropped alongside the schema
  // fields.)
  { key: "roomName", label: "Nom de la salle", description: "Salle ou espace concernÃ©", example: "Salle Kabylie", categories: ["room"] },

  // Contact
  { key: "contactName", label: "Nom du contact", description: "Personne ayant soumis le formulaire", example: "Karim Ould", categories: ["contact"] },
  { key: "contactEmail", label: "Email du contact", description: "Adresse email fournie", example: "karim@partner.dz", categories: ["contact"] },
  { key: "contactOrganization", label: "Organisation", description: "Entreprise / organisme", example: "OldWorks", categories: ["contact"] },
  { key: "contactReason", label: "Motif", description: "Motif du message", example: "Partenariat / sponsor", categories: ["contact"] },
  { key: "contactSubject", label: "Sujet", description: "Sujet libre", example: "Partenariat BIS 2027", categories: ["contact"] },
  { key: "contactMessage", label: "Message", description: "Contenu du message", example: "Bonjour, nous serions ravisâ€¦", categories: ["contact"] },

  // Admin
  { key: "adminName", label: "Nom de l'administrateur", description: "Nom d'un admin destinataire", example: "Youcef Bekkouche", categories: ["admin"] }
];

const VAR_KEYS = new Set(TEMPLATE_VARIABLES.map((v) => v.key));

export function isKnownVariable(key: string): boolean {
  return VAR_KEYS.has(key);
}

/** Extract every {{name}} token from a source string. */
export function extractPlaceholders(source: string): string[] {
  const out = new Set<string>();
  const rx = /\{\{\s*(\w+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(source)) !== null) out.add(m[1]);
  return Array.from(out);
}

/** Return only the placeholders present in `source` that are not registered. */
export function unknownPlaceholders(source: string): string[] {
  return extractPlaceholders(source).filter((k) => !isKnownVariable(k));
}

/** Build a fully-populated preview `vars` bag from the registry examples. */
export function sampleVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of TEMPLATE_VARIABLES) out[v.key] = v.example;
  return out;
}

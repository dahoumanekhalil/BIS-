import type { EmailContent } from "@/lib/email/render";

export type EmailTemplateCategory =
  | "onboarding"
  | "payment"
  | "logistics"
  | "reminder"
  | "post-event"
  | "application"
  | "custom";

export type EmailTemplate = {
  key: string;
  category: EmailTemplateCategory;
  label: string;
  description: string;
  subject: string;
  eyebrow?: string;
  content: EmailContent;
};

export const CATEGORY_LABEL: Record<EmailTemplateCategory, string> = {
  onboarding: "Accueil",
  payment: "Paiement",
  logistics: "Logistique",
  reminder: "Rappel",
  "post-event": "Post-événement",
  application: "Candidature",
  custom: "Personnalisé"
};

// Available variables that can be interpolated inside subject/body/blocks.
export const EMAIL_VARIABLES = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "tier",
  "gate",
  "ticketCode",
  "paymentAmount",
  "paymentRef",
  "eventDate",
  "eventVenue"
] as const;

export type EmailVarKey = (typeof EMAIL_VARIABLES)[number];

const SITE = "https://bis-algeria.dz";

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    key: "welcome",
    category: "onboarding",
    label: "Bienvenue",
    description: "Confirmation d'inscription initiale, ton chaleureux.",
    subject: "Bienvenue au BIS 2026, {{firstName}}",
    eyebrow: "BIS 2026 · Inscription",
    content: {
      eyebrow: "BIS 2026 · Inscription",
      heading: "Bienvenue au BIS 2026, {{firstName}}.",
      paragraphs: [
        "Merci de vous être inscrit·e au Algeria Brand Impact Summit 2026. Votre profil est enregistré.",
        "Nous confirmerons votre accès dès la finalisation de votre paiement. Vous recevrez alors votre pass digital et votre porte d'accès."
      ],
      infoCard: {
        title: "Récapitulatif",
        rows: [
          { label: "Nom", value: "{{firstName}} {{lastName}}" },
          { label: "Email", value: "{{email}}" },
          { label: "Tier", value: "{{tier}}" },
          { label: "Date", value: "{{eventDate}}" },
          { label: "Lieu", value: "{{eventVenue}}" }
        ]
      },
      cta: { label: "Accéder à mon espace", url: `${SITE}/inscription` },
      note: "Une question ? Répondez simplement à cet email — notre équipe reviendra vers vous sous 48 heures ouvrées."
    }
  },
  {
    key: "payment-confirmed",
    category: "payment",
    label: "Paiement confirmé",
    description: "Confirmation du règlement + rappel du ticket.",
    subject: "Paiement confirmé · Ticket {{ticketCode}}",
    eyebrow: "BIS 2026 · Paiement",
    content: {
      eyebrow: "BIS 2026 · Paiement",
      heading: "Votre paiement est confirmé.",
      paragraphs: [
        "Bonjour {{firstName}}, nous avons bien reçu votre paiement pour le BIS 2026. Votre inscription est maintenant validée.",
        "Conservez le code ticket ci-dessous — il vous sera demandé à l'entrée le jour J."
      ],
      infoCard: {
        title: "Détails du paiement",
        rows: [
          { label: "Montant", value: "{{paymentAmount}} DZD" },
          { label: "Référence", value: "{{paymentRef}}" },
          { label: "Ticket", value: "{{ticketCode}}" },
          { label: "Tier", value: "{{tier}}" }
        ]
      },
      cta: { label: "Voir mon billet", url: `${SITE}/inscription` }
    }
  },
  {
    key: "payment-reminder",
    category: "payment",
    label: "Rappel de paiement",
    description: "Relance pour finaliser le règlement — ton neutre.",
    subject: "Finalisez votre inscription au BIS 2026",
    eyebrow: "BIS 2026 · Paiement en attente",
    content: {
      eyebrow: "BIS 2026 · Paiement en attente",
      heading: "Votre inscription nécessite encore une action.",
      paragraphs: [
        "Bonjour {{firstName}}, votre inscription au BIS 2026 est en attente de paiement.",
        "Pour sécuriser votre place au {{eventVenue}} le {{eventDate}}, merci de finaliser votre règlement."
      ],
      infoCard: {
        rows: [
          { label: "Nom", value: "{{firstName}} {{lastName}}" },
          { label: "Tier", value: "{{tier}}" },
          { label: "Statut", value: "En attente de paiement" }
        ]
      },
      cta: { label: "Finaliser mon paiement", url: `${SITE}/inscription` },
      note: "Passé le délai, votre place pourra être attribuée à la liste d'attente."
    }
  },
  {
    key: "ticket-delivered",
    category: "logistics",
    label: "Ticket & QR délivré",
    description: "Envoi du code d'accès pour le check-in — visuel fort.",
    subject: "Votre pass BIS 2026 · {{ticketCode}}",
    eyebrow: "BIS 2026 · Accès",
    content: {
      eyebrow: "BIS 2026 · Accès",
      heading: "Votre accès au BIS 2026 est prêt.",
      paragraphs: [
        "Bonjour {{firstName}}, votre pass digital est disponible. Présentez le code ci-dessous à l'entrée — nous vous accueillerons dès 09h00."
      ],
      ticketBlock: {
        ticketCode: "{{ticketCode}}",
        tier: "{{tier}}",
        gate: "{{gate}}",
        date: "{{eventDate}}",
        venue: "{{eventVenue}}"
      },
      cta: { label: "Ouvrir mon billet", url: `${SITE}/inscription` },
      note: "Munissez-vous d'une pièce d'identité et présentez-vous à la porte indiquée."
    }
  },
  {
    key: "gate-assigned",
    category: "logistics",
    label: "Attribution de la porte",
    description: "Notification de la porte physique assignée.",
    subject: "Votre porte d'accès BIS 2026 · {{gate}}",
    eyebrow: "BIS 2026 · Porte d'accès",
    content: {
      eyebrow: "BIS 2026 · Porte d'accès",
      heading: "Votre porte d'accès est confirmée.",
      paragraphs: [
        "Bonjour {{firstName}}, pour fluidifier l'accueil, votre porte d'entrée est confirmée."
      ],
      infoCard: {
        rows: [
          { label: "Porte", value: "{{gate}}" },
          { label: "Fenêtre d'entrée", value: "09h00 – 10h30" },
          { label: "Date", value: "{{eventDate}}" },
          { label: "Lieu", value: "{{eventVenue}}" },
          { label: "Ticket", value: "{{ticketCode}}" }
        ]
      },
      note: "L'accès doit être effectué par la porte indiquée pendant le créneau autorisé."
    }
  },
  {
    key: "day-before",
    category: "reminder",
    label: "Rappel J-1",
    description: "Envoyé la veille pour préparer l'arrivée.",
    subject: "Rendez-vous demain au BIS 2026",
    eyebrow: "BIS 2026 · Rappel J-1",
    content: {
      eyebrow: "BIS 2026 · Rappel J-1",
      heading: "À demain au BIS 2026.",
      paragraphs: [
        "Bonjour {{firstName}}, nous avons hâte de vous accueillir demain au {{eventVenue}}.",
        "Préparez votre code ticket avant votre arrivée — il vous sera demandé à l'entrée."
      ],
      infoCard: {
        title: "Votre journée",
        rows: [
          { label: "Ouverture", value: "09h00" },
          { label: "Porte", value: "{{gate}}" },
          { label: "Tier", value: "{{tier}}" },
          { label: "Ticket", value: "{{ticketCode}}" }
        ]
      },
      cta: { label: "Voir mon billet", url: `${SITE}/inscription` }
    }
  },
  {
    key: "check-in-morning",
    category: "reminder",
    label: "Rappel J-0",
    description: "Envoyé le matin même — clair et opérationnel.",
    subject: "Bon sommet — Votre code d'entrée",
    eyebrow: "BIS 2026 · Jour J",
    content: {
      eyebrow: "BIS 2026 · Jour J",
      heading: "Le BIS commence aujourd'hui.",
      paragraphs: [
        "Bonjour {{firstName}}, bienvenue au jour J du BIS 2026. Rendez-vous au {{eventVenue}} dès 09h00."
      ],
      ticketBlock: {
        ticketCode: "{{ticketCode}}",
        tier: "{{tier}}",
        gate: "{{gate}}",
        date: "Aujourd'hui",
        venue: "{{eventVenue}}"
      },
      note: "Portes ouvertes à 09h00 · Premier talk à 10h00. À tout de suite."
    }
  },
  {
    key: "post-event-thanks",
    category: "post-event",
    label: "Merci post-événement",
    description: "Remerciement + lien vers les replays.",
    subject: "Merci d'avoir été des nôtres au BIS 2026",
    eyebrow: "BIS 2026 · Merci",
    content: {
      eyebrow: "BIS 2026 · Merci",
      heading: "Merci d'avoir participé au BIS 2026.",
      paragraphs: [
        "Bonjour {{firstName}}, merci d'avoir vécu le BIS 2026 avec nous. Votre présence a rendu cette édition possible.",
        "Les replays et ressources seront disponibles dans les prochaines semaines. Nous vous préviendrons dès leur mise en ligne."
      ],
      cta: { label: "Découvrir l'Impact Studio", url: `${SITE}` }
    }
  },
  {
    key: "cancellation",
    category: "post-event",
    label: "Confirmation d'annulation",
    description: "Confirmation d'annulation d'inscription.",
    subject: "Votre inscription BIS 2026 a été annulée",
    eyebrow: "BIS 2026 · Annulation",
    content: {
      eyebrow: "BIS 2026 · Annulation",
      heading: "Votre inscription a été annulée.",
      paragraphs: [
        "Bonjour {{firstName}}, nous confirmons l'annulation de votre inscription au BIS 2026."
      ],
      infoCard: {
        rows: [
          { label: "Nom", value: "{{firstName}} {{lastName}}" },
          { label: "Tier", value: "{{tier}}" },
          { label: "Référence", value: "{{paymentRef}}" }
        ]
      },
      note: "Si un remboursement s'applique, il sera traité sous 10 jours ouvrés. N'hésitez pas à revenir vers nous pour les prochaines éditions."
    }
  },
  {
    key: "waitlist-promotion",
    category: "onboarding",
    label: "Place attribuée (liste d'attente)",
    description: "Attribution d'une place depuis la liste d'attente.",
    subject: "Bonne nouvelle · Votre place BIS 2026 est confirmée",
    eyebrow: "BIS 2026 · Liste d'attente",
    content: {
      eyebrow: "BIS 2026 · Liste d'attente",
      heading: "Une place vient de se libérer.",
      paragraphs: [
        "Bonjour {{firstName}}, une place s'est libérée et nous vous l'attribuons.",
        "Merci de finaliser votre paiement sous 48 heures pour verrouiller votre inscription."
      ],
      infoCard: {
        rows: [
          { label: "Tier", value: "{{tier}}" },
          { label: "Porte", value: "{{gate}}" },
          { label: "Ticket", value: "{{ticketCode}}" }
        ]
      },
      cta: { label: "Confirmer ma place", url: `${SITE}/inscription` }
    }
  },

  /* ------------------------------ REGISTRATIONS ------------------------------ */

  {
    key: "registration-visitor-received",
    category: "onboarding",
    label: "Inscription visiteur reçue",
    description:
      "Confirmation d'inscription pour un visiteur individuel.",
    subject: "Votre inscription au BIS 2026 est enregistrée, {{firstName}}",
    eyebrow: "BIS 2026 · Inscription",
    content: {
      eyebrow: "BIS 2026 · Inscription",
      heading: "Bienvenue au BIS 2026, {{firstName}}.",
      paragraphs: [
        "Merci pour votre inscription au Algeria Brand Impact Summit 2026. Votre profil est bien enregistré.",
        "Vous recevrez un email dédié dès que votre pass digital sera prêt, ainsi que votre porte d'accès."
      ],
      infoCard: {
        title: "Récapitulatif",
        rows: [
          { label: "Nom", value: "{{firstName}} {{lastName}}" },
          { label: "Email", value: "{{email}}" },
          { label: "Date", value: "{{eventDate}}" },
          { label: "Lieu", value: "{{eventVenue}}" }
        ]
      },
      cta: { label: "Retour à l'accueil", url: SITE },
      note: "Une question ? Répondez simplement à ce message — notre équipe reviendra vers vous sous 48 heures ouvrées."
    }
  },
  {
    key: "registration-company-received",
    category: "onboarding",
    label: "Inscription entreprise reçue",
    description:
      "Confirmation d'inscription pour une entreprise / organisation.",
    subject: "Inscription entreprise enregistrée · BIS 2026",
    eyebrow: "BIS 2026 · Inscription entreprise",
    content: {
      eyebrow: "BIS 2026 · Inscription entreprise",
      heading: "Votre inscription entreprise est reçue.",
      paragraphs: [
        "Bonjour {{firstName}}, nous avons bien reçu l'inscription de votre organisation au BIS 2026.",
        "Notre équipe reviendra vers vous rapidement pour préparer votre venue et vos accès."
      ],
      infoCard: {
        title: "Contact principal",
        rows: [
          { label: "Nom", value: "{{firstName}} {{lastName}}" },
          { label: "Email", value: "{{email}}" },
          { label: "Date", value: "{{eventDate}}" },
          { label: "Lieu", value: "{{eventVenue}}" }
        ]
      },
      note: "Nous répondons habituellement sous 48 heures ouvrées."
    }
  },

  /* ------------------------------ APPLICATIONS ------------------------------ */

  {
    key: "application-sponsor-received",
    category: "application",
    label: "Candidature sponsor reçue",
    description:
      "Accusé de réception d'une candidature sponsor. Ne promet pas d'acceptation.",
    subject: "Votre candidature sponsor est reçue · BIS 2026",
    eyebrow: "BIS 2026 · Candidature sponsor",
    content: {
      eyebrow: "BIS 2026 · Candidature sponsor",
      heading: "Merci pour votre intérêt.",
      paragraphs: [
        "Bonjour {{firstName}}, nous avons bien reçu la candidature sponsor de votre organisation pour le BIS 2026.",
        "Nos équipes vont étudier votre proposition et reviendront vers vous pour discuter des prochaines étapes."
      ],
      note: "Cette confirmation ne vaut pas engagement. Nous confirmerons formellement toute participation après l'étude de votre dossier."
    }
  },
  {
    key: "application-partner-received",
    category: "application",
    label: "Candidature partenaire reçue",
    description:
      "Accusé de réception d'une candidature partenaire. Ne promet pas d'acceptation.",
    subject: "Votre candidature partenaire est reçue · BIS 2026",
    eyebrow: "BIS 2026 · Candidature partenaire",
    content: {
      eyebrow: "BIS 2026 · Candidature partenaire",
      heading: "Merci pour votre proposition.",
      paragraphs: [
        "Bonjour {{firstName}}, nous avons bien reçu votre candidature partenaire pour le BIS 2026.",
        "Notre équipe partenariats examinera votre dossier et reviendra vers vous."
      ],
      note: "Cette confirmation ne vaut pas engagement. Toute collaboration sera validée après échange."
    }
  },
  {
    key: "application-speaker-received",
    category: "application",
    label: "Candidature intervenant reçue",
    description:
      "Accusé de réception d'une candidature intervenant. Sélection ultérieure.",
    subject: "Votre proposition d'intervention est reçue · BIS 2026",
    eyebrow: "BIS 2026 · Candidature intervenant",
    content: {
      eyebrow: "BIS 2026 · Candidature intervenant",
      heading: "Merci pour votre proposition.",
      paragraphs: [
        "Bonjour {{firstName}}, nous avons bien reçu votre proposition d'intervention pour le BIS 2026.",
        "Notre comité éditorial étudiera votre dossier. La sélection des intervenants sera communiquée dans les prochaines semaines."
      ],
      note: "Cette confirmation ne garantit pas la sélection. Nous reviendrons vers vous à l'issue de l'examen éditorial."
    }
  },
  {
    key: "application-creator-received",
    category: "application",
    label: "Candidature créateur reçue",
    description:
      "Accusé de réception d'une candidature créateur de contenu.",
    subject: "Votre candidature créateur est reçue · BIS 2026",
    eyebrow: "BIS 2026 · Candidature créateur",
    content: {
      eyebrow: "BIS 2026 · Candidature créateur",
      heading: "Merci pour votre candidature.",
      paragraphs: [
        "Bonjour {{firstName}}, nous avons bien reçu votre candidature créateur de contenu pour le BIS 2026.",
        "Nos équipes examineront votre profil et reviendront vers vous."
      ],
      note: "Cette confirmation n'implique pas d'engagement. Nous confirmerons toute collaboration après échange."
    }
  }
];

/**
 * Serialize the template body content back into plain text so it can be
 * shown in the composer's textarea (the admin edits the paragraphs).
 */
export function templateBodyToText(t: EmailTemplate): string {
  return t.content.paragraphs.join("\n\n");
}

/**
 * Compose an EmailContent for a given template, replacing its paragraphs
 * with the admin's edited text. Header/footer/infoCard/CTA/signature come
 * from the template so the shell stays branded even after edits.
 */
export function composeEmailContent({
  template,
  bodyText
}: {
  template?: EmailTemplate;
  bodyText: string;
}): EmailContent {
  const paragraphs = bodyText
    .split(/\n{2,}/) // blank line separates paragraphs
    .map((p) => p.replace(/^\s+|\s+$/g, ""))
    .filter((p) => p.length > 0);

  if (!template) {
    // Blank / custom — still get the BIS shell, but no info-card / CTA.
    return {
      eyebrow: "BIS 2026",
      paragraphs
    };
  }

  return {
    eyebrow: template.content.eyebrow,
    heading: template.content.heading,
    paragraphs,
    infoCard: template.content.infoCard,
    cta: template.content.cta,
    note: template.content.note,
    ticketBlock: template.content.ticketBlock
  };
}

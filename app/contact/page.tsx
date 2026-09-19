import { ContactHero } from "@/components/contact/contact-hero";
import {
  ContactSection,
  type ContactInfoItem
} from "@/components/contact/contact-section";
import { ContactFAQ } from "@/components/contact/contact-faq";
import { ContactCTA } from "@/components/contact/contact-cta";

export const metadata = {
  title: "Contact",
  description:
    "Contactez l'équipe du Algeria Brand Impact Summit 2026 et échangez autour de vos projets, collaborations et opportunités."
};

// Single source of truth for contact information — kept in sync with the
// footer values. Update here to change everywhere.
const contactConfig = {
  email: "contact@bis-algeria.dz",
  venue: "CIC Alger",
  venueLine2: "Centre International de Conférences",
  city: "Alger, Algérie",
  eventDate: "15 · 17 Novembre 2026",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=CIC+Alger"
} as const;

const infoItems: ContactInfoItem[] = [
  {
    index: "01",
    label: "Email",
    value: contactConfig.email,
    href: `mailto:${contactConfig.email}`
  },
  {
    index: "02",
    label: "Lieu",
    value: contactConfig.venue,
    hint: `${contactConfig.venueLine2} · ${contactConfig.city}`,
    href: contactConfig.mapUrl
  },
  {
    index: "03",
    label: "Événement",
    value: contactConfig.eventDate,
    hint: "Portes ouvertes · 09h00"
  }
];

export default function ContactPage() {
  return (
    <>
      <ContactHero />
      <ContactSection items={infoItems} />
      <ContactFAQ />
      <ContactCTA />
    </>
  );
}

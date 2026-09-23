import type { Metadata, Viewport } from "next";
import { Alexandria } from "next/font/google";
import "./globals.css";
import { SiteFrame } from "@/components/layout/site-frame";
import { eventInfo } from "@/lib/utils";
import { getCurrentAccount } from "@/lib/account/auth";

const alexandria = Alexandria({
  subsets: ["latin"],
  variable: "--font-alexandria",
  display: "swap",
  weight: ["300", "400", "500", "600", "700", "800", "900"]
});

export const metadata: Metadata = {
  metadataBase: new URL(eventInfo.siteUrl),
  title: {
    default: `${eventInfo.name} — BIS`,
    template: `%s · BIS 2027`
  },
  description: eventInfo.description,
  keywords: [
    "Algeria Brand Impact Summit",
    "BIS 2027",
    "BIS Algeria",
    "Sommet Alger",
    "GET+ Summit",
    "CIC Alger",
    "African impact summit",
    "Identity Growth Legacy",
    "Marque Algérie"
  ],
  authors: [{ name: "Axis Legacy" }],
  openGraph: {
    type: "website",
    locale: "fr_DZ",
    url: eventInfo.siteUrl,
    title: `${eventInfo.name} — BIS`,
    description: eventInfo.description,
    siteName: eventInfo.name
  },
  twitter: {
    card: "summary_large_image",
    title: `${eventInfo.name} — BIS`,
    description: eventInfo.description
  },
  robots: { index: true, follow: true }
};

export const viewport: Viewport = {
  themeColor: "#2453E0",
  width: "device-width",
  initialScale: 1
};

export default async function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const account = await getCurrentAccount();
  const navAccount = account
    ? {
        firstName: account.firstName,
        lastName: account.lastName,
        email: account.email
      }
    : null;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: eventInfo.name,
    startDate: eventInfo.dateISO,
    endDate: eventInfo.dateISO,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    location: {
      "@type": "Place",
      name: eventInfo.location,
      address: {
        "@type": "PostalAddress",
        addressLocality: "Alger",
        addressCountry: "DZ"
      }
    },
    description: eventInfo.description,
    organizer: { "@type": "Organization", name: "Axis Legacy" },
    url: eventInfo.siteUrl
  };

  return (
    <html lang="fr" className={alexandria.variable} suppressHydrationWarning>
      <body
        className="min-h-screen bg-white font-sans text-ink"
        suppressHydrationWarning
      >
        <SiteFrame account={navAccount}>{children}</SiteFrame>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}

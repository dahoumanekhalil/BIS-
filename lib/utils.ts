import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("fr-FR").format(n);
}

export const eventInfo = {
  name: "Algeria Brand Impact Summit 2027",
  shortName: "BIS 2027",
  brand: "B.I.S+",
  wordmark: "GET+",
  tagline: "Le sommet de l'impact africain",
  date: "3-5 Janvier 2027",
  dateISO: "2027-11-15",
  location: "CIC Alger",
  country: "Algérie",
  region: "BIS · Algeria",
  expectedAttendance: 12000,
  description:
    "Le sommet stratégique où les marques sont construites comme des actifs financiers, des outils de souveraineté et des vecteurs d'influence. Trois piliers : Identity, Growth, Legacy.",
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
};

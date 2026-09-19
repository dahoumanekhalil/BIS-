import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";
import { eventInfo } from "@/lib/utils";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = eventInfo.siteUrl;

  const staticRoutes: MetadataRoute.Sitemap = [
    "",
    "/programme",
    "/intervenants",
    "/espaces",
    "/inscription",
    "/contact"
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: path === "" ? 1 : 0.7
  }));

  let speakers: MetadataRoute.Sitemap = [];
  try {
    const list = await prisma.speaker.findMany({ select: { slug: true, updatedAt: true } });
    speakers = list.map((s) => ({
      url: `${base}/intervenants/${s.slug}`,
      lastModified: s.updatedAt,
      changeFrequency: "monthly",
      priority: 0.5
    }));
  } catch {
    speakers = [];
  }

  return [...staticRoutes, ...speakers];
}

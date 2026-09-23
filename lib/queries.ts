import { prisma } from "@/lib/db";
import { cache } from "react";

export const getEvent = cache(async () => {
  return prisma.event.findUnique({
    where: { slug: "getplus-summit-2027" }
  });
});

export const getHomepageStats = cache(async () => {
  const content = await prisma.siteContent.findUnique({
    where: { key: "homepage.stats" }
  });
  const fallback = { participants: 12000, speakers: 120, sessions: 80, countries: 45 };
  return (content?.value as typeof fallback) ?? fallback;
});

export const getHighlightedSessions = cache(async () => {
  return prisma.session.findMany({
    where: { isHighlighted: true },
    orderBy: [{ order: "asc" }, { startsAt: "asc" }],
    include: {
      speakers: { include: { speaker: true } },
      space: true
    },
    take: 4
  });
});

export const getAllSessions = cache(async () => {
  return prisma.session.findMany({
    orderBy: [{ startsAt: "asc" }],
    include: {
      speakers: { include: { speaker: true } },
      space: true
    }
  });
});

export const getHighlightedSpeakers = cache(async () => {
  return prisma.speaker.findMany({
    where: { isHighlighted: true },
    orderBy: [{ order: "asc" }, { fullName: "asc" }],
    take: 6
  });
});

export const getAllSpeakers = cache(async () => {
  return prisma.speaker.findMany({
    orderBy: [{ order: "asc" }, { fullName: "asc" }]
  });
});

export const getSpeakerBySlug = cache(async (slug: string) => {
  return prisma.speaker.findUnique({
    where: { slug },
    include: {
      sessions: {
        include: { session: { include: { space: true } } }
      }
    }
  });
});

export const getSpaces = cache(async () => {
  return prisma.space.findMany({
    orderBy: { order: "asc" }
  });
});

export const getPartners = cache(async () => {
  return prisma.partner.findMany({
    orderBy: [{ tier: "asc" }, { order: "asc" }]
  });
});

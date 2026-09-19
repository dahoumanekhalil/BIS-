import { Hero } from "@/components/hero";
import { EventStats } from "@/components/statistics";
import { AboutSummit } from "@/components/about-summit";
import { FeaturedSessions } from "@/components/sessions-section";
import { SpeakerGrid } from "@/components/speakers-section";
import { LegacySpaces } from "@/components/legacy-spaces";
import { Partners } from "@/components/partners-section";
import { FinalCTA } from "@/components/final-cta";
import {
  getHighlightedSessions,
  getHighlightedSpeakers,
  getPartners
} from "@/lib/queries";

export const revalidate = 300;

export default async function HomePage() {
  const [sessions, speakers, partners] = await Promise.all([
    getHighlightedSessions(),
    getHighlightedSpeakers(),
    getPartners()
  ]);

  return (
    <>
      <Hero />
      <EventStats />
      <AboutSummit />
      <FeaturedSessions sessions={sessions} />
      <SpeakerGrid speakers={speakers} />
      <LegacySpaces />
      <Partners partners={partners} />
      <FinalCTA />
    </>
  );
}

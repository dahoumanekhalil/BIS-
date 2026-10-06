// Pure display labels for session enums (safe to import from client code).

export const SESSION_TYPES = [
  "KEYNOTE",
  "TALK",
  "PANEL",
  "FIRESIDE",
  "WORKSHOP",
  "MASTERCLASS",
  "MASTERMIND",
  "PITCH",
  "SHOWCASE"
] as const;

export const SESSION_TYPE_LABEL: Record<string, string> = {
  KEYNOTE: "Keynote",
  TALK: "Conférence",
  PANEL: "Table ronde",
  FIRESIDE: "Fireside chat",
  WORKSHOP: "Atelier",
  MASTERCLASS: "Masterclass",
  MASTERMIND: "Mastermind",
  PITCH: "Pitch",
  SHOWCASE: "Showcase"
};

export const SESSION_CATEGORIES = [
  "INNOVATION",
  "ENTREPRENEURSHIP",
  "TECHNOLOGY",
  "IMPACT",
  "CULTURE",
  "INVESTMENT",
  "LEADERSHIP"
] as const;

export const SESSION_CATEGORY_LABEL: Record<string, string> = {
  INNOVATION: "Innovation",
  ENTREPRENEURSHIP: "Entrepreneuriat",
  TECHNOLOGY: "Technologie",
  IMPACT: "Impact",
  CULTURE: "Culture",
  INVESTMENT: "Investissement",
  LEADERSHIP: "Leadership"
};

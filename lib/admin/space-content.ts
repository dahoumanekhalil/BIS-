import "server-only";

import { z } from "zod";

// Phase 17 — validation schemas for the JSON payloads on AccessPoint:
// activities / topics / exhibitors. Kept server-side so a hostile
// client cannot inject an object shape that later blows up in a
// downstream renderer.
//
// Sizes are bounded (max 30 items per list, max 200 chars per field)
// because these are configuration surfaces, not free-form CMS.

const MAX_ITEMS = 30;

const trimmedShort = z
  .string()
  .trim()
  .min(1, "Champ requis")
  .max(120, "Maximum 120 caractères");

const trimmedLong = z
  .string()
  .trim()
  .max(400, "Maximum 400 caractères")
  .optional()
  .transform((s) => (s && s.length > 0 ? s : undefined));

const urlOpt = z
  .string()
  .trim()
  .max(200, "URL trop longue")
  .optional()
  .transform((s) => (s && s.length > 0 ? s : undefined))
  .refine(
    (s) => !s || /^https?:\/\//i.test(s),
    "L'URL doit commencer par http(s)://"
  );

export const activitySchema = z.object({
  title: trimmedShort,
  description: trimmedLong
});
export const activitiesSchema = z.array(activitySchema).max(MAX_ITEMS);

export const topicSchema = z.object({
  label: trimmedShort
});
export const topicsSchema = z.array(topicSchema).max(MAX_ITEMS);

export const exhibitorSchema = z.object({
  name: trimmedShort,
  description: trimmedLong,
  website: urlOpt
});
export const exhibitorsSchema = z.array(exhibitorSchema).max(MAX_ITEMS);

export type SpaceActivity = z.infer<typeof activitySchema>;
export type SpaceTopic = z.infer<typeof topicSchema>;
export type SpaceExhibitor = z.infer<typeof exhibitorSchema>;

// Read-side sanitiser — the DB `Json` column is `unknown` at compile
// time. Coerce it into the safe typed shape (or empty array) before
// handing it to the UI. Anything that doesn't parse becomes [] so a
// legacy or corrupt row cannot crash the space detail page.
export function readActivities(raw: unknown): SpaceActivity[] {
  const r = activitiesSchema.safeParse(raw ?? []);
  return r.success ? r.data : [];
}
export function readTopics(raw: unknown): SpaceTopic[] {
  const r = topicsSchema.safeParse(raw ?? []);
  return r.success ? r.data : [];
}
export function readExhibitors(raw: unknown): SpaceExhibitor[] {
  const r = exhibitorsSchema.safeParse(raw ?? []);
  return r.success ? r.data : [];
}

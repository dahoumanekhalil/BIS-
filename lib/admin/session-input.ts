// Pure input parsing for the admin "sessions" CRUD. No Prisma client / DB
// access here so it can be unit tested directly; the server actions do the
// DB work after this validates and normalises the raw form values.

import { z } from "zod";
import { SessionCategory, SessionType } from "@prisma/client";

// Event times are entered and displayed in the event's own time zone.
// Algeria is UTC+1 all year (no daylight saving), so a fixed offset is exact.
const EVENT_TZ = "Africa/Algiers";
const EVENT_UTC_OFFSET = "+01:00";
const LOCAL_INPUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Date → "YYYY-MM-DDTHH:mm" (value for <input type="datetime-local">). */
export function toEventLocalInput(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** "YYYY-MM-DDTHH:mm" in event time → Date, or null if not a real date. */
export function fromEventLocalInput(value: string): Date | null {
  if (!LOCAL_INPUT_RE.test(value)) return null;
  const d = new Date(`${value}:00${EVENT_UTC_OFFSET}`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject overflowing dates (e.g. 2026-02-31 silently rolling to March).
  return toEventLocalInput(d) === value ? d : null;
}

export function slugifyTitle(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} caractères`)
    .transform((v) => (v === "" ? null : v));

const schema = z.object({
  title: z.string().trim().min(1, "Titre requis").max(200, "Maximum 200 caractères"),
  summary: optionalText(2000),
  type: z.nativeEnum(SessionType, { message: "Type invalide" }),
  category: z.nativeEnum(SessionCategory, { message: "Catégorie invalide" }),
  startsAt: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const d = fromEventLocalInput(v);
      if (!d) {
        ctx.addIssue({ code: "custom", message: "Date et heure invalides" });
        return z.NEVER;
      }
      return d;
    }),
  durationMin: z.coerce
    .number({ message: "Durée invalide" })
    .int("Durée invalide")
    .min(5, "Minimum 5 minutes")
    .max(720, "Maximum 12 heures"),
  stage: optionalText(120),
  spaceId: optionalText(64),
  isHighlighted: z.boolean(),
  order: z.coerce
    .number({ message: "Ordre invalide" })
    .int("Ordre invalide")
    .min(0, "Minimum 0")
    .max(9999, "Maximum 9999"),
  speakerIds: z
    .array(z.string().trim().min(1).max(64))
    .max(30, "Maximum 30 intervenants")
    .transform((ids) => Array.from(new Set(ids)))
});

export type SessionInput = z.infer<typeof schema>;

export type SessionParseResult =
  | { ok: true; data: SessionInput }
  | { ok: false; fieldErrors: Record<string, string> };

export function parseSessionInput(raw: Record<string, unknown>): SessionParseResult {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
  }
  return { ok: false, fieldErrors };
}

/** Builds the raw object the schema expects from a submitted FormData. */
export function sessionRawFromFormData(formData: FormData): Record<string, unknown> {
  const str = (k: string) => String(formData.get(k) ?? "");
  return {
    title: str("title"),
    summary: str("summary"),
    type: str("type"),
    category: str("category"),
    startsAt: str("startsAt"),
    durationMin: str("durationMin"),
    stage: str("stage"),
    spaceId: str("spaceId"),
    isHighlighted: formData.get("isHighlighted") === "on",
    order: str("order") || "0",
    speakerIds: formData.getAll("speakerIds").map((v) => String(v))
  };
}

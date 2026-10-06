// The participant's offline badge, as stored on the device. Pure logic
// (no React Native imports): validation, expiry, and the owner check.
//
// Stored in the OS Keychain / Keystore (see store.ts). Version 2 differs from
// the website's PWA snapshot: instead of a QR IMAGE it keeps the raw QR token
// (43 chars) and the app DRAWS the QR itself — tiny, crisp, and it fits the
// secure store's value-size comfort zone.

export const SNAPSHOT_VERSION = 2;
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // hidden after 14 days
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // warn after 1 day

export type Snapshot = {
  v: 2;
  firstName: string;
  lastName: string;
  organization: string | null;
  jobTitle: string | null;
  roleLabel: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  participationLabel: string | null;
  statusLabel: string | null;
  checkinCode: string | null;
  token: string; // raw QR credential — treat as a secret, never log
  owner: string; // one-way tag of the account that saved it
  syncedAt: string; // set by the APP at save time, never trusted from the web
};

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const OWNER_RE = /^[a-f0-9]{24}$/;

function s(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

// Optional display line: bounded, no markup characters; invalid → null.
function line(v: unknown, max: number, re?: RegExp): string | null {
  const t = s(v, max);
  if (t === null || t === "") return null;
  if (/[<>]/.test(t)) return null;
  if (re && !re.test(t)) return null;
  return t;
}

export function validateSnapshot(raw: unknown): Snapshot | null {
  try {
    const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || o.v !== SNAPSHOT_VERSION) return null;
    const firstName = s(o.firstName, 80);
    const lastName = s(o.lastName, 80);
    const token = s(o.token, 64);
    const owner = s(o.owner, 40);
    const syncedAt = s(o.syncedAt, 40);
    if (!firstName || !lastName || !token || !owner || !syncedAt) return null;
    if (!TOKEN_RE.test(token) || !OWNER_RE.test(owner)) return null;
    const t = Date.parse(syncedAt);
    if (!Number.isFinite(t)) return null;
    const code = line(o.checkinCode, 32, /^[A-Z0-9-]+$/);
    return {
      v: 2,
      firstName,
      lastName,
      organization: line(o.organization, 120),
      jobTitle: line(o.jobTitle, 120),
      roleLabel: line(o.roleLabel, 40),
      email: line(o.email, 160, /^[^\s@]+@[^\s@]+$/),
      phone: line(o.phone, 32, /^[0-9+()\s.-]+$/),
      country: line(o.country, 60),
      participationLabel: line(o.participationLabel, 60),
      statusLabel: line(o.statusLabel, 60),
      checkinCode: code,
      token,
      owner,
      syncedAt: new Date(t).toISOString()
    };
  } catch {
    return null;
  }
}

// Build a snapshot from a message coming from the website. `syncedAt` is
// stamped HERE, so the web page cannot extend its own lifetime.
export function buildSnapshot(payload: unknown, now: Date = new Date()): Snapshot | null {
  if (!payload || typeof payload !== "object") return null;
  return validateSnapshot({ ...(payload as object), v: SNAPSHOT_VERSION, syncedAt: now.toISOString() });
}

// iOS Keychain items survive uninstall/reinstall. A snapshot that was saved
// BEFORE this installation therefore belongs to a previous install and must be
// discarded. (getInstallationTimeAsync is reset by a reinstall on both OSes.)
export function predatesInstall(snap: Snapshot, installTime: Date): boolean {
  return Date.parse(snap.syncedAt) < installTime.getTime() - 1000;
}

export type Freshness = { state: "none" | "fresh" | "stale" | "expired"; ageMs: number };

export function evaluate(snap: Snapshot | null, now: Date = new Date()): Freshness {
  if (!snap) return { state: "none", ageMs: 0 };
  let age = now.getTime() - Date.parse(snap.syncedAt);
  if (age < 0) age = 0; // clock moved backwards: treat as just synced
  if (age > MAX_AGE_MS) return { state: "expired", ageMs: age };
  if (age > STALE_AFTER_MS) return { state: "stale", ageMs: age };
  return { state: "fresh", ageMs: age };
}

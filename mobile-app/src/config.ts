// App configuration. Pure (no React Native imports) so it can be unit-tested.
//
// The app is a window onto the live website. The site address is NOT hard-coded
// in the logic: it comes from EXPO_PUBLIC_SITE_URL (inlined at build time) with
// the current production address as default. During the migration to the main
// domain both hosts stay trusted (EXPO_PUBLIC_ALLOWED_HOSTS), so switching the
// primary address is a one-line config change — and the old host keeps working.

const DEFAULT_SITE = "https://app.brandimpactsummit.org";
const DEFAULT_HOSTS = "app.brandimpactsummit.org,brandimpactsummit.org";

function cleanHost(h: string): string {
  return h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// Matches the RAW string (no trimming): whitespace, control characters or
// look-alike characters anywhere simply fail the pattern.
export function hostOf(url: string): string | null {
  const m = /^https:\/\/([^/?#:@\s\\]+)(?::443)?(?:[/?#][^\s\\]*)?$/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// Schemes a user may choose to open OUTSIDE the app (after a confirmation).
export function isExternalOpenable(url: string): boolean {
  return /^(https:\/\/[^\s\\]+|mailto:[^\s\\]+|tel:[+0-9()\s.-]+)$/i.test(url);
}

export function buildConfig(env: {
  EXPO_PUBLIC_SITE_URL?: string;
  EXPO_PUBLIC_ALLOWED_HOSTS?: string;
}) {
  const site = (env.EXPO_PUBLIC_SITE_URL || DEFAULT_SITE).trim().replace(/\/+$/, "");
  const siteHost = hostOf(site);
  if (!siteHost) {
    throw new Error("EXPO_PUBLIC_SITE_URL must be an https:// origin");
  }
  const hosts = new Set(
    (env.EXPO_PUBLIC_ALLOWED_HOSTS || DEFAULT_HOSTS)
      .split(",")
      .map(cleanHost)
      .filter(Boolean)
  );
  hosts.add(siteHost);
  return { siteUrl: site, allowedHosts: [...hosts] };
}

const cfg = buildConfig({
  EXPO_PUBLIC_SITE_URL: process.env.EXPO_PUBLIC_SITE_URL,
  EXPO_PUBLIC_ALLOWED_HOSTS: process.env.EXPO_PUBLIC_ALLOWED_HOSTS
});

// ── Two apps, one codebase ───────────────────────────────────────────────
//   public → participants: the whole public site + account + offline badge.
//            /admin is BLOCKED (also refused by the server for this app).
//   staff  → event team: ONLY the admin console (online only), with the
//            camera for the badge scanner. No participant area, no offline badge.
// Chosen at build time by EXPO_PUBLIC_BIS_VARIANT (see app.config.ts / eas.json).
export type Variant = "public" | "staff";
export function resolveVariant(v: string | undefined): Variant {
  return v === "staff" ? "staff" : "public";
}
export const VARIANT: Variant = resolveVariant(process.env.EXPO_PUBLIC_BIS_VARIANT);

export const SITE_URL = cfg.siteUrl;
export const ALLOWED_HOSTS = cfg.allowedHosts;
// Sent in the User-Agent. The site treats "BISApp/" as the public app (and
// hands it the owner's own badge token) and refuses it on /admin. The staff
// app uses a DIFFERENT marker so it never receives a participant token.
export const APP_UA = VARIANT === "staff" ? "BISStaff/1.0" : "BISApp/1.0";
export const START_URL = VARIANT === "staff" ? SITE_URL + "/admin" : SITE_URL;

// Path of an https URL, only if it is in a canonical form (no dot segments,
// no encoded dots or slashes, no backslashes, no double slashes).
export function pathOf(url: string): string | null {
  const m = /^https:\/\/[^/?#\s\\]+(?::443)?(\/[^?#\s\\]*)?(?:[?#][^\s\\]*)?$/i.exec(url);
  if (!m) return null;
  const p = m[1] ?? "/";
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\/\//i.test(p)) return null;
  // Percent-encoded unreserved characters (e.g. /%61dmin) are a non-canonical
  // spelling: refuse them so the admin check can never be dodged by encoding.
  for (const m of p.matchAll(/%([0-9a-f]{2})/gi)) {
    if (/[A-Za-z0-9-._~]/.test(String.fromCharCode(parseInt(m[1], 16)))) return null;
  }
  return p;
}

const isAdminPath = (p: string) => /^\/admin(\/|$)/i.test(p);

// The single navigation policy of each app (host AND path).
export function isAllowedNavigation(
  url: string,
  variant: Variant = VARIANT,
  hosts: readonly string[] = ALLOWED_HOSTS
): boolean {
  if (!isAllowedUrl(url, hosts)) return false;
  const p = pathOf(url);
  if (p === null) return false;
  return variant === "staff" ? isAdminPath(p) : !isAdminPath(p);
}

// HTTPS only, and only for the site's own hosts.
export function isAllowedUrl(url: string, hosts: readonly string[] = ALLOWED_HOSTS): boolean {
  const h = hostOf(url);
  return h !== null && hosts.includes(h);
}

// Release gate for the Expo app. Fails (exit 1) when something unsafe or
// unfinished would ship. CI runs it before every store build.
//   EXPO_PUBLIC_SITE_URL=https://brandimpactsummit.org node scripts/check-release.mjs
//
// It checks what is REALLY built: the resolved Expo config (`expo config`),
// every EAS profile's environment, and the host allow-list.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (m) => errors.push(m);

const DEFAULT_SITE = "https://app.brandimpactsummit.org";
const PINNED_HOSTS = ["app.brandimpactsummit.org", "brandimpactsummit.org"];

function checkSite(site, label) {
  try {
    const u = new URL(site);
    if (u.protocol !== "https:") fail(`${label}: must be https://`);
    if (u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) {
      fail(`${label}: must be a bare origin (no credentials/path/query/fragment)`);
    }
    const h = u.hostname;
    if (/^[0-9.]+$/.test(h) || h.includes(":") || !h.includes(".")) fail(`${label}: host must be a DNS name`);
    if (/(^|\.)(example|test|invalid|localhost)(\.|$)/.test(h)) fail(`${label}: host is a placeholder`);
    if (u.port && u.port !== "443") fail(`${label}: default HTTPS port only`);
    if (!PINNED_HOSTS.includes(h.toLowerCase())) {
      fail(`${label}: host ${h} is not one of the pinned hosts (${PINNED_HOSTS.join(", ")}) — update PINNED_HOSTS deliberately`);
    }
  } catch {
    fail(`${label}: not a valid URL`);
  }
}

const site = (process.env.EXPO_PUBLIC_SITE_URL ?? DEFAULT_SITE).trim().replace(/\/+$/, "");
checkSite(site, "EXPO_PUBLIC_SITE_URL");

// The allow-list can only be the pinned hosts (no widening through an EAS env var).
const extra = (process.env.EXPO_PUBLIC_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
for (const h of extra) if (!PINNED_HOSTS.includes(h)) fail(`EXPO_PUBLIC_ALLOWED_HOSTS contains unpinned host: ${h}`);

// Two apps, one codebase. Each variant has ONE permanent store id.
const APP_IDS = { public: "org.brandimpactsummit.app", staff: "org.brandimpactsummit.staff" };
for (const [v, id] of Object.entries(APP_IDS)) {
  if (!/^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*){2,}$/i.test(id)) fail(v + " app id is not a valid reverse-DNS id");
}
if (APP_IDS.public === APP_IDS.staff) fail("public and staff apps must have different ids");

// Every EAS profile must build against a valid site, must not widen hosts and
// must declare its variant with the matching app id.
const eas = JSON.parse(await readFile(join(root, "eas.json"), "utf8"));
for (const [name, profile] of Object.entries(eas.build ?? {})) {
  const env = profile.env ?? {};
  // A profile's env WINS over the EAS dashboard variables, so every profile must
  // pin all values; otherwise a dashboard variable could widen the host list,
  // flip the variant or change the app id without this gate noticing.
  for (const k of ["EXPO_PUBLIC_SITE_URL", "EXPO_PUBLIC_ALLOWED_HOSTS", "BIS_APP_ID", "EXPO_PUBLIC_BIS_VARIANT"]) {
    if (!env[k]) fail(`eas.json build.${name}: env.${k} must be pinned in the profile`);
  }
  const v = env.EXPO_PUBLIC_BIS_VARIANT;
  if (v && !APP_IDS[v]) fail(`eas.json build.${name}: unknown variant ${v}`);
  if (v && env.BIS_APP_ID !== APP_IDS[v]) fail(`eas.json build.${name}: BIS_APP_ID does not match the ${v} app id`);
  if (name.startsWith("staff-") !== (v === "staff")) fail(`eas.json build.${name}: profile name and variant disagree`);
  if (env.EXPO_PUBLIC_SITE_URL) checkSite(env.EXPO_PUBLIC_SITE_URL, `eas.json build.${name}`);
  if (env.EXPO_PUBLIC_ALLOWED_HOSTS) {
    for (const h of env.EXPO_PUBLIC_ALLOWED_HOSTS.split(",").map((x) => x.trim().toLowerCase())) {
      if (!PINNED_HOSTS.includes(h)) fail(`eas.json build.${name}: unpinned host ${h}`);
    }
  }
}

// Resolved config = what the binaries will actually contain, per variant.
const ALLOWED_PERMS = {
  public: ["android.permission.USE_BIOMETRIC", "android.permission.USE_FINGERPRINT"],
  staff: ["CAMERA", "android.permission.CAMERA"]
};
for (const [variant, appId] of Object.entries(APP_IDS)) {
  let cfg;
  try {
    // Run the Expo CLI with the current node (no shell, works on Windows too).
    const expoCli = createRequire(join(root, "package.json")).resolve("expo/bin/cli");
    const out = execFileSync(process.execPath, [expoCli, "config", "--json", "--type", "public"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EXPO_PUBLIC_SITE_URL: site, BIS_APP_ID: appId, EXPO_PUBLIC_BIS_VARIANT: variant }
    });
    cfg = JSON.parse(out.slice(out.indexOf("{")));
  } catch {
    fail(variant + ": could not resolve the Expo config (npx expo config)");
  }
  if (!cfg) continue;
  const a = cfg.android ?? {};
  const i = cfg.ios ?? {};
  const L = variant + ": ";
  if (a.allowBackup !== false) fail(L + "android.allowBackup must be false");
  for (const p of a.permissions ?? []) {
    if (!ALLOWED_PERMS[variant].includes(p)) fail(L + "android.permissions contains an unexpected permission: " + p);
  }
  const hasCam = (a.permissions ?? []).some((p) => /CAMERA$/.test(p));
  if (variant === "staff" && !hasCam) fail(L + "staff app needs the CAMERA permission (scanner)");
  if (variant === "public" && (hasCam || i.infoPlist?.NSCameraUsageDescription)) fail(L + "public app must not declare the camera");
  const extraBlocked = variant === "staff" ? ["USE_BIOMETRIC", "USE_FINGERPRINT"] : ["CAMERA"];
  for (const p of ["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "SYSTEM_ALERT_WINDOW", ...extraBlocked]) {
    if (!(a.blockedPermissions ?? []).includes("android.permission." + p)) fail(L + "android.blockedPermissions missing " + p);
  }
  if (a.package !== appId || i.bundleIdentifier !== appId) fail(L + "package / bundleIdentifier differ from the app id");
  if (cfg.slug !== (variant === "staff" ? "bis-2027-staff" : "bis-2027")) fail(L + "unexpected slug " + cfg.slug);
  if (i.infoPlist?.ITSAppUsesNonExemptEncryption !== false) fail(L + "ios ITSAppUsesNonExemptEncryption must be false");
  const bound = i.infoPlist?.WKAppBoundDomains ?? [];
  if (!bound.includes(new URL(site).host)) fail(L + "ios WKAppBoundDomains must include the site host");
  for (const h of bound) if (!PINNED_HOSTS.includes(h)) fail(L + "ios WKAppBoundDomains has unpinned host " + h);
  if (cfg.scheme) fail(L + "no deep-link scheme should be registered (it is not handled)");
}

const store = await readFile(join(root, "src/store.ts"), "utf8");
if (!store.includes("WHEN_UNLOCKED_THIS_DEVICE_ONLY")) fail("secure store must be device-only");

if (errors.length) {
  console.error("MOBILE RELEASE GATE: FAILED");
  for (const e of errors) console.error(" ✗", e);
  process.exit(1);
}
console.log("MOBILE RELEASE GATE: OK  (" + site + "; public + staff)");

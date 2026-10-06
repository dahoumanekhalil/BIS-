// Release gate for the native projects. Fails (exit 1) when anything unsafe or
// unfinished would ship. Run by CI before every store build; run it locally
// after `cap sync`.
//
//   BIS_APP_URL=https://bis2027.dz BIS_APP_ID=dz.bis2027.summit node scripts/check-config.mjs
//
// Checks:
//   • BIS_APP_URL is a real https origin (not a placeholder / localhost / IP)
//   • BIS_APP_ID looks like a reverse-DNS id and is not the template default
//     when BIS_RELEASE=1 (the id is permanent once published)
//   • generated Android/iOS configs point at that URL (no stale placeholder)
//   • Android: allowBackup=false, cleartext off, debugging off
//   • iOS: WKAppBoundDomains matches the host, camera text present
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (m) => errors.push(m);

const url = (process.env.BIS_APP_URL ?? "").trim().replace(/\/+$/, "");
const appId = process.env.BIS_APP_ID ?? "";
const release = process.env.BIS_RELEASE === "1";

let host = "";
try {
  const u = new URL(url);
  host = u.host;
  if (u.protocol !== "https:") fail("BIS_APP_URL must be https://");
  if (u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) {
    fail("BIS_APP_URL must be a bare origin (no credentials, path, query or fragment)");
  }
  const h = u.hostname;
  const isIp = /^[0-9.]+$/.test(h) || h.includes(":") || h.startsWith("[");
  if (isIp) fail("BIS_APP_URL must be a DNS hostname, not an IP address");
  if (!h.includes(".")) fail("BIS_APP_URL must be a fully-qualified hostname");
  if (u.port && u.port !== "443") fail("BIS_APP_URL must use the default HTTPS port");
  if (/(^|\.)(example|test|invalid|localhost)(\.|$)/.test(u.hostname)) fail("BIS_APP_URL is still a placeholder");
} catch {
  fail("BIS_APP_URL is missing or not a URL");
}

if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(appId)) {
  fail("BIS_APP_ID must be a reverse-DNS id like dz.bis2027.summit");
}
if (release && appId === "dz.bis2027.summit") {
  fail("BIS_APP_ID is still the template default — decide the permanent id (cannot change after publishing)");
}

const droid = join(root, "android/app/src/main/assets/capacitor.config.json");
if (existsSync(droid)) {
  const c = JSON.parse(await readFile(droid, "utf8"));
  if (c.server?.url !== url) fail("android capacitor.config.json server.url does not match BIS_APP_URL — run cap sync");
  if (c.server?.cleartext) fail("android cleartext is enabled");
  if (c.android?.webContentsDebuggingEnabled) fail("android WebView debugging is enabled");
  if (c.appId !== appId) fail("android appId does not match BIS_APP_ID — run cap sync");
} else fail("android project not synced (run npm run cap:sync)");

const manifest = join(root, "android/app/src/main/AndroidManifest.xml");
if (existsSync(manifest)) {
  const m = await readFile(manifest, "utf8");
  if (!/android:allowBackup="false"/.test(m)) fail("AndroidManifest allowBackup is not false");
  if (!/android:usesCleartextTraffic="false"/.test(m)) fail("AndroidManifest cleartext is not disabled");
}

const pbx = join(root, "ios/App/App.xcodeproj/project.pbxproj");
if (existsSync(pbx)) {
  const x = await readFile(pbx, "utf8");
  if (!x.includes("PRODUCT_BUNDLE_IDENTIFIER = " + appId + ";")) {
    fail("iOS bundle identifier does not match BIS_APP_ID — run cap sync / re-create the project");
  }
} else fail("ios project missing");

const plist = join(root, "ios/App/App/Info.plist");
if (!existsSync(plist)) fail("ios Info.plist missing");
if (existsSync(plist)) {
  const p = await readFile(plist, "utf8");
  if (!new RegExp(`<key>WKAppBoundDomains</key>\\s*<array>\\s*<string>${host.replace(/\./g, "\\.")}</string>`).test(p)) {
    fail("Info.plist WKAppBoundDomains does not match the site host — run scripts/harden-native.mjs");
  }
  if (!/NSCameraUsageDescription/.test(p)) fail("Info.plist missing NSCameraUsageDescription");
  if (/NSAllowsArbitraryLoads\s*<\/key>\s*<true\/>/.test(p)) fail("Info.plist disables App Transport Security");
}

if (errors.length) {
  console.error("MOBILE RELEASE GATE: FAILED");
  for (const e of errors) console.error(" ✗", e);
  process.exit(1);
}
console.log("MOBILE RELEASE GATE: OK  (" + host + ", " + appId + ")");

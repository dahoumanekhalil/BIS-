// Tests for the Expo app's PURE logic (no React Native needed):
// config / host allow-list, snapshot validation + expiry, and the WebView
// bridge (what the website may ask the app to do).
//   npm run test:mobile-app

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildConfig, hostOf, isAllowedNavigation, isAllowedUrl, isExternalOpenable, pathOf, resolveVariant } from "../mobile-app/src/config";
import {
  MAX_AGE_MS,
  buildSnapshot,
  evaluate,
  predatesInstall,
  validateSnapshot
} from "../mobile-app/src/snapshot";
import { handleBridgeMessage, loadSnapshot, type SnapshotStore } from "../mobile-app/src/bridge";

const TOKEN = "A".repeat(43);
const OWNER = "0123456789abcdef01234567";
const payload = {
  firstName: "Amine",
  lastName: "Benali",
  organization: "Axis",
  jobTitle: "CTO",
  roleLabel: "Visiteur",
  email: "amine@axis.dz",
  phone: "+213 555 00 11 22",
  country: "Algérie",
  participationLabel: "Participant / Visiteur",
  statusLabel: "Inscription confirmée",
  checkinCode: "K4MX-92QT-A7RN",
  token: TOKEN,
  owner: OWNER
};
const NONCE = "6f1c2f1e-9b7a-4a0e-9c1e-0123456789ab";
const HOSTS = ["app.brandimpactsummit.org", "brandimpactsummit.org"];
const PAGE = "https://app.brandimpactsummit.org/compte/badge";

function fakeStore(): SnapshotStore & { value: string | null } {
  const st = {
    value: null as string | null,
    async get() { return st.value; },
    async set(v: string) { st.value = v; },
    async remove() { st.value = null; }
  };
  return st;
}

describe("config / host allow-list", () => {
  test("defaults trust BOTH the current and the future main domain", () => {
    const c = buildConfig({});
    assert.equal(c.siteUrl, "https://app.brandimpactsummit.org");
    assert.ok(c.allowedHosts.includes("app.brandimpactsummit.org"));
    assert.ok(c.allowedHosts.includes("brandimpactsummit.org"));
  });

  test("switching the primary address is a config change and keeps the old host", () => {
    const c = buildConfig({ EXPO_PUBLIC_SITE_URL: "https://brandimpactsummit.org/" });
    assert.equal(c.siteUrl, "https://brandimpactsummit.org");
    assert.ok(c.allowedHosts.includes("app.brandimpactsummit.org"));
  });

  test("the site URL must be https", () => {
    assert.throws(() => buildConfig({ EXPO_PUBLIC_SITE_URL: "http://brandimpactsummit.org" }));
    assert.throws(() => buildConfig({ EXPO_PUBLIC_SITE_URL: "javascript:alert(1)" }));
  });

  test("isAllowedUrl: https + exact host only (no look-alikes, no credentials, no ports)", () => {
    assert.equal(isAllowedUrl("https://brandimpactsummit.org/a?b=1#c", HOSTS), true);
    assert.equal(isAllowedUrl("https://app.brandimpactsummit.org", HOSTS), true);
    for (const bad of [
      "http://brandimpactsummit.org/",
      "https://evil.com/",
      "https://brandimpactsummit.org.evil.com/",
      "https://evilbrandimpactsummit.org/",
      "https://brandimpactsummit.org@evil.com/",
      "https://evil.com/?https://brandimpactsummit.org/",
      "https://brandimpactsummit.org:8443/",
      "javascript:alert(1)",
      "data:text/html,x",
      ""
    ]) {
      assert.equal(isAllowedUrl(bad, HOSTS), false, bad);
    }
    assert.equal(hostOf("https://BrandImpactSummit.org/"), "brandimpactsummit.org");
  });
});

describe("snapshot validation", () => {
  test("accepts a good payload and stamps the sync time itself", () => {
    const now = new Date("2027-01-03T10:00:00Z");
    const s = buildSnapshot({ ...payload, syncedAt: "2099-01-01T00:00:00Z" }, now);
    assert.ok(s);
    assert.equal(s!.syncedAt, now.toISOString(), "the web page cannot choose its own timestamp");
  });

  test("rejects bad tokens, owners and names", () => {
    for (const bad of [
      { ...payload, token: "short" },
      { ...payload, token: "A".repeat(44) },
      { ...payload, token: "A".repeat(42) + "!" },
      { ...payload, owner: "NOT-HEX" },
      { ...payload, owner: undefined },
      { ...payload, firstName: "" },
      { ...payload, lastName: "x".repeat(81) }
    ]) {
      assert.equal(buildSnapshot(bad), null, JSON.stringify(bad).slice(0, 60));
    }
    for (const junk of [null, undefined, 5, "x", [], {}]) assert.equal(buildSnapshot(junk), null);
  });

  test("optional profile lines with markup become null and never invalidate the badge", () => {
    const s = buildSnapshot({ ...payload, email: "<b>x</b>@a.b", phone: "call!", statusLabel: "<i>", country: "x".repeat(61) });
    assert.ok(s);
    assert.equal(s!.email, null);
    assert.equal(s!.phone, null);
    assert.equal(s!.statusLabel, null);
    assert.equal(s!.country, null);
  });

  test("freshness: fresh → stale (1 day) → expired (14 days, hidden)", () => {
    const t0 = new Date("2027-01-03T10:00:00Z");
    const s = buildSnapshot(payload, t0)!;
    const at = (ms: number) => evaluate(s, new Date(t0.getTime() + ms)).state;
    assert.equal(at(1000), "fresh");
    assert.equal(at(25 * 3600e3), "stale");
    assert.equal(at(MAX_AGE_MS - 1), "stale");
    assert.equal(at(MAX_AGE_MS + 1), "expired");
    assert.equal(evaluate(null).state, "none");
    assert.equal(evaluate(s, new Date(t0.getTime() - 86400e3)).state, "fresh", "clock going backwards is safe");
  });

  test("a stored value that is not version 2 / is tampered is rejected", () => {
    assert.equal(validateSnapshot({ ...payload, v: 1, syncedAt: new Date().toISOString() }), null);
    assert.equal(validateSnapshot("{not json"), null);
  });
});

describe("bridge — what the website may ask the app to do", () => {
  const save = (p: unknown = payload, nonce: unknown = NONCE) =>
    JSON.stringify({ type: "bis.snapshot.save", payload: p, nonce });
  const run = (raw: unknown, url: string, st: SnapshotStore, nonce = NONCE) =>
    handleBridgeMessage(raw, url, st, nonce, HOSTS);

  test("save from an allowed page is stored (re-validated, stamped)", async () => {
    const st = fakeStore();
    assert.equal(await run(save(), PAGE, st), "saved");
    const snap = await loadSnapshot(st);
    assert.equal(snap?.firstName, "Amine");
    assert.equal(snap?.token, TOKEN);
  });

  test("messages from any other origin are rejected, nothing is stored", async () => {
    for (const url of [
      "https://evil.com/compte/badge",
      "http://app.brandimpactsummit.org/",
      "https://app.brandimpactsummit.org.evil.com/",
      "about:blank",
      ""
    ]) {
      const st = fakeStore();
      assert.equal(await run(save(), url, st), "rejected", url);
      assert.equal(st.value, null);
    }
  });

  test("oversized, non-string, malformed and unknown messages are refused or ignored", async () => {
    const st = fakeStore();
    assert.equal(await run("x".repeat(20_000), PAGE, st), "rejected");
    assert.equal(await run({ a: 1 }, PAGE, st), "rejected");
    assert.equal(await run("{oops", PAGE, st), "rejected");
    assert.equal(await run(JSON.stringify({ type: "rm -rf", nonce: NONCE }), PAGE, st), "ignored");
    assert.equal(await run(save({ ...payload, token: "bad" }), PAGE, st), "rejected");
    assert.equal(st.value, null);
  });

  test("clearUnlessOwner: keeps the owner's badge; wipes another account's, ownerless and signed-out", async () => {
    const st = fakeStore();
    await run(save(), PAGE, st);
    const msg = (owner: string | null) =>
      JSON.stringify({ type: "bis.snapshot.clearUnlessOwner", owner, nonce: NONCE });
    assert.equal(await run(msg(OWNER), PAGE, st), "kept");
    assert.ok(st.value);
    assert.equal(await run(msg("ffffffffffffffffffffffff"), PAGE, st), "cleared");
    assert.equal(st.value, null);
    await run(save(), PAGE, st);
    assert.equal(await run(msg(null), PAGE, st), "cleared", "signed out → wipe");
    assert.equal(st.value, null);
  });

  test("explicit clear (logout) wipes; a corrupted stored value is removed on read", async () => {
    const st = fakeStore();
    await run(save(), PAGE, st);
    assert.equal(await run(JSON.stringify({ type: "bis.snapshot.clear", nonce: NONCE }), PAGE, st), "cleared");
    assert.equal(st.value, null);
    st.value = '{"v":2,"firstName":"<img onerror=x>","token":"nope"}';
    assert.equal(await loadSnapshot(st), null);
    assert.equal(st.value, null, "tampered value removed");
  });
});

describe("app source — static safety", () => {
  const read = (p: string) => readFile(new URL(`../mobile-app/${p}`, import.meta.url), "utf8");

  test("WebView is locked down", async () => {
    const w = await read("src/SiteWebView.tsx");
    for (const needle of [
      "mixedContentMode=\"never\"",
      "allowFileAccess={false}",
      "setSupportMultipleWindows={false}",
      "thirdPartyCookiesEnabled={false}",
      "onShouldStartLoadWithRequest",
      "limitsNavigationsToAppBoundDomains",
      "applicationNameForUserAgent"
    ]) assert.ok(w.includes(needle), needle);
    assert.equal(/dangerouslySetInnerHTML|eval\(|new Function/.test(w), false);
  });

  test("secure storage is device-only and never logged", async () => {
    const st = await read("src/store.ts");
    assert.ok(st.includes("WHEN_UNLOCKED_THIS_DEVICE_ONLY"));
    for (const f of ["src/store.ts", "src/bridge.ts", "src/OfflineScreen.tsx", "src/SiteWebView.tsx", "App.tsx"]) {
      assert.equal(/console\.(log|info|warn|error|debug)/.test(await read(f)), false, f + " must not log");
    }
  });

  test("config disables backups, asks only for the camera, no analytics SDKs", async () => {
    const c = await read("app.config.ts");
    assert.ok(c.includes("allowBackup: false"));
    assert.ok(c.includes('permissions: IS_STAFF ? ["CAMERA"] : []'));
    const pkg = JSON.parse(await read("package.json"));
    const deps = Object.keys({ ...pkg.dependencies });
    for (const bad of ["firebase", "analytics", "sentry", "segment", "amplitude", "facebook", "appsflyer"]) {
      assert.equal(deps.some((d) => d.includes(bad)), false, bad);
    }
  });
});

describe("review fixes — nonce, URL parsing, reinstall, external links", () => {
  const PAGE2 = "https://app.brandimpactsummit.org/compte/badge";

  test("bridge: wrong, missing or short nonce is rejected and changes nothing", async () => {
    for (const n of [undefined, null, "", "short", NONCE.slice(1), NONCE + "x", 12345, {}]) {
      const st = fakeStore();
      const raw = JSON.stringify({ type: "bis.snapshot.save", payload, nonce: n });
      assert.equal(await handleBridgeMessage(raw, PAGE2, st, NONCE, HOSTS), "rejected", String(n));
      assert.equal(st.value, null);
    }
    // a wiped-state message without the nonce must not clear either
    const st = fakeStore();
    await handleBridgeMessage(JSON.stringify({ type: "bis.snapshot.save", payload, nonce: NONCE }), PAGE2, st, NONCE, HOSTS);
    assert.equal(
      await handleBridgeMessage('{"type":"bis.snapshot.clear"}', PAGE2, st, NONCE, HOSTS),
      "rejected"
    );
    assert.ok(st.value);
  });

  test("hostOf matches the RAW string: whitespace / NBSP / control chars / backslashes never pass", () => {
    for (const bad of [
      " https://brandimpactsummit.org/",
      "https://brandimpactsummit.org/ ",
      "https://brandimpactsummit.org/\u00a0",
      "\u00a0https://brandimpactsummit.org/",
      "https://brandimpactsummit.org\\@evil.com/",
      "https://brandimpactsummit.org/\npath",
      "https://brandimpactsummit.org\t/",
      "https://brandimpactsummit.org./",
      "https://brandimpactsummit.org\u200b/"
    ]) {
      assert.equal(isAllowedUrl(bad, HOSTS), false, JSON.stringify(bad));
    }
    assert.equal(isAllowedUrl("https://brandimpactsummit.org", HOSTS), true);
    assert.equal(isAllowedUrl("https://app.brandimpactsummit.org:443/x?y=1#z", HOSTS), true);
  });

  test("external links: only https / mailto / tel can even be offered to the user", () => {
    for (const ok of ["https://example.org/a?b=1", "mailto:contact@bis-algeria.dz", "tel:+213555001122"]) {
      assert.equal(isExternalOpenable(ok), true, ok);
    }
    for (const bad of [
      "intent://scan/#Intent;scheme=zxing;end",
      "market://details?id=x",
      "sms:+213555?body=hi",
      "bis2027://anything",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "http://example.org/",
      "https://example.org/a b",
      "tel:abc"
    ]) {
      assert.equal(isExternalOpenable(bad), false, bad);
    }
  });

  test("a snapshot saved before this installation is discarded (iOS Keychain survives reinstall)", () => {
    const saved = buildSnapshot(payload, new Date("2027-01-03T10:00:00Z"))!;
    assert.equal(predatesInstall(saved, new Date("2027-01-04T00:00:00Z")), true);
    assert.equal(predatesInstall(saved, new Date("2027-01-03T09:00:00Z")), false);
  });

  test("eas.json pins site, host list and app id in EVERY profile (dashboard variables cannot override)", async () => {
    const eas = JSON.parse(await readFile(new URL("../mobile-app/eas.json", import.meta.url), "utf8"));
    for (const [name, p] of Object.entries<any>(eas.build)) {
      assert.equal(p.env.EXPO_PUBLIC_SITE_URL, "https://app.brandimpactsummit.org", name);
      assert.equal(p.env.EXPO_PUBLIC_ALLOWED_HOSTS, "app.brandimpactsummit.org,brandimpactsummit.org", name);
      const staff = name.startsWith("staff-");
      assert.equal(p.env.EXPO_PUBLIC_BIS_VARIANT, staff ? "staff" : "public", name);
      assert.equal(p.env.BIS_APP_ID, staff ? "org.brandimpactsummit.staff" : "org.brandimpactsummit.app", name);
    }
    assert.ok(eas.build["staff-preview"] && eas.build["staff-production"]);
  });

  test("variants: the public app can never navigate to /admin, the staff app only to /admin", () => {
    const H = ["app.brandimpactsummit.org", "brandimpactsummit.org"];
    const B = "https://app.brandimpactsummit.org";
    assert.equal(resolveVariant(undefined), "public");
    assert.equal(resolveVariant("nonsense"), "public");
    assert.equal(resolveVariant("staff"), "staff");
    for (const u of [B + "/", B + "/compte/badge", B + "/evenement?x=/admin"]) {
      assert.equal(isAllowedNavigation(u, "public", H), true, u);
      assert.equal(isAllowedNavigation(u, "staff", H), false, u);
    }
    for (const u of [B + "/admin", B + "/admin/",B + "/admin/scanner", B + "/ADMIN/x", B + "/admin?a=1", B + "/admin#x"]) {
      assert.equal(isAllowedNavigation(u, "public", H), false, u);
      assert.equal(isAllowedNavigation(u, "staff", H), true, u);
    }
    // Tricks must fail closed in BOTH apps.
    for (const u of [
      B + "/x/../admin", B + "/%2e%2e/admin", B + "/%2E%2E/admin", B + "//admin",
      B + "/a%2fadmin", B + "/a%5cadmin", B + "/%61dmin", B + "/%41DMIN/x", B + "/\\admin", B + "/admin/../compte"
    ]) {
      assert.equal(pathOf(u), null, u);
      assert.equal(isAllowedNavigation(u, "public", H), false, u);
      assert.equal(isAllowedNavigation(u, "staff", H), false, u);
    }
    // /administrator is NOT the admin console.
    assert.equal(isAllowedNavigation(B + "/administrator", "public", H), true);
    assert.equal(isAllowedNavigation(B + "/administrator", "staff", H), false);
    // Host rules still apply.
    assert.equal(isAllowedNavigation("https://evil.example/admin", "staff", H), false);
  });

  test("variants: staff UA never contains BISApp/ (no participant token); middleware refuses BISApp on /admin", async () => {
    const cfg = await readFile(new URL("../mobile-app/src/config.ts", import.meta.url), "utf8");
    assert.ok(cfg.includes('"BISStaff/1.0"') && cfg.includes('"BISApp/1.0"'));
    assert.equal("BISStaff/1.0".includes("BISApp/"), false);
    const mw = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
    assert.ok(mw.includes('includes("BISApp/")') && mw.includes("status: 403"));
    const rc = await readFile(new URL("../mobile-app/app.config.ts", import.meta.url), "utf8");
    assert.ok(rc.includes('permissions: IS_STAFF ? ["CAMERA"] : []'));
    const wv = await readFile(new URL("../mobile-app/src/SiteWebView.tsx", import.meta.url), "utf8");
    assert.ok(wv.includes('VARIANT === "staff"') && wv.includes('"deny"'));
  });

  test("source: re-lock only on background (no Face ID loop); dialog shows the real host", async () => {
    const o = await readFile(new URL("../mobile-app/src/OfflineScreen.tsx", import.meta.url), "utf8");
    assert.ok(o.includes('state === "background"') && !o.includes('state !== "active"'));
    const w = await readFile(new URL("../mobile-app/src/SiteWebView.tsx", import.meta.url), "utf8");
    assert.ok(w.includes("Ouvrir ${host} ?"));
  });

  test("source: WebView whitelist is '*' with our own gate; nonce injected; screen guard + re-lock present", async () => {
    const r = (p: string) => readFile(new URL(`../mobile-app/${p}`, import.meta.url), "utf8");
    const w = await r("src/SiteWebView.tsx");
    assert.ok(w.includes('originWhitelist={["*"]}'));
    assert.ok(w.includes("__BIS_APP_NONCE__") && w.includes("Crypto.randomUUID()"));
    assert.ok(w.includes("Alert.alert(") && w.includes("isExternalOpenable"));
    assert.ok(w.includes("MSG_MAX_PER_WINDOW") && w.includes(".catch("));
    const o = await r("src/OfflineScreen.tsx");
    assert.ok(o.includes("usePreventScreenCapture") && o.includes("AppState.addEventListener"));
    assert.ok(o.includes("predatesInstall"));
    const a = await r("src/auth.ts");
    assert.ok(a.includes("getEnrolledLevelAsync") && a.includes("SecurityLevel.NONE"));
    const cfg = await r("app.config.ts");
    assert.ok(cfg.includes("WKAppBoundDomains") && cfg.includes("blockedPermissions"));
    assert.equal(/scheme:/.test(cfg), false, "no unused deep-link scheme");
  });
});

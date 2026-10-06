import type { CapacitorConfig } from "@capacitor/cli";

// ─────────────────────────────────────────────────────────────────────────────
// BIS 2027 — native shell configuration.
//
// The app loads the LIVE website (server.url), so every website feature is in
// the app and updates ship without a store review. The only bundled pages are
// the offline badge page (www/offline.html, shown through `errorPath` when the
// server cannot be reached) and a tiny launcher.
//
// REQUIRED before building a release (OWNER ACTIONS — see docs/MOBILE-STORES.md):
//   BIS_APP_URL   production HTTPS origin of the site, e.g. https://bis2027.dz
//                 (the build REFUSES to continue without it or with http://)
//   BIS_APP_ID    reverse-DNS application id, chosen ONCE — it can never change
//                 after the first store publication. Default below is a
//                 placeholder you must review.
//
// Dev only (never for release):  BIS_DEV=1 BIS_APP_URL=http://10.0.2.2:3000
// ─────────────────────────────────────────────────────────────────────────────

const isDev = process.env.BIS_DEV === "1";
const rawUrl = (process.env.BIS_APP_URL ?? "").trim().replace(/\/+$/, "");

if (!rawUrl) {
  throw new Error(
    "BIS_APP_URL is not set. Set it to the production HTTPS origin (e.g. https://bis2027.dz) before `cap sync` / build."
  );
}
if (!isDev && !rawUrl.startsWith("https://")) {
  throw new Error(
    "BIS_APP_URL must be an https:// origin for release builds (set BIS_DEV=1 only for local development)."
  );
}

const host = new URL(rawUrl).host;

const config: CapacitorConfig = {
  appId: process.env.BIS_APP_ID ?? "dz.bis2027.summit",
  appName: "BIS 2027",
  webDir: "www",
  backgroundColor: "#080D18",

  server: {
    url: rawUrl,
    // Cleartext (http) is allowed ONLY for the local development flavour.
    cleartext: isDev,
    // Local page shown when the site cannot be reached: the offline badge.
    errorPath: "offline.html",
    // The WebView may navigate ONLY inside the site's own origin. Any other
    // link opens in the system browser instead of inside the app.
    allowNavigation: [host]
  },

  android: {
    allowMixedContent: false,
    // Never expose the WebView to remote debugging in a release build.
    webContentsDebuggingEnabled: isDev,
    backgroundColor: "#080D18"
  },

  ios: {
    contentInset: "always",
    backgroundColor: "#080D18",
    // WKAppBoundDomains is also required in Info.plist — see
    // mobile/scripts/harden-native.mjs, which writes it after `cap add ios`.
    limitsNavigationsToAppBoundDomains: true
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#080D18",
      showSpinner: false
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#2453E0",
      overlaysWebView: false
    }
  }
};

export default config;

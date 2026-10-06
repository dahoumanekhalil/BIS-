import type { ExpoConfig } from "expo/config";

// BIS 2027 — Expo configuration for TWO apps built from ONE codebase.
//
//   EXPO_PUBLIC_BIS_VARIANT=public (default)  participants' app
//   EXPO_PUBLIC_BIS_VARIANT=staff             event team's app (admin console)
//
// APP_ID is the permanent store identifier (bundle id on iOS, package on
// Android). It can NEVER change after the first store publication.
const IS_STAFF = process.env.EXPO_PUBLIC_BIS_VARIANT === "staff";

const APP_ID =
  process.env.BIS_APP_ID ?? (IS_STAFF ? "org.brandimpactsummit.staff" : "org.brandimpactsummit.app");

// Trusted hosts (must match src/config.ts): iOS app-bound domains.
const SITE = (process.env.EXPO_PUBLIC_SITE_URL ?? "https://app.brandimpactsummit.org").replace(/\/+$/, "");
const HOSTS = Array.from(
  new Set(
    (process.env.EXPO_PUBLIC_ALLOWED_HOSTS ?? "app.brandimpactsummit.org,brandimpactsummit.org")
      .split(",")
      .map((h: string) => h.trim().toLowerCase())
      .filter((h: string) => Boolean(h))
      .concat(new URL(SITE).host)
  )
);

const BG = IS_STAFF ? "#2453E0" : "#080D18";

const config: ExpoConfig = {
  name: IS_STAFF ? "BIS 2027 Équipe" : "BIS 2027",
  slug: IS_STAFF ? "bis-2027-staff" : "bis-2027",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  backgroundColor: "#080D18",
  ios: {
    bundleIdentifier: APP_ID,
    supportsTablet: true,
    infoPlist: {
      WKAppBoundDomains: HOSTS,
      // The camera exists ONLY in the staff app (badge scanner).
      ...(IS_STAFF
        ? { NSCameraUsageDescription: "La caméra sert uniquement au scan des badges des participants." }
        : {}),
      // TLS/HTTPS only → exempt encryption: no export-compliance questionnaire.
      ITSAppUsesNonExemptEncryption: false
    }
  },
  android: {
    package: APP_ID,
    // The public app's offline badge lives in the Keystore: it must never go
    // to a cloud backup.
    allowBackup: false,
    // Public app: no camera. Staff app: camera only.
    permissions: IS_STAFF ? ["CAMERA"] : [],
    // Expo's default manifest adds these; neither app needs any of them.
    blockedPermissions: [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.VIBRATE",
      "android.permission.RECORD_AUDIO",
      ...(IS_STAFF
        ? // Libraries linked for the public app's offline lock would merge these
          // into the staff binary; the staff app has no use for them.
          ["android.permission.USE_BIOMETRIC", "android.permission.USE_FINGERPRINT"]
        : ["android.permission.CAMERA"])
    ],
    adaptiveIcon: {
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundColor: BG
    },
    predictiveBackGestureEnabled: false
  },
  plugins: [
    [
      "expo-splash-screen",
      { image: "./assets/splash-icon.png", imageWidth: 200, resizeMode: "contain", backgroundColor: BG }
    ],
    // Offline badge storage + device-owner lock: PUBLIC app only.
    ...(IS_STAFF
      ? []
      : ([
          "expo-secure-store",
          ["expo-local-authentication", { faceIDPermission: "Déverrouillez votre badge hors ligne avec Face ID." }]
        ] as ExpoConfig["plugins"] & unknown[]))
  ],
  experiments: { typedRoutes: false }
};

export default config;

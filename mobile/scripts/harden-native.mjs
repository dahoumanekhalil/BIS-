// Applies the security / compliance settings the Capacitor templates do not
// set by default. Idempotent — run after `cap add` and before every release
// build (the CI workflow runs it).
//
//   BIS_APP_URL=https://bis2027.dz node scripts/harden-native.mjs
//
// ANDROID (AndroidManifest.xml)
//   • android:allowBackup="false"   → the saved offline badge never leaves the
//                                     device through cloud/adb backups
//   • usesCleartextTraffic="false"  → HTTPS only
//   • CAMERA permission (optional hardware) → the admin QR scanner (online only)
// IOS (Info.plist)
//   • WKAppBoundDomains = [site host]   (pairs with limitsNavigationsToAppBoundDomains)
//   • NSCameraUsageDescription          → admin QR scanner
//   • ITSAppUsesNonExemptEncryption=false (HTTPS/TLS only: exempt encryption)
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const raw = (process.env.BIS_APP_URL ?? "").trim();
if (!raw) throw new Error("BIS_APP_URL is required");
const host = new URL(raw).host;

// ── Android ───────────────────────────────────────────────────────────────
const manifestPath = join(root, "android/app/src/main/AndroidManifest.xml");
if (existsSync(manifestPath)) {
  let m = (await readFile(manifestPath, "utf8")).replace(/\r\n/g, "\n");

  m = m.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
  if (!/android:usesCleartextTraffic=/.test(m)) {
    m = m.replace(
      /<application\n/,
      '<application\n        android:usesCleartextTraffic="false"\n'
    );
  } else {
    m = m.replace(
      /android:usesCleartextTraffic="[^"]*"/,
      'android:usesCleartextTraffic="false"'
    );
  }
  if (!m.includes("android.permission.CAMERA")) {
    m = m.replace(
      "</manifest>",
      `    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
</manifest>`
    );
  }
  await writeFile(manifestPath, m, "utf8");
  console.log("hardened AndroidManifest.xml");
}

// ── Android Gradle: version + release signing from the ENVIRONMENT only ────
// (keystore path / passwords come from CI secrets — never from the repo.)
const gradlePath = join(root, "android/app/build.gradle");
if (existsSync(gradlePath)) {
  let g = (await readFile(gradlePath, "utf8")).replace(/\r\n/g, "\n");
  if (!g.includes("BIS-HARDENED")) {
    g = g.replace(
      /versionCode \d+/,
      'versionCode((System.getenv("BIS_VERSION_CODE") ?: "1").toInteger()) // BIS-HARDENED'
    );
    g = g.replace(
      /versionName "[^"]*"/,
      'versionName(System.getenv("BIS_VERSION_NAME") ?: "1.0")'
    );
    g = g.replace(
      /\n    buildTypes \{/,
      `
    signingConfigs {
        release {
            def ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (ksPath) {
                storeFile file(ksPath)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {`
    );
    g = g.replace(
      /(release \{\n)(\s+minifyEnabled false)/,
      `$1            if (System.getenv("ANDROID_KEYSTORE_PATH")) {
                signingConfig signingConfigs.release
            }
$2`
    );
    await writeFile(gradlePath, g, "utf8");
    console.log("hardened build.gradle (env-driven version + signing)");
  }
}

// ── iOS ───────────────────────────────────────────────────────────────────
const plistPath = join(root, "ios/App/App/Info.plist");
if (existsSync(plistPath)) {
  let p = (await readFile(plistPath, "utf8")).replace(/\r\n/g, "\n");

  const setKey = (key, valueXml) => {
    const re = new RegExp(`\\t<key>${key}</key>\\n\\t(?:<array>[\\s\\S]*?</array>|<string>[^<]*</string>|<true/>|<false/>)\\n`);
    const block = `\t<key>${key}</key>\n\t${valueXml}\n`;
    if (re.test(p)) p = p.replace(re, block);
    else p = p.replace("</dict>\n</plist>", `${block}</dict>\n</plist>`);
  };

  setKey("WKAppBoundDomains", `<array>\n\t\t<string>${host}</string>\n\t</array>`);
  setKey(
    "NSCameraUsageDescription",
    "<string>La caméra sert uniquement au scan des badges (espace équipe).</string>"
  );
  setKey("ITSAppUsesNonExemptEncryption", "<false/>");
  await writeFile(plistPath, p, "utf8");
  console.log("hardened Info.plist (app-bound domain:", host + ")");
}

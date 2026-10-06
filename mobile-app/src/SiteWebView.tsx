import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Linking,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  View
} from "react-native";
import * as Crypto from "expo-crypto";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type {
  ShouldStartLoadRequest,
  WebViewNavigation
} from "react-native-webview/lib/WebViewTypes";
import { APP_UA, START_URL, VARIANT, isAllowedNavigation, isExternalOpenable } from "./config";
import { handleBridgeMessage } from "./bridge";
import { secureSnapshotStore } from "./store";

// The whole website, inside the app. Everything the site offers works here
// (account, registration, programme, badge, admin console — online only).
//
// Hardening:
//  • react-native-webview consults `originWhitelist` BEFORE our handler and
//    opens any non-matching URL (any scheme!) with Linking by itself — so the
//    whitelist is "*" and OUR handler is the only gate. It allows only
//    about:blank and the site's own HTTPS hosts; everything else is blocked
//    inside the app. A top-level https/mailto/tel link is offered to the user
//    in a confirmation dialog (never opened silently, never other schemes);
//  • no multiple windows, no file/content access, no mixed content, no
//    third-party cookies, no link previews;
//  • the bridge needs a per-launch random nonce that only the MAIN frame
//    receives (injected before content loads, main frame only), so an iframe
//    or a foreign frame cannot talk to the app; and it is rate-limited.

const MSG_WINDOW_MS = 60_000;
const MSG_MAX_PER_WINDOW = 40;

export function SiteWebView({ onOffline }: { onOffline: () => void }) {
  const ref = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const [loading, setLoading] = useState(true);
  const askedCamera = useRef(false);
  const askingExternal = useRef(false);
  const nonce = useRef(Crypto.randomUUID());
  const msgTimes = useRef<number[]>([]);

  // Runs before the page's own scripts, main frame only (the library default).
  const injected = `window.__BIS_APP__ = true; window.__BIS_APP_NONCE__ = ${JSON.stringify(
    nonce.current
  )}; true;`;

  // Android hardware back: go back in the site, then exit.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack.current) {
        ref.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const onShouldStart = useCallback((req: ShouldStartLoadRequest) => {
    const url = req.url;
    if (url === "about:blank") return true;
    if (isAllowedNavigation(url)) return true;

    // Foreign target. Never navigate inside the app. Offer to open it
    // externally ONLY for a top-level navigation (not an iframe), only for
    // https / mailto / tel, only after the user confirms, one dialog at a time.
    const topFrame = req.isTopFrame !== false;
    if (topFrame && isExternalOpenable(url) && !askingExternal.current) {
      askingExternal.current = true;
      const label = url.length > 120 ? url.slice(0, 117) + "…" : url;
      const host = /^https:\/\/([^/?#@]+@)?([^/?#]+)/i.exec(url)?.[2] ?? url.split(":")[0];
      Alert.alert(
        `Ouvrir ${host} ?`,
        `${label}\n\nCe lien quitte l'application BIS 2027.`,
        [
          { text: "Annuler", style: "cancel", onPress: () => (askingExternal.current = false) },
          {
            text: "Ouvrir",
            onPress: () => {
              askingExternal.current = false;
              void Linking.openURL(url).catch(() => undefined);
            }
          }
        ],
        { cancelable: true, onDismiss: () => (askingExternal.current = false) }
      );
    }
    return false;
  }, []);

  const onNavChange = useCallback((nav: WebViewNavigation) => {
    canGoBack.current = nav.canGoBack;
    // The staff badge scanner (online only) needs the camera: ask once, in
    // context. iOS shows its own prompt from the Info.plist text.
    if (
      VARIANT === "staff" &&
      Platform.OS === "android" &&
      !askedCamera.current &&
      /^https:\/\/[^/]+\/admin\/scan/i.test(nav.url)
    ) {
      askedCamera.current = true;
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
    }
  }, []);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    const now = Date.now();
    msgTimes.current = msgTimes.current.filter((t) => now - t < MSG_WINDOW_MS);
    if (msgTimes.current.length >= MSG_MAX_PER_WINDOW) return; // flood guard
    msgTimes.current.push(now);
    handleBridgeMessage(
      e.nativeEvent.data,
      e.nativeEvent.url,
      secureSnapshotStore,
      nonce.current
    ).catch(() => undefined);
  }, []);

  return (
    <View style={styles.fill}>
      <WebView
        ref={ref}
        source={{ uri: START_URL }}
        style={styles.fill}
        originWhitelist={["*"]}
        applicationNameForUserAgent={APP_UA}
        // The offline-badge bridge exists for the PUBLIC app only; the staff app
        // exposes no bridge and keeps no snapshot store.
        injectedJavaScriptBeforeContentLoaded={VARIANT === "staff" ? undefined : injected}
        onShouldStartLoadWithRequest={onShouldStart}
        onNavigationStateChange={onNavChange}
        onMessage={VARIANT === "staff" ? undefined : onMessage}
        onLoadEnd={() => setLoading(false)}
        onError={onOffline}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500) onOffline();
        }}
        javaScriptEnabled
        domStorageEnabled
        // Staff app, shared team devices: no persistent web storage — the admin
        // session ends when the app process ends.
        incognito={VARIANT === "staff"}
        sharedCookiesEnabled={VARIANT !== "staff"}
        thirdPartyCookiesEnabled={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false}
        allowsLinkPreview={false}
        mixedContentMode="never"
        pullToRefreshEnabled
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        // Only the staff app ever uses the camera (badge scanner); the public
        // app denies every media-capture request outright.
        mediaCapturePermissionGrantType={VARIANT === "staff" ? "grantIfSameHostElsePrompt" : "deny"}
        limitsNavigationsToAppBoundDomains
        startInLoadingState={false}
      />
      {loading && (
        <View style={styles.loader} pointerEvents="none">
          <ActivityIndicator color="#2453E0" size="large" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#fff" },
  loader: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff"
  }
});

import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useNetworkState } from "expo-network";
import { SiteWebView } from "./src/SiteWebView";
import { OfflineScreen } from "./src/OfflineScreen";
import { StaffOfflineScreen } from "./src/StaffOfflineScreen";
import { VARIANT } from "./src/config";

// BIS 2027 — the website as an app.
//   online  → the live site in a hardened WebView (admin console included)
//   offline → a native screen with the participant's saved badge + profile
// The admin console is online-only by design: nothing from it is ever cached.
export default function App() {
  const net = useNetworkState();
  const offlineByNetwork = net.isConnected === false || net.isInternetReachable === false;
  const [webFailed, setWebFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const wasOffline = useRef(false);

  // Connectivity came back → reload the site automatically.
  useEffect(() => {
    if (wasOffline.current && !offlineByNetwork) {
      setWebFailed(false);
      setAttempt((n) => n + 1);
    }
    wasOffline.current = offlineByNetwork;
  }, [offlineByNetwork]);

  const showOffline = offlineByNetwork || webFailed;

  return (
    <SafeAreaProvider>
      <StatusBar style={showOffline ? "light" : "dark"} />
      <SafeAreaView style={[styles.root, showOffline && styles.dark]} edges={["top", "left", "right"]}>
        <View style={styles.fill}>
          {showOffline ? (
            VARIANT === "staff" ? (
              <StaffOfflineScreen
                onRetry={() => {
                  setWebFailed(false);
                  setAttempt((n) => n + 1);
                }}
              />
            ) : (
              <OfflineScreen
                onRetry={() => {
                  setWebFailed(false);
                  setAttempt((n) => n + 1);
                }}
              />
            )
          ) : (
            <SiteWebView key={attempt} onOffline={() => setWebFailed(true)} />
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  dark: { backgroundColor: "#080D18" },
  fill: { flex: 1 }
});

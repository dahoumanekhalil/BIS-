import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import * as Application from "expo-application";
import { usePreventScreenCapture } from "expo-screen-capture";
import { loadSnapshot } from "./bridge";
import { evaluate, predatesInstall, type Snapshot } from "./snapshot";
import { secureSnapshotStore } from "./store";
import { authenticateOwner } from "./auth";

// Native offline screen: the participant's badge + profile with NO network.
// The admin console is online-only by design and is never shown here.
type Phase =
  | { k: "loading" }
  | { k: "none"; expired: boolean }
  | { k: "locked"; snap: Snapshot }
  | { k: "show"; snap: Snapshot; stale: boolean };

const fmt = (iso: string) => {
  try {
    return new Date(iso).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
};

// While the badge is on screen: no screenshots / screen recording, and the
// content is hidden in the app switcher (FLAG_SECURE on Android, iOS equivalent).
function ScreenGuard() {
  usePreventScreenCapture("bis-offline-badge");
  return null;
}

export function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  // Re-lock whenever the app leaves the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      // Only "background": on iOS the Face ID sheet itself makes the app
      // "inactive" for a moment and must not re-lock the badge in a loop. (The
      // screen guard already hides the content in the app switcher.)
      if (state === "background") {
        setPhase((p) => (p.k === "show" ? { k: "locked", snap: p.snap } : p));
      }
    });
    return () => sub.remove();
  }, []);

  const unlock = useCallback(async (snap: Snapshot) => {
    const res = await authenticateOwner();
    if (res === "denied") {
      setPhase({ k: "locked", snap });
      return;
    }
    setPhase({ k: "show", snap, stale: evaluate(snap).state === "stale" });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      let snap = await loadSnapshot(secureSnapshotStore);
      if (!alive) return;
      if (snap) {
        // iOS keeps Keychain items across reinstall: drop a snapshot that was
        // saved before THIS installation.
        try {
          const installedAt = await Application.getInstallationTimeAsync();
          if (installedAt && predatesInstall(snap, installedAt)) {
            await secureSnapshotStore.remove();
            snap = null;
          }
        } catch {
          // installation time unavailable → keep (expiry still applies)
        }
      }
      const ev = evaluate(snap);
      if (!snap || ev.state === "none") return setPhase({ k: "none", expired: false });
      if (ev.state === "expired") {
        // Hidden, not just warned: an admin may have replaced the QR meanwhile.
        await secureSnapshotStore.remove();
        return setPhase({ k: "none", expired: true });
      }
      void unlock(snap);
    })();
    return () => {
      alive = false;
    };
  }, [unlock]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.bar}>
        <Text style={styles.brand}>BIS 2027</Text>
        <Text style={styles.pill}>HORS LIGNE</Text>
      </View>

      {phase.k === "loading" && <ActivityIndicator color="#B8E62E" style={{ marginTop: 48 }} />}

      {phase.k === "none" && (
        <View style={styles.card}>
          <Text style={styles.h1}>{phase.expired ? "Badge à actualiser" : "Aucun badge enregistré"}</Text>
          <Text style={styles.sub}>
            {phase.expired
              ? "Votre badge hors ligne a expiré par sécurité. Connectez-vous à Internet puis ouvrez « Mon badge » pour le réactiver."
              : "Connectez-vous à Internet et ouvrez « Mon badge » une première fois : il sera ensuite disponible hors ligne sur cet appareil."}
          </Text>
        </View>
      )}

      {phase.k === "locked" && (
        <View style={styles.card}>
          <Text style={styles.h1}>Badge verrouillé</Text>
          <Text style={styles.sub}>
            Déverrouillez avec votre empreinte, votre visage ou le code de l’appareil.
          </Text>
          <Pressable style={styles.btnDark} onPress={() => void unlock(phase.snap)}>
            <Text style={styles.btnDarkText}>Déverrouiller</Text>
          </Pressable>
        </View>
      )}

      {phase.k === "show" && (
        <>
          <ScreenGuard />
          <View style={styles.card}>
            <Text style={styles.role}>{(phase.snap.roleLabel ?? "Participant").toUpperCase()}</Text>
            <Text style={styles.h1}>
              {phase.snap.firstName} {phase.snap.lastName}
            </Text>
            {[phase.snap.jobTitle, phase.snap.organization].filter(Boolean).length > 0 && (
              <Text style={styles.sub}>
                {[phase.snap.jobTitle, phase.snap.organization].filter(Boolean).join(" · ")}
              </Text>
            )}
            <View style={styles.qrBox}>
              <QRCode
                value={phase.snap.token}
                size={240}
                ecl="M"
                color="#0A0A0A"
                backgroundColor="#FFFFFF"
                quietZone={8}
              />
            </View>
            {phase.snap.checkinCode ? <Text style={styles.code}>{phase.snap.checkinCode}</Text> : null}
            <Text style={styles.meta}>Dernière mise à jour : {fmt(phase.snap.syncedAt)}</Text>
            {phase.stale && (
              <Text style={styles.warn}>
                Ce badge n’a pas été actualisé récemment. Si l’équipe BIS l’a remplacé, l’ancien QR ne sera
                plus accepté : reconnectez-vous dès que possible.
              </Text>
            )}
          </View>

          <View style={[styles.card, { marginTop: 12, alignItems: "stretch" }]}>
            <Text style={[styles.h2]}>Mon profil</Text>
            {(
              [
                ["Email", phase.snap.email],
                ["Téléphone", phase.snap.phone],
                ["Pays", phase.snap.country],
                ["Participation", phase.snap.participationLabel],
                ["Inscription", phase.snap.statusLabel]
              ] as const
            )
              .filter(([, v]) => !!v)
              .map(([k, v]) => (
                <View key={k} style={styles.row}>
                  <Text style={styles.rowK}>{k}</Text>
                  <Text style={styles.rowV}>{v}</Text>
                </View>
              ))}
          </View>
        </>
      )}

      <Text style={styles.info}>L’espace d’administration nécessite une connexion Internet.</Text>
      <Pressable style={styles.btnLime} onPress={onRetry} accessibilityRole="button">
        <Text style={styles.btnLimeText}>Réessayer la connexion</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#080D18" },
  content: { padding: 16, paddingBottom: 40, maxWidth: 460, width: "100%", alignSelf: "center" },
  bar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  brand: { color: "#fff", fontWeight: "900", fontSize: 16 },
  pill: {
    color: "#fff",
    backgroundColor: "rgba(255,255,255,0.12)",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden"
  },
  card: { backgroundColor: "#fff", borderRadius: 20, padding: 20, alignItems: "center" },
  role: {
    backgroundColor: "#2453E0",
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden"
  },
  h1: { fontSize: 24, fontWeight: "900", color: "#0A0A0A", marginTop: 12, textAlign: "center" },
  h2: { fontSize: 15, fontWeight: "900", color: "#0A0A0A", marginBottom: 6 },
  sub: { color: "#55606f", fontSize: 14, marginTop: 4, textAlign: "center" },
  qrBox: { marginTop: 18, padding: 4, backgroundColor: "#fff" },
  code: { marginTop: 10, fontWeight: "700", letterSpacing: 2, fontSize: 15, color: "#0A0A0A" },
  meta: { marginTop: 14, fontSize: 12, color: "#55606f" },
  warn: {
    marginTop: 14,
    backgroundColor: "#FFF7E0",
    color: "#7A5200",
    padding: 12,
    borderRadius: 12,
    fontSize: 13,
    overflow: "hidden"
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#E6E8ED"
  },
  rowK: { color: "#55606f", fontSize: 13 },
  rowV: { color: "#0A0A0A", fontSize: 13, fontWeight: "700", flexShrink: 1, textAlign: "right" },
  info: { color: "#D5DBE6", fontSize: 13, marginTop: 16, lineHeight: 19 },
  btnLime: { marginTop: 16, backgroundColor: "#B8E62E", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  btnLimeText: { color: "#0A0A0A", fontWeight: "800", fontSize: 14 },
  btnDark: { marginTop: 16, backgroundColor: "#0A0A0A", borderRadius: 12, paddingVertical: 13, paddingHorizontal: 22 },
  btnDarkText: { color: "#B8E62E", fontWeight: "800", fontSize: 14 }
});

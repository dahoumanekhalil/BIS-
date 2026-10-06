import { Pressable, StyleSheet, Text, View } from "react-native";

// Staff app, no connection: the admin console is online-only BY DESIGN (no
// admin data is ever stored on the device), so there is nothing to show but
// a clear message and a retry.
export function StaffOfflineScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.root}>
      <Text style={styles.brand}>BIS 2027 · ÉQUIPE</Text>
      <View style={styles.card}>
        <Text style={styles.h1}>Connexion Internet requise</Text>
        <Text style={styles.sub}>
          L’espace équipe fonctionne uniquement en ligne. Aucune donnée d’administration n’est
          conservée sur cet appareil. Reconnectez-vous puis réessayez.
        </Text>
        <Pressable style={styles.btn} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.btnText}>Réessayer</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#080D18", padding: 20, justifyContent: "center" },
  brand: { color: "#fff", fontWeight: "900", fontSize: 16, marginBottom: 16, textAlign: "center" },
  card: { backgroundColor: "#fff", borderRadius: 20, padding: 22, alignItems: "center" },
  h1: { fontSize: 22, fontWeight: "900", color: "#0A0A0A", textAlign: "center" },
  sub: { color: "#55606f", fontSize: 14, marginTop: 10, textAlign: "center", lineHeight: 20 },
  btn: { marginTop: 18, backgroundColor: "#B8E62E", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 },
  btnText: { color: "#0A0A0A", fontWeight: "800", fontSize: 14 }
});

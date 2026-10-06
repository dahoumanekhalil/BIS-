import * as LocalAuthentication from "expo-local-authentication";

// Device-owner check in front of the offline badge (fingerprint / Face ID /
// device PIN). Policy:
//   • a device lock exists (PIN / pattern / password / biometrics) → the check
//     MUST succeed; a cancel/failure keeps the badge hidden (retry offered);
//   • the device has NO lock at all → nothing to ask, show the badge;
//   • NOTE: this is a UI-level gate in front of the secure store (the store
//     itself is not created with requireAuthentication, which Expo Go lacks);
//   • Expo Go on iPhone cannot use Face ID (missing usage string): in a DEV
//     build only, that specific error does not block testing.
export type AuthResult = "ok" | "denied" | "unavailable";

export async function authenticateOwner(): Promise<AuthResult> {
  try {
    // Any device lock counts (PIN / pattern / password / biometrics): the
    // level is SECRET or higher. Only a device with NO lock at all is shown
    // without a check (there is nothing to ask).
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return "unavailable";

    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: "Déverrouillez pour afficher votre badge",
      cancelLabel: "Annuler",
      fallbackLabel: "Utiliser le code"
    });
    if (res.success) return "ok";
    if (__DEV__ && (res as { error?: string }).error === "missing_usage_description") {
      return "unavailable"; // Expo Go + Face ID: cannot be tested there
    }
    return "denied";
  } catch {
    return "denied";
  }
}

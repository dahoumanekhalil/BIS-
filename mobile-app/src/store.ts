import * as SecureStore from "expo-secure-store";
import type { SnapshotStore } from "./bridge";

// OS-protected storage: iOS Keychain (WHEN_UNLOCKED_THIS_DEVICE_ONLY → never in
// iCloud/iTunes backups, never restored to another phone) and Android Keystore
// (+ allowBackup=false in app.config.ts). Contents are the offline badge.
const KEY = "bis.offline.snapshot.v2";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
};

export const secureSnapshotStore: SnapshotStore = {
  async get() {
    try {
      return await SecureStore.getItemAsync(KEY, OPTIONS);
    } catch {
      return null; // unreadable (e.g. keystore reset) → behave as empty
    }
  },
  async set(value) {
    await SecureStore.setItemAsync(KEY, value, OPTIONS);
  },
  async remove() {
    try {
      await SecureStore.deleteItemAsync(KEY, OPTIONS);
    } catch {
      // nothing to delete
    }
  }
};

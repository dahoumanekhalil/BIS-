"use client";

import Script from "next/script";
import { useEffect } from "react";

// Global (root layout) runtime for the app / PWA offline layer.
//
//  • Loads the shared offline core (public/offline-core.js).
//  • Registers the minimal service worker in production (static assets +
//    offline page only — see public/sw.js).
//  • On EVERY page load wipes any saved offline badge that is not owned by
//    the current account (signed out → wipes all): logging out, an expired
//    session or another user signing in must never leave a working QR behind.
//
// It renders nothing and handles no secrets.

declare global {
  interface Window {
    BISOffline?: {
      clear: () => Promise<void>;
      clearUnlessOwner: (ownerKey: string | null) => Promise<boolean>;
    };
  }
}

// `accountKey` is a one-way tag of the signed-in account (null = signed out).
export function OfflineRuntime({ accountKey }: { accountKey: string | null }) {
  useEffect(() => {
    if (
      process.env.NODE_ENV === "production" &&
      "serviceWorker" in navigator
    ) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Offline support is an enhancement: never break the page.
      });
    }
  }, []);

  useEffect(() => {
    // Wipe any saved badge that does not belong to the CURRENT account
    // (signed out → wipe everything). The core loads asynchronously, so retry
    // for up to ~10 s.
    let tries = 0;
    const run = () => {
      if (!window.BISOffline) return false;
      void window.BISOffline.clearUnlessOwner(accountKey);
      return true;
    };
    if (run()) return;
    const t = setInterval(() => {
      tries += 1;
      if (run() || tries > 50) clearInterval(t);
    }, 200);
    return () => clearInterval(t);
  }, [accountKey]);

  return <Script src="/offline-core.js" strategy="afterInteractive" />;
}

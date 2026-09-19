"use client";

import { useEffect, useState } from "react";

// Phase 12 — request the browser's Screen Wake Lock so the phone does
// not dim/lock while the attendee is showing their QR at the entrance.
//
// The Wake Lock API is a modern browser standard (Chromium, Firefox 126+,
// Safari 16.4+). Where unsupported, the hook is a silent no-op — we
// cannot force the screen to stay on from userspace on older iOS or
// obscure browsers. There is NO web API that can raise brightness;
// operators / attendees still need to raise brightness manually in
// low-light or venue-lit conditions.
//
// Contract:
//   • Only active while `enabled === true`. When the caller flips it to
//     false (e.g., the QR was rotated away), the lock is released.
//   • Automatically re-acquires the lock when the tab becomes visible
//     again (some browsers release it on visibilitychange:hidden).
//   • Handles user-agent quirks silently — no toasts, no alerts, no
//     console noise.
//
// Returns { supported, active } for the UI to render a discreet
// "Écran gardé actif" indicator. `active` reflects the actual lock
// state, not just the requested state.

type Sentinel = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", cb: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<Sentinel>;
  };
};

export function useScreenWakeLock(enabled: boolean): {
  supported: boolean;
  active: boolean;
} {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setSupported("wakeLock" in navigator);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined") return;
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) return;

    let sentinel: Sentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const s = await nav.wakeLock!.request("screen");
        if (cancelled) {
          await s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        setActive(true);
        s.addEventListener?.("release", () => {
          // Some browsers release the lock on tab-hidden. Update the
          // UI so it does not falsely claim "active" when it isn't.
          setActive(false);
          sentinel = null;
        });
      } catch {
        // Battery-saver, permission denied, or ephemeral failure —
        // we don't surface an error to the operator; brightness / lock
        // is a nice-to-have, not a security control.
        setActive(false);
      }
    };

    const onVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        sentinel == null &&
        !cancelled
      ) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (sentinel) {
        void sentinel.release().catch(() => undefined);
        sentinel = null;
      }
      setActive(false);
    };
  }, [enabled]);

  return { supported, active };
}

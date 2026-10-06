"use client";

import { useEffect, useState } from "react";

// Saves the participant's own badge for offline use on THIS device and lets
// them turn that off. Rendered only on /compte/badge, i.e. only when signed
// in, verified and online, with the server-derived QR image in hand.
//
// What is saved: name, organisation, role label, QR image, text fallback
// code, a few profile lines (email, phone, country, participation, status), sync time (see public/offline-core.js). Cleared at logout and after
// 14 days. The opt-out flag is a plain per-device preference.

type SnapshotInput = {
  firstName: string;
  lastName: string;
  organization: string | null;
  jobTitle: string | null;
  roleLabel: string;
  owner: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  participationLabel: string | null;
  statusLabel: string | null;
  qrDataUrl: string;
  checkinCode: string | null;
};

type Core = {
  inApp: () => boolean;
  postToApp: (m: unknown) => boolean;
  build: (i: SnapshotInput, now?: Date) => unknown;
  save: (s: unknown) => Promise<boolean>;
  clear: () => Promise<void>;
};

const OPT_OUT_KEY = "bis.offline.optout";

function getCore(): Core | null {
  return (window as unknown as { BISOffline?: Core }).BISOffline ?? null;
}

function readOptOut(): boolean {
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

// `appToken` is the participant's own raw QR token, provided by the server
// ONLY when the page is requested by the mobile app (User-Agent BISApp/…).
// It is handed straight to the app's secure storage through the WebView bridge
// and never rendered or stored by the website.
export function OfflineSnapshotSync({
  data,
  appToken
}: {
  data: SnapshotInput;
  appToken?: string | null;
}) {
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState<null | boolean>(null);

  useEffect(() => {
    setEnabled(!readOptOut());
  }, []);

  useEffect(() => {
    let tries = 0;
    const run = () => {
      const core = getCore();
      if (!core) return false;
      if (!enabled) {
        void core.clear();
        setSaved(false);
        return true;
      }
      if (core.inApp()) {
        // Mobile app: secure native storage (Keychain/Keystore).
        if (!appToken) {
          setSaved(false);
          return true;
        }
        const { qrDataUrl: _qr, ...profile } = data;
        void _qr;
        const ok = core.postToApp({
          type: "bis.snapshot.save",
          payload: { ...profile, token: appToken }
        });
        setSaved(ok);
        return true;
      }
      const snap = core.build(data);
      if (!snap) {
        setSaved(false);
        return true;
      }
      void core.save(snap).then((ok) => setSaved(ok));
      return true;
    };
    if (run()) return;
    const t = setInterval(() => {
      tries += 1;
      if (run() || tries > 25) clearInterval(t);
    }, 200);
    return () => clearInterval(t);
  }, [enabled, data, appToken]);

  const toggle = () => {
    const next = !enabled;
    try {
      if (next) window.localStorage.removeItem(OPT_OUT_KEY);
      else window.localStorage.setItem(OPT_OUT_KEY, "1");
    } catch {
      // preference simply not persisted
    }
    setEnabled(next);
  };

  return (
    <div className="print-hide rounded-[16px] border border-line bg-white p-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
        Hors ligne
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink/60">
        Gardez votre badge disponible sans Internet sur cet appareil. La copie
        est supprimée à la déconnexion et après 14 jours. Si l&apos;équipe BIS
        remplace votre QR, reconnectez-vous pour récupérer le nouveau.
      </p>
      <label className="mt-3 flex items-center gap-2 text-[12.5px] font-semibold text-ink">
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          className="h-4 w-4"
        />
        Disponible hors ligne sur cet appareil
      </label>
      {saved === true && enabled && (
        <p className="mt-2 text-[11px] font-semibold text-emerald-700">
          Copie hors ligne à jour.
        </p>
      )}
    </div>
  );
}

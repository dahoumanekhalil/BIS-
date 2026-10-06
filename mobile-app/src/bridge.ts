// Messages from the website (running inside the WebView) to the app.
// Pure logic with an injected store, so it is fully unit-tested.
//
// SECURITY RULES
//  • accepted only from the site's own HTTPS hosts (checked on the URL the
//    WebView reports for the page that sent the message);
//  • every message must carry the per-launch NONCE the app injected into the
//    MAIN frame only — an iframe / foreign frame never learns it;
//  • bounded size, strict JSON, unknown types ignored;
//  • the payload is re-validated with the same strict rules as stored data;
//  • the web page can never set the sync time (the app stamps it).

import { isAllowedUrl } from "./config";
import { buildSnapshot, validateSnapshot, type Snapshot } from "./snapshot";

export interface SnapshotStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

export type BridgeResult = "saved" | "cleared" | "kept" | "rejected" | "ignored";

const MAX_MESSAGE_CHARS = 16_000;

// Read + validate; a corrupted / tampered value is removed, never returned.
export async function loadSnapshot(store: SnapshotStore): Promise<Snapshot | null> {
  const raw = await store.get();
  if (!raw) return null;
  const snap = validateSnapshot(raw);
  if (!snap) {
    await store.remove();
    return null;
  }
  return snap;
}

function sameSecret(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length || b.length < 16) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleBridgeMessage(
  rawData: unknown,
  pageUrl: string,
  store: SnapshotStore,
  nonce: string,
  hosts?: readonly string[],
  now: Date = new Date()
): Promise<BridgeResult> {
  if (typeof rawData !== "string" || rawData.length > MAX_MESSAGE_CHARS) return "rejected";
  if (!isAllowedUrl(pageUrl, hosts)) return "rejected";

  let msg: { type?: unknown; payload?: unknown; owner?: unknown; nonce?: unknown };
  try {
    msg = JSON.parse(rawData);
  } catch {
    return "rejected";
  }
  if (!msg || typeof msg !== "object") return "rejected";
  if (!sameSecret(msg.nonce, nonce)) return "rejected";

  switch (msg.type) {
    case "bis.snapshot.save": {
      const snap = buildSnapshot(msg.payload, now);
      if (!snap) return "rejected";
      await store.set(JSON.stringify(snap));
      return "saved";
    }
    case "bis.snapshot.clear": {
      await store.remove();
      return "cleared";
    }
    case "bis.snapshot.clearUnlessOwner": {
      // owner === null means "nobody is signed in" → wipe.
      const owner = typeof msg.owner === "string" ? msg.owner : null;
      const raw = await store.get();
      if (!raw) return "kept";
      const snap = validateSnapshot(raw);
      if (!snap || !owner || snap.owner !== owner) {
        await store.remove();
        return "cleared";
      }
      return "kept";
    }
    default:
      return "ignored";
  }
}

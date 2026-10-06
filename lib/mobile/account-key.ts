import "server-only";

import { createHash } from "node:crypto";

// One-way, non-reversible tag of an account id. It is stored inside the offline
// snapshot and compared to the CURRENT account on every page load, so a
// snapshot saved for user A is wiped as soon as the site is opened by anyone
// else (or by nobody) — even if A never pressed "log out". The raw account id
// never reaches the device.
export function offlineAccountKey(accountId: string): string {
  return createHash("sha256")
    .update(`bis-offline-owner|${accountId}`)
    .digest("hex")
    .slice(0, 24);
}

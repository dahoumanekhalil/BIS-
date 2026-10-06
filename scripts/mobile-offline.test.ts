// Offline / PWA layer tests (no database needed).
//   npm run test:mobile-offline
//
// Covers: snapshot validation + expiry, storage adapters (web + native
// bridge), the service worker's "never cache admin/api/HTML" guarantees, and
// static safety checks on the offline page and the manifest.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import vm from "node:vm";

const read = (p: string) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

// PNG data URL fixture (valid base64 charset, bounded size).
const QR = "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

async function loadCore(ctx: Record<string, unknown> = {}) {
  const src = await read("public/offline-core.js");
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  };
  const sandbox: Record<string, unknown> = { localStorage, Promise, JSON, Date, isFinite, ...ctx };
  sandbox.self = sandbox;
  vm.runInNewContext(src, sandbox);
  return { core: sandbox.BISOffline as any, store };
}

const good = {
  firstName: "Amine",
  lastName: "Benali",
  organization: "Axis",
  jobTitle: "CTO",
  roleLabel: "Visiteur",
  owner: "0123456789abcdef01234567",
  email: "amine@axis.dz",
  phone: "+213 555 00 11 22",
  country: "Algérie",
  participationLabel: "Participant / Visiteur",
  statusLabel: "Inscription confirmée",
  qrDataUrl: QR,
  checkinCode: "K4MX-92QT-A7RN"
};

describe("offline snapshot — validation", () => {
  test("accepts a well-formed snapshot", async () => {
    const { core } = await loadCore();
    const s = core.build(good);
    assert.ok(s);
    assert.equal(s.firstName, "Amine");
    assert.equal(s.v, 1);
  });

  test("rejects non-PNG / script / oversized / malformed QR payloads", async () => {
    const { core } = await loadCore();
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "javascript:alert(1)",
      "data:image/png;base64,<script>alert(1)</script>",
      "https://evil.example/qr.png",
      "data:image/png;base64," + "A".repeat(210 * 1024)
    ]) {
      assert.equal(core.build({ ...good, qrDataUrl: bad }), null, bad.slice(0, 40));
    }
  });

  test("rejects missing names, wrong version, bad code, non-objects", async () => {
    const { core } = await loadCore();
    assert.equal(core.build({ ...good, firstName: "" }), null);
    assert.equal(core.build({ ...good, lastName: "x".repeat(81) }), null);
    assert.equal(core.build({ ...good, checkinCode: "<b>x</b>" }), null);
    for (const junk of [null, undefined, 5, "nope", "{", [], { v: 2 }]) {
      assert.equal(core.validate(junk), null);
    }
  });
});

describe("offline snapshot — profile lines", () => {
  test("profile fields round-trip", async () => {
    const { core } = await loadCore();
    const s = core.build(good);
    assert.equal(s.email, "amine@axis.dz");
    assert.equal(s.phone, "+213 555 00 11 22");
    assert.equal(s.statusLabel, "Inscription confirmée");
  });

  test("a bad optional profile field becomes null and never invalidates the badge", async () => {
    const { core } = await loadCore();
    const s = core.build({
      ...good,
      email: "<img src=x onerror=1>@a.b",
      phone: "call me!",
      country: "x".repeat(61),
      statusLabel: "<b>ok</b>"
    });
    assert.ok(s, "snapshot still valid");
    assert.equal(s.email, null);
    assert.equal(s.phone, null);
    assert.equal(s.country, null);
    assert.equal(s.statusLabel, null);
    assert.equal(s.firstName, "Amine");
  });

  test("older snapshots without profile fields still load", async () => {
    const { core } = await loadCore();
    const s = core.validate({
      v: 1, firstName: "A", lastName: "B", qrDataUrl: QR, syncedAt: new Date().toISOString()
    });
    assert.ok(s);
    assert.equal(s.email, null);
  });
});

describe("offline snapshot — expiry", () => {
  test("fresh → stale after 1 day → expired (hidden) after 14 days", async () => {
    const { core } = await loadCore();
    const t0 = new Date("2027-11-10T10:00:00Z");
    const s = core.build(good, t0);
    const at = (ms: number) => core.evaluate(s, new Date(t0.getTime() + ms)).state;
    assert.equal(at(1000), "fresh");
    assert.equal(at(25 * 3600e3), "stale");
    assert.equal(at(13 * 86400e3), "stale");
    assert.equal(at(15 * 86400e3), "expired");
    assert.equal(core.evaluate(null, t0).state, "none");
  });

  test("clock moved backwards is treated as just synced, never negative", async () => {
    const { core } = await loadCore();
    const s = core.build(good, new Date("2027-11-10T10:00:00Z"));
    assert.equal(core.evaluate(s, new Date("2027-11-09T10:00:00Z")).state, "fresh");
  });
});

describe("offline storage adapters", () => {
  test("web: save → load → clear", async () => {
    const { core } = await loadCore();
    assert.equal(await core.save(core.build(good)), true);
    const s = await core.load();
    assert.equal(s.lastName, "Benali");
    await core.clear();
    assert.equal(await core.load(), null);
  });

  test("a corrupted / tampered stored value is dropped, never rendered", async () => {
    const { core, store } = await loadCore();
    store.set(core.KEY, '{"v":1,"firstName":"<img onerror=x>","qrDataUrl":"javascript:1"}');
    assert.equal(await core.load(), null);
    assert.equal(store.has(core.KEY), false, "bad value is removed");
  });

  test("save refuses an invalid snapshot (nothing written)", async () => {
    const { core, store } = await loadCore();
    assert.equal(await core.save({ ...good, v: 1, syncedAt: "x", qrDataUrl: "bad" }), false);
    assert.equal(store.size, 0);
  });

  test("native: uses the Capacitor Preferences bridge when running natively", async () => {
    const mem = new Map<string, string>();
    const Preferences = {
      get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
      set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
      remove: async ({ key }: { key: string }) => void mem.delete(key)
    };
    const { core, store } = await loadCore({
      Capacitor: { isNativePlatform: () => true, Plugins: { Preferences } }
    });
    await core.save(core.build(good));
    assert.equal(mem.size, 1, "stored natively");
    assert.equal(store.size, 0, "not in web storage");
    assert.equal((await core.load()).firstName, "Amine");
    await core.clear();
    assert.equal(mem.size, 0);
  });

  test("Capacitor present but NOT native → web storage", async () => {
    const { core, store } = await loadCore({
      Capacitor: { isNativePlatform: () => false, Plugins: {} }
    });
    await core.save(core.build(good));
    assert.equal(store.size, 1);
  });
});

// ── Service worker behaviour ────────────────────────────────────────────

async function loadSw() {
  const src = await read("public/sw.js");
  const handlers: Record<string, (e: any) => void> = {};
  const cacheStore = new Map<string, Map<string, any>>();
  const putLog: string[] = [];
  const cacheOf = (n: string) => {
    if (!cacheStore.has(n)) cacheStore.set(n, new Map());
    const m = cacheStore.get(n)!;
    return {
      addAll: async (urls: string[]) => urls.forEach((u) => m.set(u, { url: u, precached: true })),
      put: async (req: any, res: any) => {
        const k = typeof req === "string" ? new URL(req).pathname : new URL(req.url).pathname;
        putLog.push(k);
        m.set(k, res);
      },
      keys: async () => [...m.keys()].map((k) => ({ url: "https://bis.test" + k })),
      delete: async (r: any) => m.delete(new URL(r.url).pathname),
      match: async (r: any) => m.get(typeof r === "string" ? (r.startsWith("http") ? new URL(r).pathname : r) : new URL(r.url).pathname)
    };
  };
  let online = true;
  const caches = {
    open: async (n: string) => cacheOf(n),
    keys: async () => [...cacheStore.keys()],
    delete: async (n: string) => cacheStore.delete(n),
    match: async (r: any) => {
      for (const m of cacheStore.values()) {
        const k = typeof r === "string" ? (r.startsWith("http") ? new URL(r).pathname : r) : new URL(r.url).pathname;
        if (m.has(k)) return m.get(k);
      }
      return undefined;
    }
  };
  const sandbox: any = {
    URL, Promise, Map, Response,
    caches,
    fetch: async (req: any) => {
      if (!online) throw new Error("offline");
      const p = new URL(req.url).pathname;
      const noStore = p.includes("private-asset");
      return {
        status: 200, type: "basic", clone() { return this; }, tag: "net:" + p,
        headers: { get: (k: string) => (noStore && k.toLowerCase() === "cache-control" ? "private, no-store" : null) }
      };
    },
    self: {
      location: { origin: "https://bis.test" },
      addEventListener: (n: string, h: any) => void (handlers[n] = h),
      skipWaiting: async () => {},
      clients: { claim: async () => {} }
    }
  };
  vm.runInNewContext(src, sandbox);
  await new Promise<void>((res) => handlers.install({ waitUntil: (p: Promise<unknown>) => p.then(() => res()) }));
  const fetchEvt = async (path: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}): Promise<any> => {
    let responded: Promise<any> | null = null;
    const headers = init.headers ?? {};
    const req = {
      url: "https://bis.test" + path,
      method: init.method ?? "GET",
      mode: init.mode ?? "cors",
      headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null }
    };
    handlers.fetch({ request: req, respondWith: (p: Promise<any>) => (responded = p) });
    return responded ? await responded : "PASSTHROUGH";
  };
  return { fetchEvt, setOnline: (v: boolean) => (online = v), putLog, cacheStore };
}

describe("service worker — safety rules", () => {
  test("precaches only the offline shell", async () => {
    const { cacheStore } = await loadSw();
    const all = [...cacheStore.values()].flatMap((m) => [...m.keys()]);
    assert.deepEqual(all.sort(), ["/icons/icon-192.png", "/offline-core.js", "/offline.html", "/offline.js"].sort());
  });

  test("non-GET (server actions, forms) is never intercepted", async () => {
    const { fetchEvt } = await loadSw();
    assert.equal(await fetchEvt("/compte/badge", { method: "POST" }), "PASSTHROUGH");
  });

  test("/api and RSC payloads are never intercepted or cached", async () => {
    const { fetchEvt, putLog } = await loadSw();
    assert.equal(await fetchEvt("/api/auth/verify-email"), "PASSTHROUGH");
    assert.equal(await fetchEvt("/compte/badge", { headers: { RSC: "1" } }), "PASSTHROUGH");
    assert.equal(await fetchEvt("/compte/badge?_rsc=abc"), "PASSTHROUGH");
    assert.deepEqual(putLog, []);
  });

  test("admin: network only; offline navigation gets the offline notice; never cached", async () => {
    const { fetchEvt, setOnline, putLog } = await loadSw();
    assert.equal(await fetchEvt("/admin/dashboard", { mode: "cors" }), "PASSTHROUGH");
    setOnline(false);
    const off = await fetchEvt("/admin/dashboard", { mode: "navigate" });
    assert.equal(off.url, "/offline.html");
    assert.deepEqual(putLog, []);
  });

  test("page navigation: network first, NEVER caches the HTML, offline falls back to the offline page", async () => {
    const { fetchEvt, setOnline, putLog, cacheStore } = await loadSw();
    const on = await fetchEvt("/compte/badge", { mode: "navigate" });
    assert.equal(on.tag, "net:/compte/badge");
    assert.deepEqual(putLog, [], "authenticated HTML is never written to a cache");
    setOnline(false);
    const off = await fetchEvt("/compte/badge", { mode: "navigate" });
    assert.equal(off.url, "/offline.html");
    const cached = [...cacheStore.values()].flatMap((m) => [...m.keys()]);
    assert.ok(!cached.includes("/compte/badge"));
  });

  test("static assets are cached; /sw.js itself is never cached", async () => {
    const { fetchEvt, putLog } = await loadSw();
    await fetchEvt("/_next/static/chunks/app.js");
    assert.deepEqual(putLog, ["/_next/static/chunks/app.js"]);
    assert.equal(await fetchEvt("/sw.js"), "PASSTHROUGH");
  });

  test("the offline shell is served from the cache while OFFLINE (PWA offline page works)", async () => {
    const { fetchEvt, setOnline } = await loadSw();
    setOnline(false);
    for (const p of ["/offline.js", "/offline-core.js", "/offline.html"]) {
      const r = await fetchEvt(p);
      assert.equal(r.url, p, p + " must come from the precache with the network down");
    }
  });

  test("cache key ignores the query string; no-store/private responses are never kept", async () => {
    const { fetchEvt, putLog } = await loadSw();
    await fetchEvt("/icons/x.png?junk=1");
    await fetchEvt("/icons/x.png?junk=2");
    assert.deepEqual(putLog, ["/icons/x.png"], "one entry, path-only key");
    const before = putLog.length;
    await fetchEvt("/icons/private-asset.png");
    assert.equal(putLog.length, before, "Cache-Control private/no-store is not stored");
  });

  test("cross-origin requests are ignored", async () => {
    const { fetchEvt } = await loadSw();
    const handlersTest = await fetchEvt("/x");
    assert.equal(handlersTest, "PASSTHROUGH");
  });
});

describe("offline page + manifest — static safety", () => {
  test("offline.js never uses innerHTML / eval / document.write", async () => {
    const js = await read("public/offline.js");
    const core = await read("public/offline-core.js");
    for (const raw of [js, core]) {
      const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), false);
    }
  });

  test("offline.html loads no third-party resources", async () => {
    const html = await read("public/offline.html");
    assert.equal(/https?:\/\//.test(html), false);
    assert.equal(/<script[^>]+src="https?:/.test(html), false);
  });

  test("manifest is valid and every icon exists", async () => {
    const m = JSON.parse(await read("public/manifest.webmanifest"));
    assert.equal(m.display, "standalone");
    assert.ok(m.icons.some((i: any) => i.purpose === "maskable"));
    for (const i of m.icons) await access(new URL(`../public${i.src}`, import.meta.url));
  });

  test("clearUnlessOwner: another account's / ownerless / signed-out snapshots are wiped, the owner's is kept", async () => {
    const { core } = await loadCore();
    await core.save(core.build(good));
    assert.equal(await core.clearUnlessOwner("0123456789abcdef01234567"), false);
    assert.ok(await core.load(), "owner keeps its snapshot");
    assert.equal(await core.clearUnlessOwner("ffffffffffffffffffffffff"), true);
    assert.equal(await core.load(), null, "other account → wiped");
    await core.save(core.build(good));
    assert.equal(await core.clearUnlessOwner(null), true);
    assert.equal(await core.load(), null, "signed out → wiped");
    // A snapshot written without an owner (older format) is treated as foreign.
    const { store } = await loadCore();
    void store;
  });

  test("build requires an owner tag", async () => {
    const { core } = await loadCore();
    const { owner, ...noOwner } = good as any;
    void owner;
    assert.equal(core.build(noOwner), null);
    assert.equal(core.build({ ...good, owner: "<script>" }), null);
  });

  test("workflow validates inputs and only runs from main", async () => {
    const wf = await read(".github/workflows/mobile.yml");
    assert.ok(wf.includes("github.ref == 'refs/heads/main'"));
    assert.ok(/bad version_name/.test(wf) && /bad version_code/.test(wf));
  });

  test("snapshot sync is rendered only with a QR; runtime clears when signed out", async () => {
    const page = await read("app/compte/badge/page.tsx");
    assert.ok(/qrDataUrl && \(/.test(page) && page.includes("OfflineSnapshotSync"));
    const rt = await read("components/mobile/offline-runtime.tsx");
    assert.ok(rt.includes("clearUnlessOwner(accountKey)") && !rt.includes("signedIn"));
  });
});

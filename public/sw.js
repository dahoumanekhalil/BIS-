/*
 * BIS 2027 service worker — deliberately MINIMAL and SAFE.
 *
 * It caches ONLY public static assets and the offline page. It never stores
 * HTML of pages, API responses, server-action requests, RSC payloads or
 * anything under /admin — so a shared device cannot leak an authenticated
 * page from the cache, and the admin console stays online-only.
 *
 * Offline navigation: the browser asks for a page, the network fails, and we
 * answer with the precached /offline.html (same URL), which renders the
 * participant's saved badge snapshot (see offline-core.js).
 */
// Bump VERSION whenever /icons/* or the offline shell files change.
var VERSION = "bis-sw-v2";
var STATIC_CACHE = VERSION + "-static";
var PRECACHE = ["/offline.html", "/offline.js", "/offline-core.js", "/icons/icon-192.png"];

// Paths that must NEVER be served from / written to a cache.
function isNeverCache(url) {
  var p = url.pathname;
  return (
    p.indexOf("/admin") === 0 ||
    p.indexOf("/api/") === 0 ||
    p === "/sw.js" ||
    p.indexOf("/_next/data/") === 0
  );
}

// Exact files that make the offline page work (precached at install).
var OFFLINE_SHELL = {
  "/offline.html": 1,
  "/offline.js": 1,
  "/offline-core.js": 1,
  "/icons/icon-192.png": 1
};

var MAX_ENTRIES = 120;

function trimCache(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= MAX_ENTRIES) return;
    var extra = keys.length - MAX_ENTRIES;
    // Never evict the offline shell.
    var victims = keys.filter(function (k) {
      return !OFFLINE_SHELL[new URL(k.url).pathname];
    }).slice(0, extra);
    return Promise.all(victims.map(function (k) { return cache.delete(k); }));
  });
}

function isStaticAsset(url) {
  var p = url.pathname;
  return (
    p.indexOf("/_next/static/") === 0 ||
    p.indexOf("/icons/") === 0 ||
    /\.(?:png|jpg|jpeg|webp|avif|svg|ico|woff2?)$/i.test(p)
  );
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k.indexOf("bis-sw-") === 0 && k !== STATIC_CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return; // server actions / forms: always network
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) {
    // Admin / API: network only. Offline navigations to /admin get the
    // offline notice page; everything else just fails normally.
    if (req.mode === "navigate" && url.pathname.indexOf("/admin") === 0) {
      event.respondWith(fetch(req).catch(function () { return caches.match("/offline.html"); }));
    }
    return;
  }

  // RSC / Flight requests are fetches to page URLs — never cache or fake them.
  if (req.headers.get("RSC") || url.searchParams.has("_rsc")) return;

  if (req.mode === "navigate") {
    // Network first, NEVER cache the HTML. Offline fallback only.
    event.respondWith(
      fetch(req).catch(function () { return caches.match("/offline.html"); })
    );
    return;
  }

  // The offline shell must work with the network down: exact paths only.
  if (OFFLINE_SHELL[url.pathname]) {
    event.respondWith(
      caches.match(url.pathname).then(function (hit) { return hit || fetch(req); })
    );
    return;
  }

  if (isStaticAsset(url)) {
    // Cache-first for immutable/public assets. The cache key is the PATH only
    // (query strings are ignored so junk URLs cannot fill the cache), only
    // OK same-origin responses are stored, and responses that forbid storage
    // (no-store / private) are never kept.
    var key = url.origin + url.pathname;
    event.respondWith(
      caches.match(key).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          var cc = (res && res.headers && res.headers.get && res.headers.get("Cache-Control")) || "";
          if (res && res.status === 200 && res.type === "basic" && !res.redirected && !/no-store|private/i.test(cc)) {
            var copy = res.clone();
            caches.open(STATIC_CACHE).then(function (c) {
              return c.put(key, copy).then(function () { return trimCache(c); });
            });
          }
          return res;
        });
      })
    );
  }
});

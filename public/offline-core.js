/*
 * BIS 2027 — offline snapshot core (shared by the website, the PWA and the
 * native app). Plain ES5-compatible JS so it can be served as a static file,
 * loaded in the Capacitor local offline page, AND required from Node tests.
 *
 * WHAT IT STORES: the participant's own display data needed to show their
 * badge and profile offline — name, organisation, role label, the QR IMAGE
 * (data URL), the text fallback code, and a few profile lines (email, phone,
 * country, participation, registration status), plus the sync time. Nothing
 * else. Never admin data, never passwords, tokens or internal ids.
 *
 * RULES (enforced here, covered by scripts/mobile-offline.test.ts):
 *  • strict shape validation on read AND write (a corrupted / tampered value is
 *    ignored, never rendered as HTML — the renderer uses textContent only);
 *  • the QR must be a PNG data URL of bounded size;
 *  • a snapshot expires after MAX_AGE_MS and is then NOT shown (hidden, not
 *    just warned): an admin may have regenerated the QR meanwhile;
 *  • cleared on logout / when the site is opened signed-out.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BISOffline = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  var KEY = "bis.offline.snapshot.v1";
  var VERSION = 1;
  var MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  var STALE_AFTER_MS = 24 * 60 * 60 * 1000; // warn after 1 day
  var MAX_QR_CHARS = 200 * 1024; // PNG data URL cap
  var QR_PREFIX = "data:image/png;base64,";

  function str(v, max) {
    return typeof v === "string" && v.length <= max ? v : null;
  }

  // Optional display line: bounded, no markup characters; invalid → null
  // (an optional field can never invalidate the whole snapshot).
  function line(v, max, re) {
    var s = str(v, max);
    if (s === null || s === "") return null;
    if (/[<>]/.test(s)) return null;
    if (re && !re.test(s)) return null;
    return s;
  }

  // Returns a clean snapshot or null. Never throws.
  function validate(raw) {
    try {
      var o = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!o || typeof o !== "object" || o.v !== VERSION) return null;
      var firstName = str(o.firstName, 80);
      var lastName = str(o.lastName, 80);
      var qr = str(o.qrDataUrl, MAX_QR_CHARS);
      var syncedAt = str(o.syncedAt, 40);
      if (!firstName || !lastName || !qr || !syncedAt) return null;
      if (qr.indexOf(QR_PREFIX) !== 0) return null;
      if (!/^[A-Za-z0-9+/=]+$/.test(qr.slice(QR_PREFIX.length))) return null;
      var t = Date.parse(syncedAt);
      if (!isFinite(t)) return null;
      var owner = o.owner == null ? null : str(o.owner, 40);
      if (o.owner != null && (owner === null || !/^[a-f0-9]{8,40}$/.test(owner))) return null;
      var code = o.checkinCode == null ? null : str(o.checkinCode, 32);
      if (o.checkinCode != null && code === null) return null;
      if (code !== null && !/^[A-Z0-9-]{0,32}$/.test(code)) return null;
      return {
        v: VERSION,
        firstName: firstName,
        lastName: lastName,
        organization: o.organization == null ? null : str(o.organization, 120),
        jobTitle: o.jobTitle == null ? null : str(o.jobTitle, 120),
        roleLabel: o.roleLabel == null ? null : str(o.roleLabel, 40),
        email: line(o.email, 160, /^[^\s@]+@[^\s@]+$/),
        phone: line(o.phone, 32, /^[0-9+()\s.-]+$/),
        country: line(o.country, 60),
        participationLabel: line(o.participationLabel, 60),
        statusLabel: line(o.statusLabel, 60),
        qrDataUrl: qr,
        checkinCode: code,
        owner: owner,
        syncedAt: new Date(t).toISOString()
      };
    } catch (e) {
      return null;
    }
  }

  function build(input, now) {
    var n = now instanceof Date ? now : new Date();
    if (!input || typeof input.owner !== "string") return null; // owner required
    return validate({
      v: VERSION,
      firstName: input.firstName,
      lastName: input.lastName,
      organization: input.organization,
      jobTitle: input.jobTitle,
      roleLabel: input.roleLabel,
      email: input.email,
      phone: input.phone,
      country: input.country,
      participationLabel: input.participationLabel,
      statusLabel: input.statusLabel,
      qrDataUrl: input.qrDataUrl,
      checkinCode: input.checkinCode,
      owner: input.owner,
      syncedAt: n.toISOString()
    });
  }

  // fresh | stale (usable, with a warning) | expired (must NOT be shown)
  function evaluate(snapshot, now) {
    if (!snapshot) return { state: "none", ageMs: 0 };
    var age = (now instanceof Date ? now : new Date()).getTime() - Date.parse(snapshot.syncedAt);
    if (age < 0) age = 0; // clock moved backwards: treat as just synced
    if (age > MAX_AGE_MS) return { state: "expired", ageMs: age };
    if (age > STALE_AFTER_MS) return { state: "stale", ageMs: age };
    return { state: "fresh", ageMs: age };
  }

  // ── storage adapter: native Preferences (via the Capacitor bridge) or localStorage ──
  function nativePrefs() {
    try {
      var c = root.Capacitor;
      if (c && typeof c.isNativePlatform === "function" && c.isNativePlatform()) {
        var p = c.Plugins && c.Plugins.Preferences;
        if (p && typeof p.get === "function") return p;
      }
    } catch (e) {}
    return null;
  }

  function storage() {
    var p = nativePrefs();
    if (p) {
      return {
        get: function () {
          return p.get({ key: KEY }).then(function (r) { return r && r.value ? r.value : null; });
        },
        set: function (v) { return p.set({ key: KEY, value: v }); },
        remove: function () { return p.remove({ key: KEY }); }
      };
    }
    return {
      get: function () {
        try { return Promise.resolve(root.localStorage.getItem(KEY)); }
        catch (e) { return Promise.resolve(null); }
      },
      set: function (v) {
        try { root.localStorage.setItem(KEY, v); } catch (e) {}
        return Promise.resolve();
      },
      remove: function () {
        try { root.localStorage.removeItem(KEY); } catch (e) {}
        return Promise.resolve();
      }
    };
  }

  function save(snapshot) {
    var clean = validate(snapshot);
    if (!clean) return Promise.resolve(false);
    return storage().set(JSON.stringify(clean)).then(function () { return true; });
  }

  function load() {
    return storage().get().then(function (raw) {
      var s = raw ? validate(raw) : null;
      if (raw && !s) return storage().remove().then(function () { return null; });
      return s;
    });
  }

  function clear() {
    return storage().remove();
  }

  // Wipes the stored snapshot unless it belongs to `ownerKey` (a one-way tag
  // of the CURRENT account). Called on every page load by the site, so a badge
  // saved for another account never survives. ownerKey === null means "nobody
  // is signed in" → always wipe. A snapshot without an owner is treated as
  // foreign and wiped.
  function clearUnlessOwner(ownerKey) {
    return storage().get().then(function (raw) {
      if (!raw) return false;
      var s = validate(raw);
      if (!s || !ownerKey || s.owner !== ownerKey) {
        return storage().remove().then(function () { return true; });
      }
      return false;
    });
  }

  return {
    KEY: KEY,
    VERSION: VERSION,
    MAX_AGE_MS: MAX_AGE_MS,
    STALE_AFTER_MS: STALE_AFTER_MS,
    validate: validate,
    build: build,
    evaluate: evaluate,
    save: save,
    load: load,
    clear: clear,
    clearUnlessOwner: clearUnlessOwner
  };
});

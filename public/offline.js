/*
 * Renders the offline badge page. SECURITY: every dynamic value goes through
 * textContent / the img.src of a validated PNG data URL — never innerHTML.
 * The data comes only from BISOffline.load() (strictly validated).
 */
(function () {
  "use strict";
  var core = window.BISOffline;
  function $(id) { return document.getElementById(id); }
  function show(id, on) { $(id).classList.toggle("hidden", !on); }

  var path = (window.location && window.location.pathname) || "/";
  var isAdminContext = path.indexOf("/admin") === 0;
  show("admin-note", isAdminContext);

  $("retry").addEventListener("click", function () {
    // Back to the app root; the network layer decides what to show.
    window.location.href = isAdminContext ? "/admin" : "/compte/badge";
  });

  function renderNone(expired) {
    show("badge", false);
    show("none", true);
    $("none-title").textContent = expired
      ? "Badge à actualiser"
      : "Aucun badge enregistré";
    $("none-text").textContent = expired
      ? "Votre badge hors ligne a expiré par sécurité. Connectez-vous à Internet puis ouvrez « Mon badge » pour le réactiver."
      : "Connectez-vous à Internet, ouvrez « Mon badge » une première fois : il sera ensuite disponible hors ligne sur cet appareil.";
  }

  function fmt(iso) {
    try {
      return new Date(iso).toLocaleString("fr-FR", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
      });
    } catch (e) { return iso; }
  }

  core.load().then(function (snap) {
    var ev = core.evaluate(snap, new Date());
    if (!snap || ev.state === "none") return renderNone(false);
    if (ev.state === "expired") {
      // Hidden, not just warned: the QR may have been replaced by an admin.
      return core.clear().then(function () { renderNone(true); });
    }
    show("none", false);
    show("badge", true);
    $("role").textContent = snap.roleLabel || "Participant";
    $("name").textContent = snap.firstName + " " + snap.lastName;
    var org = [snap.jobTitle, snap.organization].filter(Boolean).join(" · ");
    $("org").textContent = org;
    show("org", !!org);
    $("qr").src = snap.qrDataUrl; // validated PNG data URL
    $("code").textContent = snap.checkinCode || "";
    show("code", !!snap.checkinCode);
    $("synced").textContent = "Dernière mise à jour : " + fmt(snap.syncedAt);
    show("stale", ev.state === "stale");

    // Profile lines (only the ones present). textContent only.
    var rows = [
      ["Email", snap.email],
      ["Téléphone", snap.phone],
      ["Pays", snap.country],
      ["Participation", snap.participationLabel],
      ["Inscription", snap.statusLabel]
    ].filter(function (r) { return !!r[1]; });
    var list = $("profile-list");
    while (list.firstChild) list.removeChild(list.firstChild);
    rows.forEach(function (r) {
      var wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid #E6E8ED;font-size:13px";
      var dt = document.createElement("dt");
      dt.style.cssText = "color:#55606f";
      dt.textContent = r[0];
      var dd = document.createElement("dd");
      dd.style.cssText = "margin:0;font-weight:700;text-align:right;word-break:break-word";
      dd.textContent = r[1];
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      list.appendChild(wrap);
    });
    show("profile", rows.length > 0);
  });
})();

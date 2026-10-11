/* Souffle — app. Local d'abord (localStorage), synchronisée avec Supabase quand connecté. */
(function () {
  "use strict";
  const P = window.Souffle, B = window.SouffleBackend;
  const KEY = "souffle.state.v1";
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");

  // ---------- état ----------
  const tzNow = -new Date().getTimezoneOffset();
  let S = load();
  if (S.settings.tzOffset !== tzNow) { S.settings.tzOffset = tzNow; S.updatedAt = Date.now(); saveLocal(); }
  let view = P.dayKey(Date.now(), S.settings.tzOffset);
  let syncTimer = null;

  function blank() { return { settings: { ...P.DEFAULTS, tzOffset: tzNow }, log: {}, bilanSeen: "", updatedAt: 0 }; }
  function normalize(s) { const b = blank(); return { ...b, ...s, settings: { ...b.settings, ...((s && s.settings) || {}) }, log: { ...((s && s.log) || {}) } }; }
  function load() { try { const r = localStorage.getItem(KEY); if (r) return normalize(JSON.parse(r)); } catch (e) {} return blank(); }
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function commit() {
    S.updatedAt = Date.now(); saveLocal();
    clearTimeout(syncTimer);
    if (B.configured && B.connected) syncTimer = setTimeout(() => B.putState(S).catch(() => {}), 700);
  }
  async function pull() {
    if (!B.configured || !B.connected) return;
    try {
      const remote = await B.getState();
      if (remote && (remote.updatedAt || 0) > (S.updatedAt || 0)) { const tz = S.settings.tzOffset; S = normalize(remote); S.settings.tzOffset = tz; saveLocal(); render(); maybeBilan(); }
      else if (!remote || (S.updatedAt || 0) > (remote.updatedAt || 0)) await B.putState(S);
    } catch (e) { /* hors ligne : on garde le local */ }
  }

  const st = () => S.settings;
  function todayKey() { return P.dayKey(Date.now(), st().tzOffset); }
  const minsNow = (k) => P.minutesInto(k, Date.now(), st().tzOffset);
  const logOf = (k) => S.log[k] || [];
  const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${pad(Math.round(m % 60))}` : `${Math.max(1, Math.round(m))} min`);
  const dateLabel = (k, opt) => P.parse(k).toLocaleDateString("fr-FR", { timeZone: "UTC", ...opt });
  const stampMin = (k, ms) => P.minutesInto(k, ms, st().tzOffset);

  // ---------- actions ----------
  function smoke() {
    const k = view, arr = (S.log[k] = logOf(k).slice());
    const isToday = k === todayKey();
    let ms = Date.now();
    if (!isToday) { // jour passé : on horodate à l'heure idéale du créneau
      const q = P.quota(st(), k), times = P.idealTimes(st(), Math.max(q, arr.length + 1));
      ms = P.parse(k).getTime() - st().tzOffset * 6e4 + times[Math.min(arr.length, times.length - 1)] * 6e4;
    }
    arr.push(ms); commit(); render();
    const c = $("count"); c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop");
    if (navigator.vibrate) navigator.vibrate(12);
  }
  function undo() { const arr = logOf(view).slice(); if (!arr.length) return; arr.pop(); S.log[view] = arr; commit(); render(); }
  function toggleSlot(i) { if (i < logOf(view).length) undo(); else smoke(); }

  // ---------- rendu : aujourd'hui ----------
  function render() {
    const s = st(), tk = todayKey(), k = view, isToday = k === tk;
    const q = P.quota(s, k), n = logOf(k).length;
    const zero = P.zeroDate(s), left = Math.max(0, P.diffDays(tk, zero));
    $("countdown").innerHTML = left > 0 ? `<b class="num">J-${left}</b> · zéro le ${dateLabel(zero, { day: "numeric", month: "short" })}` : `<b>Phase zéro</b>`;

    const dn = P.diffDays(s.startDate, k) + 1;
    $("dayTitle").innerHTML = (isToday ? "Aujourd'hui" : dateLabel(k, { weekday: "long", day: "numeric", month: "short" })) +
      `<small>${isToday ? dateLabel(k, { weekday: "long", day: "numeric", month: "long" }) + " · " : ""}${dn >= 1 ? "jour " + dn : "avant le plan"}</small>`;
    $("prev").disabled = k <= P.addDays(s.startDate, -1);
    $("next").disabled = k >= tk;

    // anneau
    const arc = $("ringArc"), C = 364.4, frac = q > 0 ? Math.min(1, n / q) : n > 0 ? 1 : 0;
    arc.style.strokeDashoffset = String(C * (1 - frac));
    arc.style.stroke = n > q ? "var(--over)" : "var(--accent)";
    $("count").textContent = n;
    $("of").textContent = `sur ${q}`;

    // prochaine
    const times = P.schedule(s, q, logOf(k).map((ms) => stampMin(k, ms)).sort((a, b) => a - b));
    let html = "";
    const pill = n > q ? `<span class="pill over">+${n - q} hors quota</span>` : q > 0 && n === q ? `<span class="pill full">Quota atteint</span>` : `<span class="pill">Reste ${q - n}</span>`;
    if (!isToday) html = `<div class="label">Bilan</div><div class="time">${n <= q ? "Tenu" : "Dépassé"}</div><div class="in">${n} fumée${n > 1 ? "s" : ""} pour un quota de ${q}</div>`;
    else if (q === 0 && n === 0) html = `<div class="label">Objectif</div><div class="time">Zéro</div><div class="in">Aucune aujourd'hui. Tiens bon.</div>`;
    else if (n >= q) html = `<div class="label">Prochaine</div><div class="time">Demain</div><div class="in">${n > q ? "Plus rien jusqu'au coucher." : "Tu as tout utilisé. On tient jusqu'au coucher."}</div>`;
    else {
      const t = times[n], wait = t - minsNow(k);
      html = `<div class="label">Prochaine autorisée</div><div class="time mono">${P.fmtMin(t)}</div><div class="in">${wait > 0 ? "dans " + fmtDur(wait) : "possible maintenant"}</div>`;
    }
    $("nextBox").innerHTML = html + pill;
    $("smokeLbl").textContent = isToday ? "J'en fume une" : "Ajouter une cigarette";
    $("undo").disabled = n === 0;

    // créneaux
    const log = logOf(k), box = $("slots"); box.innerHTML = "";
    const nowM = isToday ? minsNow(k) : -1;
    times.forEach((t, i) => {
      const done = i < n;
      const b = document.createElement("button");
      b.className = "slot" + (done ? " done" : "") + (isToday && !done && i === n ? " next" : "");
      b.innerHTML = `<span class="e">🚬</span><span class="t">${done ? P.fmtMin(stampMin(k, log[i])) : P.fmtMin(t)}</span>`;
      b.setAttribute("aria-label", done ? `Fumée à ${P.fmtMin(stampMin(k, log[i]))}, toucher pour annuler` : `Prévue à ${P.fmtMin(t)}`);
      b.onclick = () => toggleSlot(i);
      box.appendChild(b);
    });
    const over = Math.max(0, n - q), extras = Math.max(2, over + 1);
    const h = document.createElement("div"); h.className = "extra-h"; h.textContent = "Hors quota"; box.appendChild(h);
    for (let j = 0; j < extras; j++) {
      const i = q + j, done = i < n;
      const b = document.createElement("button");
      b.className = "slot extra" + (done ? " done" : "");
      b.innerHTML = `<span class="e">🚬</span><span class="t">${done ? P.fmtMin(stampMin(k, log[i])) : "+" + (j + 1)}</span>`;
      b.setAttribute("aria-label", done ? "Hors quota, toucher pour annuler" : "Ajouter hors quota");
      b.onclick = () => toggleSlot(i);
      box.appendChild(b);
    }
    $("planSub").textContent = q > 0 ? `${q} max · demain ${P.quota(s, P.addDays(k, 1))}` : "zéro";

    // conseil du moment
    const tips = [
      ["⏱️", "Une envie dure 3 à 5 minutes. Laisse-la passer : eau, 10 respirations lentes, tu bouges."],
      ["☕", "Café et cigarette vont ensemble par habitude. Change de place ou de boisson au moment où l'envie arrive."],
      ["🚶", "Après un repas, marche 5 minutes au lieu d'allumer : c'est le moment le plus dur, pas le plus long."],
      ["🧊", "Garde les mains et la bouche occupées : chewing-gum, eau gazeuse glacée, cure-dent."],
      ["📉", "Le plan baisse d'environ une cigarette tous les 4 à 5 jours. Ton corps s'adapte à chaque palier."],
      ["🏋️", "Le monoxyde de carbone baisse ton oxygénation à l'entraînement. Chaque cigarette en moins se sent à la salle."],
    ];
    const tip = tips[P.diffDays("2026-01-01", k) % tips.length];
    $("tip").innerHTML = `<span>${tip[0]}</span><span>${tip[1]}</span>`;

    renderPath();
  }

  // ---------- rendu : parcours ----------
  function renderPath() {
    const s = st(), tk = todayKey(), y = P.addDays(tk, -1);
    const tot = P.totals(S, y);
    $("tSaved").textContent = P.money(tot.saved, s);
    $("tAvoided").textContent = tot.avoided.toLocaleString("fr-FR");
    $("tStreak").textContent = y >= s.startDate ? P.streak(S, y) : 0;
    $("tLife").textContent = tot.lifeHours >= 48 ? (tot.lifeHours / 24).toFixed(1).replace(".", ",") + " j" : Math.round(tot.lifeHours) + " h";

    // graphique
    const end = P.zeroDate(s), N = Math.max(1, P.diffDays(s.startDate, end) + 1);
    const W = 440, H = 170, L = 26, R = 6, T = 10, Bt = 24, base = H - Bt;
    const maxV = Math.max(s.start, ...Object.keys(S.log).map((k) => logOf(k).length), 1);
    const yMax = Math.ceil(maxV / 5) * 5;
    const bw = (W - L - R) / N, sy = (v) => ((base - T) * v) / yMax;
    let o = "";
    for (let v = 0; v <= yMax; v += yMax > 10 ? 5 : 2) {
      const yy = base - sy(v);
      o += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="${v === 0 ? 1.2 : 0.6}"/>`;
      o += `<text x="${L - 6}" y="${yy + 3.5}" text-anchor="end" font-size="10" fill="var(--faint)" font-family="Geist Mono, monospace">${v}</text>`;
    }
    for (let d = 0; d < N; d++) {
      const k = P.addDays(s.startDate, d), q = P.quota(s, k), x = L + d * bw + 0.6, w = Math.max(1, bw - 1.2);
      o += `<rect x="${x}" y="${base - sy(q)}" width="${w}" height="${sy(q)}" fill="var(--line)" rx="1"/>`;
      if (k <= tk && (k < tk || S.log[k])) {
        const n = logOf(k).length;
        if (n > 0) o += `<rect x="${x + w * 0.2}" y="${base - sy(n)}" width="${w * 0.6}" height="${sy(n)}" fill="${n > q ? "var(--over)" : "var(--accent)"}" rx="1"/>`;
      }
      if (k === tk) o += `<line x1="${x + w / 2}" x2="${x + w / 2}" y1="${T}" y2="${base}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="2 3"/>`;
    }
    const lab = (k) => dateLabel(k, { day: "numeric", month: "short" });
    o += `<text x="${L}" y="${H - 6}" font-size="11" fill="var(--muted)" font-family="Geist, sans-serif">${lab(s.startDate)}</text>`;
    o += `<text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--accent)" font-weight="600" font-family="Geist, sans-serif">0 le ${lab(end)}</text>`;
    $("chart").innerHTML = o;
    $("chartSub").textContent = `${s.start} → 0 en ${N - 1} jours`;

    // paliers
    const marks = [15, 10, 5, 1, 0].filter((m) => m < s.start);
    const firstAt = (m) => { let k = s.startDate; for (let i = 0; i < 2000 && P.quota(s, k) > m; i++) k = P.addDays(k, 1); return k; };
    let cur = false;
    $("steps").innerHTML = marks.map((m) => {
      const k = firstAt(m), passed = k <= tk, isCur = !passed && !cur; if (isCur) cur = true;
      const label = m === 0 ? "Zéro cigarette" : m === 1 ? "1 par jour" : `${m} par jour`;
      return `<li class="${passed ? "passed" : isCur ? "cur" : ""}"><b>${label}</b><span>${passed ? "atteint le " : ""}${dateLabel(k, { weekday: "short", day: "numeric", month: "short" })}</span></li>`;
    }).join("");
  }

  // ---------- bilan du matin ----------
  function maybeBilan(force) {
    const s = st(), tk = todayKey(), y = P.addDays(tk, -1);
    if (y < s.startDate) { if (force) toastSheet("Pas encore de bilan", "Le premier bilan arrive demain matin, sur la journée d'aujourd'hui."); return; }
    if (!force && (S.bilanSeen === tk || minsNow(tk) < P.toMin(s.wake) - 120)) return;
    const r = P.report(S, y, tk);
    S.bilanSeen = tk; commit();
    const money = r.saved ? `<div class="money"><div><b class="num">${r.saved.dayTxt}</b><span>hier</span></div><div><b class="num">${r.saved.monthTxt}</b><span>par mois à ce rythme</span></div><div><b class="num">${r.saved.yearTxt}</b><span>par an à ce rythme</span></div></div>` : "";
    openSheet(`
      <div class="kicker">Bilan d'hier · ${dateLabel(y, { weekday: "long", day: "numeric", month: "long" })}</div>
      <h2>${r.headline}</h2>
      <div class="score"><b class="num">${r.n} / ${r.q}</b>${r.ok && r.streak > 1 ? `<span>· ${r.streak} jours de suite dans le quota 🔥</span>` : ""}</div>
      ${money}
      <ul class="health">${r.health.map((h) => `<li><span>${h[0]}</span><span>${h[1]}</span></li>`).join("")}</ul>
      <p class="closing">${r.closing}</p>
      <button class="primary" data-close>${r.ok ? "C'est parti" : "On repart"}</button>`);
  }
  function openSheet(inner) {
    const el = $("sheet");
    el.innerHTML = `<div class="scrim" data-close><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${inner}</div></div>`;
    el.querySelectorAll("[data-close]").forEach((x) => x.addEventListener("click", (e) => { if (e.target === x) closeSheet(); }));
  }
  function closeSheet() { $("sheet").innerHTML = ""; }
  function toastSheet(t, p) { openSheet(`<h2>${t}</h2><p class="note" style="font-size:15px">${p}</p><button class="primary" data-close>OK</button>`); }

  // ---------- réglages ----------
  function fillForm() {
    const s = st();
    $("fStart").value = s.start; $("fStartDate").value = s.startDate; $("fEndDate").value = s.endDate;
    $("fPrice").value = s.packPrice; $("fPack").value = s.packSize; $("fCur").value = s.currency;
    $("fWake").value = s.wake; $("fSleep").value = s.sleep;
    const z = P.zeroDate(s);
    $("planNote").textContent = `Descente de ${s.start} à 0 : environ −1 tous les ${Math.max(1, Math.round(P.diffDays(s.startDate, s.endDate) / s.start))} jours. Zéro atteint le ${dateLabel(z, { day: "numeric", month: "long", year: "numeric" })}. Avance la date limite pour aller plus vite.`;
  }
  $("save").onclick = () => {
    const s = st();
    s.start = Math.max(1, Math.round(+$("fStart").value) || s.start);
    if ($("fStartDate").value) s.startDate = $("fStartDate").value;
    if ($("fEndDate").value && $("fEndDate").value > s.startDate) s.endDate = $("fEndDate").value;
    s.packPrice = Math.max(0, +$("fPrice").value || 0);
    s.packSize = Math.max(1, Math.round(+$("fPack").value) || 20);
    s.currency = $("fCur").value.trim() || s.currency;
    if ($("fWake").value) s.wake = $("fWake").value;
    if ($("fSleep").value) s.sleep = $("fSleep").value;
    commit(); fillForm(); render();
    $("planNote").insertAdjacentHTML("afterbegin", `<span class="ok">Enregistré. </span>`);
  };

  // ---------- notifications push ----------
  const b64 = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
  const pushNote = (t, cls) => { $("pushNote").innerHTML = cls ? `<span class="${cls}">${t}</span>` : t; };
  async function pushState() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return pushNote("Sur iPhone : ouvre l'app depuis l'écran d'accueil (Safari → Partager → Sur l'écran d'accueil) pour activer les notifications.");
    if (!B.connected) return pushNote("Connecte-toi (section Compte) pour recevoir les notifications.");
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    $("pushOn").textContent = sub ? "Désactiver" : "Activer";
    pushNote(sub ? "Activées sur cet appareil." : Notification.permission === "denied" ? "Refusées dans les réglages du téléphone. Réglages → Notifications → Souffle." : "Désactivées sur cet appareil.", sub ? "ok" : "");
  }
  $("pushOn").onclick = async () => {
    try {
      if (!B.connected) return openLogin();
      const reg = await navigator.serviceWorker.ready; const cur = await reg.pushManager.getSubscription();
      if (cur) { await B.deletePushSub(cur.endpoint).catch(() => {}); await cur.unsubscribe(); return pushState(); }
      if ((await Notification.requestPermission()) !== "granted") return pushNote("Permission refusée.", "err");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(window.SOUFFLE_CONFIG.vapidPublicKey) });
      const j = sub.toJSON();
      await B.savePushSub({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) });
      await B.putState(S).catch(() => {});
      pushState();
    } catch (e) { pushNote("Impossible d'activer : " + e.message, "err"); }
  };
  $("pushTest").onclick = async () => {
    try { pushNote("Envoi…"); const r = await B.invoke("souffle-notify", { mode: "test" }); const x = r.report && r.report[0]; pushNote(x && x.sent ? "Notification envoyée." : (x && (x.skipped || (x.errors || []).join(", "))) || "Rien envoyé.", x && x.sent ? "ok" : "err"); }
    catch (e) { pushNote("Échec : " + e.message, "err"); }
  };
  $("showBilan").onclick = () => maybeBilan(true);

  // ---------- compte ----------
  function renderAccount() {
    if (!B.configured) { $("accountNote").textContent = "Mode local (pas de serveur configuré)."; $("account").hidden = true; return; }
    $("accountNote").textContent = B.connected ? `Connecté : ${(B.user && B.user.email) || "compte Shredlog"}. Données synchronisées.` : "Non connecté : les données restent sur ce téléphone.";
    $("account").textContent = B.connected ? "Se déconnecter" : "Se connecter";
  }
  $("account").onclick = () => { if (B.connected) { B.logout(); renderAccount(); pushState(); } else openLogin(); };
  function openLogin() {
    openSheet(`<div class="login"><h2>Connexion</h2><p>Même compte que Shredlog.</p>
      <form class="form" id="loginForm" style="grid-template-columns:1fr"><label>Email<input id="lEmail" type="email" autocomplete="username" required></label><label>Mot de passe<input id="lPass" type="password" autocomplete="current-password" required></label></form>
      <p class="note err" id="lErr"></p><button class="primary" id="lGo">Se connecter</button></div>`);
    const go = async (e) => {
      e && e.preventDefault();
      try { await B.login($("lEmail").value.trim(), $("lPass").value); closeSheet(); renderAccount(); await pull(); pushState(); }
      catch (err) { $("lErr").textContent = err.message; }
    };
    $("lGo").onclick = go; $("loginForm").onsubmit = go;
  }

  // ---------- navigation ----------
  function tab(name) {
    ["today", "path", "settings"].forEach((t) => { $("v-" + t).hidden = t !== name; });
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false"));
    if (name === "settings") { fillForm(); pushState(); renderAccount(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
  function route(hash) {
    if (hash === "#bilan") { tab("today"); maybeBilan(true); }
    else if (hash === "#settings") tab("settings");
    else if (hash === "#path") tab("path");
    else tab("today");
  }
  $("smoke").onclick = smoke;
  $("undo").onclick = undo;
  $("prev").onclick = () => { view = P.addDays(view, -1); render(); };
  $("next").onclick = () => { if (view < todayKey()) { view = P.addDays(view, 1); render(); } };

  // ---------- démarrage ----------
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.nav) route(e.data.nav); });
  }
  render(); route(location.hash);
  if (location.hash !== "#bilan") maybeBilan(false);
  pull();
  setInterval(() => { const tk = todayKey(); if (view > tk) view = tk; render(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const tk = todayKey(); if (view !== tk && !$("sheet").innerHTML) view = tk;
    render(); pull(); maybeBilan(false);
  });
})();

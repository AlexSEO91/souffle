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

  function blank() {
    const local = tzNow === 420 ? { packPrice: 160, currency: "฿" } : { packPrice: 13, currency: "€" };
    return { settings: { ...P.DEFAULTS, ...local, tzOffset: tzNow }, log: {}, bilanSeen: "", setupDone: false, updatedAt: 0 };
  }
  function normalize(s) { const b = blank(); return { ...b, ...s, settings: { ...b.settings, ...((s && s.settings) || {}) }, log: { ...((s && s.log) || {}) } }; }
  function load() { try { const r = localStorage.getItem(KEY); if (r) return normalize(JSON.parse(r)); } catch (e) {} return blank(); }
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  /** Ce que le serveur voit en clair : réveil + fuseau (heure de la notif) et, seulement si activé, le texte de la notif. */
  function meta() {
    const s = st(), tk = todayKey();
    return { wake: s.wake, tzOffset: s.tzOffset, preview: s.richPush && S.setupDone ? { forKey: tk, push: P.report(S, tk, P.addDays(tk, 1)).push } : null };
  }
  function syncNow() { if (B.connected && S.setupDone) return B.putState(S, meta()).catch(() => {}); }
  function commit() {
    S.updatedAt = Date.now(); saveLocal();
    clearTimeout(syncTimer);
    if (B.connected) syncTimer = setTimeout(syncNow, 700);
  }
  function adopt(remote) { const tz = tzNow; S = normalize(remote); S.setupDone = true; S.settings.tzOffset = tz; saveLocal(); view = todayKey(); }
  async function pull() {
    if (!B.connected) return;
    try {
      const remote = await B.getState();
      if (remote && (remote.updatedAt || 0) > (S.updatedAt || 0)) { adopt(remote); render(); maybeBilan(); }
      else if (S.setupDone && (!remote || (S.updatedAt || 0) > (remote.updatedAt || 0))) await syncNow();
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
    $("countdown").innerHTML = left > 0 ? `<b class="num">J-${left}</b> avant zéro (${dateLabel(zero, { day: "numeric", month: "short" })})` : `<b>Zéro</b> · tenu ${P.zeroRun(S, P.addDays(tk, -1))} j`;

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
    if (!S.setupDone) return;
    if (y < s.startDate) { if (force) toastSheet("Pas encore de bilan", "Le premier bilan arrive demain matin, sur la journée d'aujourd'hui."); return; }
    if (!force && (S.bilanSeen === tk || minsNow(tk) < P.toMin(s.wake) - 120)) return;
    const r = P.report(S, y, tk);
    S.bilanSeen = tk; commit();
    const day = dateLabel(y, { weekday: "long", day: "numeric", month: "long" });
    const chips = r.kind === "over"
      ? `<span class="chip over">${r.n} / ${r.q} · +${r.n - r.q} hors quota</span>`
      : r.kind === "zero"
        ? `<span class="chip">0 cigarette</span><span class="chip grey">🏆 ${r.zeroRun} jour${r.zeroRun > 1 ? "s" : ""} sans tabac</span>`
        : `<span class="chip">${r.n} / ${r.q} · quota tenu</span>${r.streak > 1 ? `<span class="chip grey">🔥 ${r.streak} jours</span>` : ""}`;
    let hero, body, box;
    if (r.kind === "over") {
      hero = `<div class="b-big ink">On repart.</div><div class="b-sub">Un jour raté ne casse pas la mission.${r.belowBase ? ` Tu restes <b>sous ton niveau de départ</b> (${r.base}) : <b>+${r.saved.dayTxt}</b> économisés quand même.` : ""}</div>`;
      body = `<h3 class="b-h">Pour tenir aujourd'hui</h3>${r.tips.map((t) => `<div class="b-tip"><span>${t[0]}</span><span>${t[1]}</span></div>`).join("")}`;
      box = r.todayQuota > 0 ? { t: "Aujourd'hui", v: r.todayQuota, b: `maximum${r.firstTxt ? " · 1re à " + r.firstTxt : ""}` } : { t: "Aujourd'hui", v: "0", b: "objectif zéro" };
    } else {
      const sub = r.kind === "zero" ? `par jour désormais · <b>${r.saved.monthTxt}</b>/mois · <b>${r.saved.yearTxt}</b>/an` : `économisés hier · <b>${r.saved.monthTxt}</b>/mois · <b>${r.saved.yearTxt}</b>/an à ce rythme`;
      hero = `<div class="b-big">+${r.saved.dayTxt}</div><div class="b-sub">${sub}</div>`;
      if (r.kind === "ok") {
        body = `<h3 class="b-h">Ton corps, à ce rythme</h3>` + r.metrics.map((m) => `<div class="b-m"><span class="e">${m.icon}</span><span class="n">${m.name}</span><span class="v${m.locked ? " off" : ""}">${m.value}</span>${m.pct != null || m.locked ? `<div class="b-bar${m.locked ? " lock" : ""}"><i style="width:${m.locked ? 100 : Math.max(3, Math.round(m.pct * 100))}%"></i></div>` : ""}<div class="cap"><span>${m.left}</span><span>${m.right}</span></div></div>`).join("");
        box = r.next ? { t: "Prochain palier", v: r.next.value, b: `par jour, ${r.next.when}` } : { t: "Aujourd'hui", v: "0", b: "objectif zéro" };
      } else {
        body = `<h3 class="b-h">Ce que ton corps a déjà récupéré</h3>` + r.milestones.map((m) => `<div class="b-mile${m.done ? " done" : m.current ? " cur" : ""}"><span class="d"></span><b>${m.label}</b><span>${m.when}</span></div>`).join("");
        box = { t: "Depuis le début", v: r.totals.lifeTxt, b: `de vie · ${r.totals.savedTxt} · ${r.totals.avoided} évitées` };
      }
    }
    openSheet(`<div class="kicker">Bilan d'hier · ${day}</div><div class="b-chips">${chips}</div>${hero}${body}
      <div class="b-next"><div class="t">${box.t}</div><div class="r">${box.v}</div><div class="b">${box.b}</div></div>
      <button class="primary" data-close>${r.ok ? "C'est parti" : "On repart"}</button>`);
  }
  function openSheet(inner, locked) {
    const el = $("sheet");
    el.innerHTML = `<div class="scrim"${locked ? "" : " data-close"}><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${inner}</div></div>`;
    el.querySelectorAll("[data-close]").forEach((x) => x.addEventListener("click", (e) => { if (e.target === x) closeSheet(); }));
  }
  function closeSheet() { $("sheet").innerHTML = ""; }
  function toastSheet(t, p) { openSheet(`<h2>${t}</h2><p class="note" style="font-size:15px">${p}</p><button class="primary" data-close>OK</button>`); }

  // ---------- réglages ----------
  function fillForm() {
    const s = st();
    $("fStart").value = s.start; $("fStartDate").value = s.startDate; $("fEndDate").value = s.endDate; $("fBuffer").value = s.zeroBuffer;
    $("fPrice").value = s.packPrice; $("fPack").value = s.packSize; $("fCur").value = s.currency;
    $("fWake").value = s.wake; $("fSleep").value = s.sleep;
    const z = P.zeroDate(s);
    $("planNote").textContent = `Descente de ${s.start} à 0 : environ −1 tous les ${Math.max(1, Math.round(P.diffDays(s.startDate, P.zeroTarget(s)) / s.start))} jours. Zéro atteint le ${dateLabel(z, { day: "numeric", month: "long", year: "numeric" })}. Puis ${P.diffDays(z, s.endDate)} jours à 0 avant l'objectif du ${dateLabel(s.endDate, { day: "numeric", month: "long" })}.`;
  }
  $("save").onclick = () => {
    const s = st();
    s.start = Math.max(1, Math.round(+$("fStart").value) || s.start);
    if ($("fStartDate").value) s.startDate = $("fStartDate").value;
    if ($("fEndDate").value && $("fEndDate").value > s.startDate) s.endDate = $("fEndDate").value;
    s.zeroBuffer = Math.max(0, Math.min(60, Math.round(+$("fBuffer").value) || 0));
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
    $("fRich").checked = !!st().richPush;
    if (!B.connected) return pushNote("Crée un compte ou connecte-toi (section Compte) pour recevoir les notifications.");
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
      await syncNow();
      pushState();
    } catch (e) { pushNote("Impossible d'activer : " + e.message, "err"); }
  };
  $("pushTest").onclick = async () => {
    try { pushNote("Envoi…"); const r = await B.invoke("souffle-notify", { mode: "test" }); const x = r.report && r.report[0]; pushNote(x && x.sent ? "Notification envoyée." : (x && (x.skipped || (x.errors || []).join(", "))) || "Rien envoyé.", x && x.sent ? "ok" : "err"); }
    catch (e) { pushNote("Échec : " + e.message, "err"); }
  };
  $("showBilan").onclick = () => maybeBilan(true);
  $("fRich").onchange = () => { st().richPush = $("fRich").checked; commit(); };

  // ---------- compte ----------
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PRIVACY = "Tes données sont chiffrées sur ton téléphone avant d'être sauvegardées. Personne d'autre ne peut les lire, pas même l'administrateur de l'app. Mot de passe oublié : ton code de secours te permet d'en choisir un nouveau sans rien perdre.";
  function renderAccount() {
    const box = $("accountBox");
    if (B.connected) {
      box.innerHTML = `<p class="acc-mail">${esc((B.user && B.user.email) || "")}</p><p class="note">🔒 ${PRIVACY}</p>
        <div class="btnrow"><button class="btn" id="aPw" type="button">Changer le mot de passe</button><button class="btn" id="aRec" type="button">Nouveau code de secours</button><button class="btn" id="aOut" type="button">Se déconnecter</button></div>
        <div class="btnrow"><button class="btn danger" id="aDel" type="button">Supprimer mon compte</button></div>`;
      $("aPw").onclick = openPassword;
      $("aRec").onclick = async () => { try { showRecovery(await B.newRecovery(), closeSheet, true); } catch (e) { toastSheet("Impossible", e.message); } };
      $("aOut").onclick = confirmLogout; $("aDel").onclick = confirmDelete;
    } else {
      box.innerHTML = `<p class="note" style="margin-top:0">Pas de compte sur ce téléphone : tes données restent ici, sans sauvegarde ni notifications.</p>
        <div class="btnrow"><button class="btn dark" id="aNew" type="button">Créer un compte</button><button class="btn" id="aIn" type="button">Se connecter</button></div>`;
      $("aNew").onclick = () => openAuth("signup"); $("aIn").onclick = () => openAuth("login");
    }
  }
  function openWelcome() {
    openSheet(`<div class="welcome"><div class="kicker">Souffle</div><h2>Arrêter de fumer, palier par palier.</h2>
      <p class="note" style="font-size:15px">Un quota qui baisse chaque semaine, des heures pour tenir jusqu'au soir, et chaque matin le bilan de la veille.</p>
      <button class="primary" id="wNew">Créer un compte</button>
      <button class="btn wide" id="wIn" type="button">J'ai déjà un compte</button>
      <button class="link" id="wLocal" type="button">Continuer sans compte</button></div>`, true);
    $("wNew").onclick = () => openAuth("signup"); $("wIn").onclick = () => openAuth("login");
    $("wLocal").onclick = () => openSetup();
  }
  function openAuth(mode) {
    const up = mode === "signup";
    openSheet(`<div class="login"><h2>${up ? "Créer un compte" : "Connexion"}</h2>
      <form class="form one" id="aForm">
        <label>Email<input id="lEmail" type="email" autocomplete="username" required></label>
        <label>Mot de passe${up ? " (8 caractères min.)" : ""}<input id="lPass" type="password" autocomplete="${up ? "new-password" : "current-password"}" required></label>
        ${up ? `<label>Code d'invitation<input id="lCode" type="text" autocapitalize="characters" autocomplete="off" required></label>` : ""}
      </form>
      ${up ? `<p class="note">🔒 ${PRIVACY}</p>` : ""}
      <p class="note err" id="lErr"></p>
      <button class="primary" id="lGo">${up ? "Créer mon compte" : "Se connecter"}</button>
      <button class="link" id="lSwitch" type="button">${up ? "J'ai déjà un compte" : "Créer un compte"}</button>
      ${up ? "" : `<button class="link" id="lForgot" type="button">Mot de passe oublié ?</button>`}</div>`, !S.setupDone);
    $("lSwitch").onclick = () => openAuth(up ? "login" : "signup");
    if (!up) $("lForgot").onclick = openRecover;
    let busy = false;
    const go = async (e) => {
      e && e.preventDefault(); if (busy) return;
      const email = $("lEmail").value.trim(), pw = $("lPass").value;
      if (up && pw.length < 8) { $("lErr").textContent = "Mot de passe : 8 caractères minimum."; return; }
      busy = true; $("lGo").textContent = "Un instant…"; $("lErr").textContent = "";
      try {
        afterAuth(up ? await B.signup(email, pw, $("lCode").value) : await B.login(email, pw));
      } catch (err) { $("lErr").textContent = err.message; busy = false; $("lGo").textContent = up ? "Créer mon compte" : "Se connecter"; }
    };
    $("lGo").onclick = go; $("aForm").onsubmit = go;
  }
  function afterAuth(r) {
    const next = () => {
      if (r.state) { adopt(r.state); closeSheet(); render(); renderAccount(); pushState(); maybeBilan(false); }
      else if (S.setupDone) { syncNow(); closeSheet(); renderAccount(); pushState(); }
      else openSetup();
    };
    if (r.recoveryCode) showRecovery(r.recoveryCode, next); else next();
  }
  function showRecovery(code, next, fromAccount) {
    openSheet(`<div class="kicker">Important</div><h2>Ton code de secours</h2>
      <p class="note" style="font-size:15px">Si tu oublies ton mot de passe, ce code te permet d'en choisir un nouveau <b>sans perdre tes données</b>. Lui seul peut les déverrouiller : personne d'autre ne le connaît, pas même l'administrateur.</p>
      <div class="code mono" id="rCode">${code}</div>
      <div class="btnrow"><button class="btn" id="rCopy" type="button">Copier</button></div>
      <p class="note">Garde-le dans tes notes, une capture d'écran ou un email à toi-même.${fromAccount ? " L'ancien code ne fonctionne plus." : ""}</p>
      <label class="switch"><input type="checkbox" id="rOk"><span><b>Je l'ai bien noté</b></span></label>
      <button class="primary" id="rGo" disabled>Continuer</button>`, true);
    $("rCopy").onclick = async () => { try { await navigator.clipboard.writeText(code); $("rCopy").textContent = "Copié ✓"; } catch (e) { const sel = getSelection(), rg = document.createRange(); rg.selectNodeContents($("rCode")); sel.removeAllRanges(); sel.addRange(rg); } };
    $("rOk").onchange = () => { $("rGo").disabled = !$("rOk").checked; };
    $("rGo").onclick = next;
  }
  function openRecover() {
    openSheet(`<div class="login"><h2>Mot de passe oublié</h2><p>Entre ton code de secours et choisis un nouveau mot de passe. Tes données sont conservées.</p>
      <form class="form one" id="vForm">
        <label>Email<input id="vEmail" type="email" autocomplete="username" required></label>
        <label>Code de secours<input id="vCode" type="text" autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" required></label>
        <label>Nouveau mot de passe (8 caractères min.)<input id="vPass" type="password" autocomplete="new-password" required></label>
      </form><p class="note err" id="vErr"></p><button class="primary" id="vGo">Changer le mot de passe</button>
      <button class="link" id="vBack" type="button">Retour</button></div>`, !S.setupDone);
    $("vBack").onclick = () => openAuth("login");
    $("vGo").onclick = async () => {
      if ($("vPass").value.length < 8) { $("vErr").textContent = "8 caractères minimum."; return; }
      $("vGo").textContent = "Un instant…";
      try { afterAuth(await B.recover($("vEmail").value.trim(), $("vCode").value, $("vPass").value)); }
      catch (e) { $("vErr").textContent = e.message; $("vGo").textContent = "Changer le mot de passe"; }
    };
  }

  // ---------- installation sur l'écran d'accueil ----------
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; renderInstall(); });
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  function renderInstall() {
    const box = $("installBox"); if (!box) return;
    if (standalone()) { box.innerHTML = `<p class="note ok" style="margin-top:0">Installée sur cet appareil ✓</p>`; return; }
    box.innerHTML = `<p class="note" style="margin-top:0">Pour l'utiliser comme une vraie app et recevoir les notifications.</p><div class="btnrow"><button class="btn dark" id="iGo" type="button">Installer l'app</button></div>`;
    $("iGo").onclick = openInstall;
  }
  async function openInstall() {
    if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderInstall(); return; }
    const steps = isIOS()
      ? ["Ouvre cette page dans <b>Safari</b>", "Touche le bouton <b>Partager</b> (carré avec une flèche)", "Choisis <b>Sur l'écran d'accueil</b>, puis <b>Ajouter</b>", "Ouvre Souffle depuis l'icône"]
      : ["Ouvre cette page dans <b>Chrome</b>", "Touche le menu <b>⋮</b> en haut à droite", "Choisis <b>Installer l'application</b> (ou « Ajouter à l'écran d'accueil »)", "Ouvre Souffle depuis l'icône"];
    openSheet(`<h2>Installer Souffle</h2><ol class="steps-ol">${steps.map((x) => `<li>${x}</li>`).join("")}</ol><button class="primary" data-close-btn>OK</button>`);
    document.querySelector("[data-close-btn]").onclick = closeSheet;
  }

  function openSetup() {
    const s = st(), tk = todayKey();
    const end = P.diffDays(tk, s.endDate) >= 30 ? s.endDate : P.addDays(tk, 90);
    openSheet(`<div class="setup"><div class="kicker">Ton plan</div><h2>On part d'où tu en es.</h2>
      <form class="form" id="sForm">
        <label class="full">Cigarettes par jour en ce moment<input id="sStart" type="number" min="1" max="60" inputmode="numeric" value="${s.start}" required></label>
        <label>Objectif : 0 tenu le<input id="sEnd" type="date" value="${end}" min="${P.addDays(tk, 14)}" required></label>
        <label>Jours à 0 avant (marge)<input id="sBuf" type="number" min="0" max="60" inputmode="numeric" value="${s.zeroBuffer}"></label>
        <label>Prix du paquet<input id="sPrice" type="number" min="0" step="any" inputmode="decimal" value="${s.packPrice}"></label>
        <label>Devise<input id="sCur" type="text" maxlength="4" value="${esc(s.currency)}"></label>
        <label>Réveil<input id="sWake" type="time" value="${s.wake}"></label>
        <label>Coucher<input id="sSleep" type="time" value="${s.sleep}"></label>
      </form>
      <p class="note" id="sPrev"></p>
      <button class="primary" id="sGo">Lancer mon plan</button></div>`, true);
    const read = () => ({ ...st(), start: Math.max(1, Math.round(+$("sStart").value) || 1), startDate: tk, endDate: $("sEnd").value || end, zeroBuffer: Math.max(0, Math.min(60, Math.round(+$("sBuf").value) || 0)), packPrice: Math.max(0, +$("sPrice").value || 0), currency: $("sCur").value.trim() || "€", wake: $("sWake").value || "08:00", sleep: $("sSleep").value || "23:30" });
    const prev = () => { const x = read(); if (x.endDate <= tk) return; const z = P.zeroDate(x); $("sPrev").textContent = `Environ −1 cigarette tous les ${Math.max(1, Math.round(P.diffDays(tk, P.zeroTarget(x)) / x.start))} jours. Zéro le ${dateLabel(z, { day: "numeric", month: "long" })}, puis ${P.diffDays(z, x.endDate)} jours à 0 avant l'objectif.`; };
    $("sForm").oninput = prev; prev();
    $("sGo").onclick = async () => {
      const x = read(); if (x.endDate <= P.addDays(tk, 7)) { $("sPrev").innerHTML = `<span class="err">Choisis un objectif à plus d'une semaine.</span>`; return; }
      S.settings = x; S.setupDone = true; S.bilanSeen = tk; view = tk; commit(); await syncNow();
      closeSheet(); render(); tab("today");
      if (B.connected) toastSheet("C'est parti", "Pense à activer les notifications dans Réglages pour recevoir ton bilan chaque matin.");
    };
  }
  function openPassword() {
    openSheet(`<div class="login"><h2>Changer le mot de passe</h2><form class="form one" id="pForm">
      <label>Mot de passe actuel<input id="pOld" type="password" autocomplete="current-password" required></label>
      <label>Nouveau mot de passe (8 caractères min.)<input id="pNew" type="password" autocomplete="new-password" required></label></form>
      <p class="note err" id="pErr"></p><button class="primary" id="pGo">Enregistrer</button></div>`);
    $("pGo").onclick = async () => {
      if ($("pNew").value.length < 8) { $("pErr").textContent = "8 caractères minimum."; return; }
      try { await B.changePassword($("pOld").value, $("pNew").value); toastSheet("Mot de passe changé", "Tes données restent chiffrées, avec le nouveau mot de passe."); }
      catch (e) { $("pErr").textContent = e.message; }
    };
  }
  async function unsubscribePush() { try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await B.deletePushSub(sub.endpoint).catch(() => {}); await sub.unsubscribe(); } } catch (e) {} }
  function wipeLocal() { try { localStorage.removeItem(KEY); } catch (e) {} S = blank(); view = todayKey(); }
  function confirmLogout() {
    openSheet(`<h2>Se déconnecter ?</h2><p class="note" style="font-size:15px">Tes données restent sauvegardées, chiffrées, sur ton compte. Elles seront effacées de ce téléphone.</p>
      <button class="primary" id="oGo">Se déconnecter</button><button class="btn wide" data-close-btn type="button">Annuler</button>`);
    document.querySelector("[data-close-btn]").onclick = closeSheet;
    $("oGo").onclick = async () => { await syncNow(); await unsubscribePush(); B.logout(); wipeLocal(); closeSheet(); render(); renderAccount(); tab("today"); openWelcome(); };
  }
  function confirmDelete() {
    openSheet(`<h2>Supprimer ton compte ?</h2><p class="note" style="font-size:15px">Toutes tes données Souffle seront effacées définitivement, ici et sur le serveur. Impossible de revenir en arrière.</p>
      <p class="note err" id="dErr"></p><button class="primary danger-bg" id="dGo">Supprimer définitivement</button><button class="btn wide" data-close-btn type="button">Annuler</button>`);
    document.querySelector("[data-close-btn]").onclick = closeSheet;
    $("dGo").onclick = async () => { try { await unsubscribePush(); await B.deleteAccount(); wipeLocal(); closeSheet(); render(); renderAccount(); tab("today"); openWelcome(); } catch (e) { $("dErr").textContent = e.message; } };
  }

  // ---------- navigation ----------
  function tab(name) {
    ["today", "path", "settings"].forEach((t) => { $("v-" + t).hidden = t !== name; });
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false"));
    if (name === "settings") { fillForm(); pushState(); renderAccount(); renderInstall(); }
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
  setTimeout(() => { const l = $("launch"); if (l) { l.classList.add("out"); setTimeout(() => l.remove(), 400); } }, 1000);
  if (!S.setupDone) { if (B.connected) pull().then(() => { if (!S.setupDone) openSetup(); }); else openWelcome(); }
  else { if (location.hash !== "#bilan") maybeBilan(false); pull(); }
  setInterval(() => { const tk = todayKey(); if (view > tk) view = tk; render(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const tk = todayKey(); if (view !== tk && !$("sheet").innerHTML) view = tk;
    render(); pull(); maybeBilan(false);
  });
})();

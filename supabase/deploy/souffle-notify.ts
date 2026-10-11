// @ts-nocheck — Souffle · notifications push + création/suppression de compte. plan.js est embarqué par tools/build_edge.sh.
// Modes :
//   "tick"   (cron */15, secret x-cron-secret) → notif du matin, une fois par jour, au premier passage après l'heure de réveil.
//            Les données étant chiffrées, la fonction ne lit QUE wake, tz_offset et, si l'utilisateur l'a activé, preview
//            (texte de notif préparé par son téléphone). Sinon : notif générique sans aucun chiffre.
//   "test"   (JWT utilisateur) → notif de test.
//   "signup" (public, avec code d'invitation) → crée le compte (email confirmé d'office ; inscriptions publiques fermées).
//   "recover" (public, avec le hash du code de secours) → nouveau mot de passe, données conservées.
//   "delete" (JWT utilisateur) → supprime le compte et toutes ses données (cascade).
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
const window = globalThis;
// ─── plan.js (copie générée, ne pas modifier ici) ───
/* Souffle — logique partagée app + Edge Function (quota dégressif, heures idéales, bilan du matin).
   Aucune dépendance. Dates = "AAAA-MM-JJ". Une journée se termine à 4 h du matin (heure locale). */
(function (root) {
  "use strict";
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5); // b − a
  const ROLLOVER_H = 4;

  const DEFAULTS = {
    start: 18,               // conso de départ / jour
    startDate: "2026-10-11",
    endDate: "2027-01-01",   // objectif : être à 0 (tenu) ce jour-là
    zeroBuffer: 7,           // jours à 0 avant l'objectif, pour qu'il soit vraiment tenu
    packPrice: 160,
    packSize: 20,
    currency: "฿",
    wake: "08:00",
    sleep: "00:30",
    tzOffset: 420,           // minutes à ajouter à l'UTC (Bangkok = +420), mis à jour par l'app
  };
  const settingsOf = (state) => ({ ...DEFAULTS, ...((state && state.settings) || {}) });

  /** Clé du jour "logique" à l'instant ms (bascule à 4 h du matin, heure locale de l'utilisateur). */
  function dayKey(ms, tzOffset) { return iso(new Date(ms + (tzOffset || 0) * 6e4 - ROLLOVER_H * 3600e3)); }
  /** Minutes écoulées depuis minuit du jour `key`, à l'instant ms (peut dépasser 1440 après minuit). */
  function minutesInto(key, ms, tzOffset) { return (ms + (tzOffset || 0) * 6e4 - parse(key).getTime()) / 6e4; }
  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
  const fmtMin = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };

  /** Date à laquelle le quota doit être à 0 : l'objectif moins la marge. */
  function zeroTarget(s) { return addDays(s.endDate, -Math.max(0, Number(s.zeroBuffer) || 0)); }
  /** Quota du jour : descente linéaire de `start` (jour de départ) à 0 (date limite). */
  function quota(s, key) {
    const N = diffDays(s.startDate, zeroTarget(s)), d = diffDays(s.startDate, key);
    if (N <= 0) return 0;
    if (d < 0) return s.start;
    if (d >= N) return 0;
    return Math.max(0, Math.round(s.start * (1 - d / N)));
  }
  /** Date du premier jour à 0. */
  function zeroDate(s) { let k = s.startDate; for (let i = 0; i < 2000 && quota(s, k) > 0; i++) k = addDays(k, 1); return k; }

  /** Heures idéales (minutes depuis minuit) pour étaler `q` cigarettes entre le réveil et le coucher. */
  function idealTimes(s, q) {
    let w = toMin(s.wake), z = toMin(s.sleep);
    if (z <= w) z += 1440;
    const a = w + 45, b = Math.max(a + 60, z - 60), span = b - a;
    if (q <= 0) return [];
    if (q === 1) return [Math.round((a + span * 0.6) / 5) * 5];
    return Array.from({ length: q }, (_, i) => Math.round((a + (span * i) / (q - 1)) / 5) * 5);
  }

  /** Planning recalculé : les cases déjà fumées gardent leur heure réelle ; les suivantes sont réparties
      entre la dernière cigarette et la fin de journée, jamais plus tôt que le plan de base (pas d'avance). */
  function schedule(s, q, doneMins) {
    const base = idealTimes(s, q), n = doneMins.length;
    if (!n || n >= q) return base;
    let z = toMin(s.sleep); if (z <= toMin(s.wake)) z += 1440;
    const E = Math.max(toMin(s.wake) + 105, z - 60), L = doneMins[n - 1], r = q - n;
    return base.map((t, i) => (i < n ? t : Math.max(t, Math.round((L + ((E - L) * (i - n + 1)) / r) / 5) * 5)));
  }
  const smoked = (state, key) => ((state && state.log && state.log[key]) || []).length;
  const perCig = (s) => (Number(s.packPrice) || 0) / (Number(s.packSize) || 20);
  function money(v, s) {
    const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    return r.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " " + s.currency;
  }

  /** Série de jours dans le quota, en remontant depuis `fromKey` inclus. */
  function streak(state, fromKey) {
    const s = settingsOf(state); let n = 0;
    for (let k = fromKey; k >= s.startDate; k = addDays(k, -1)) { if (smoked(state, k) <= quota(s, k)) n++; else break; }
    return n;
  }
  /** Jours consécutifs à 0, en remontant depuis `fromKey`. */
  function zeroRun(state, fromKey) {
    const s = settingsOf(state); let n = 0;
    for (let k = fromKey; k >= s.startDate; k = addDays(k, -1)) { if (smoked(state, k) === 0) n++; else break; }
    return n;
  }
  /** Totaux depuis le départ jusqu'à `toKey` inclus (jours révolus uniquement). */
  function totals(state, toKey) {
    const s = settingsOf(state); let avoided = 0, days = 0;
    for (let k = s.startDate; k <= toKey; k = addDays(k, 1)) { avoided += Math.max(0, s.start - smoked(state, k)); days++; }
    return { avoided, days, saved: avoided * perCig(s), lifeHours: (avoided * 20) / 60 };
  }

  // Repères de l'arrêt complet (OMS, Santé publique France), utilisés une fois à 0.
  const QUIT = [
    [1, "🫀", "Après 24 h sans tabac, le monoxyde de carbone a quitté ton sang et ton cœur reçoit un sang mieux oxygéné."],
    [2, "👃", "Après 48 h, le goût et l'odorat commencent à revenir."],
    [3, "🫁", "Après 72 h, les bronches se relâchent et respirer devient plus facile."],
    [14, "🏃", "Entre 2 et 12 semaines, la circulation et la capacité pulmonaire s'améliorent nettement : tu le sentiras à l'entraînement."],
    [30, "🧹", "Après 1 à 9 mois, la toux et l'essoufflement diminuent, les cils des bronches se reconstruisent."],
    [74, "🧬", "Environ 74 jours : un cycle complet de production de spermatozoïdes sans tabac. Volume, nombre et mobilité s'améliorent."],
    [365, "❤️", "Après 1 an, le surrisque d'infarctus est divisé par deux."],
  ];

  /** Bilan du jour `key` (en général hier). Tous les chiffres santé sont approximatifs et sourcés dans l'app. */
  function report(state, key, todayKey) {
    const s = settingsOf(state);
    const q = quota(s, key), n = smoked(state, key), base = s.start;
    const ok = n <= q, red = Math.max(0, Math.min(1, (base - n) / base));
    const day = Math.max(0, base - n) * perCig(s);
    const tq = quota(s, todayKey), left = Math.max(0, diffDays(todayKey, s.endDate));
    const st = streak(state, key), zr = zeroRun(state, key);
    const lung = Math.round(red * 55), co = Math.round(red * 100), gained = Math.max(0, base - n) * 20;
    const health = [];
    if (n === 0) {
      const passed = QUIT.filter((m) => zr >= m[0]);
      const next = QUIT.find((m) => zr < m[0]);
      health.push(["🏆", `${zr} jour${zr > 1 ? "s" : ""} sans tabac.`]);
      passed.slice(-2).forEach((m) => health.push([m[1], m[2]]));
      if (next) health.push(["⏭️", `Prochain palier dans ${next[0] - zr} jour${next[0] - zr > 1 ? "s" : ""} : ${next[2].replace(/^[^,:]*[,:]\s*/, "")}`]);
    } else if (ok) {
      health.push(["🫁", `À ${n} au lieu de ${base}, ton risque de cancer du poumon baisse d'environ ${lung} % si tu tiens ce niveau.`]);
      health.push(["🩸", `Environ ${co} % de monoxyde de carbone en moins dans le sang : plus d'oxygène pour les muscles et le cerveau.`]);
      health.push(["⏳", `≈ ${gained >= 60 ? Math.floor(gained / 60) + " h " + pad(gained % 60) : gained + " min"} d'espérance de vie préservées sur la seule journée d'hier.`]);
      health.push(["❤️", "Le cœur ne récupère vraiment qu'à zéro : même 1 cigarette par jour garde la moitié du surrisque. Chaque palier te rapproche du vrai gain."]);
    } else {
      health.push(["🧠", "Une envie dure 3 à 5 minutes. À chaque envie : un verre d'eau, 10 respirations lentes, tu bouges."]);
      health.push(["🎯", `Aujourd'hui, ${tq} maximum. Suis les heures de l'app : elles sont calculées pour tenir jusqu'au coucher.`]);
    }
    const saved = ok && day > 0 ? { day, month: day * 30, year: day * 365, dayTxt: money(day, s), monthTxt: money(day * 30, s), yearTxt: money(day * 365, s) } : null;
    const headline = n === 0 ? "Zéro. Journée parfaite." : ok ? "Quota tenu." : "Quota dépassé. On repart.";
    const closing = ok
      ? (tq === 0 ? "Objectif du jour : zéro. Tu en es capable." : `Accroche-toi, c'est dur, mais tu tiens le bon bout. Aujourd'hui : ${tq} maximum.`)
      : `Un jour raté ne casse pas la mission. Aujourd'hui : ${tq} maximum, encore ${left} jours.`;
    const firstTime = idealTimes(s, tq)[0];
    // Notification (courte, lisible sur l'écran verrouillé)
    const push = {
      title: ok ? (n === 0 ? "Zéro cigarette hier 🏆" : `Bien joué : ${n}/${q} hier ✅`) : `Hier : ${n}/${q}. On repart 💪`,
      body: ok
        ? [saved ? `${saved.dayTxt} économisés · ${saved.monthTxt}/mois à ce rythme.` : null, n > 0 ? `Risque de cancer du poumon ≈ −${lung} %.` : null, tq > 0 ? `Aujourd'hui : ${tq} max, première à ${fmtMin(firstTime)}.` : "Aujourd'hui : zéro."].filter(Boolean).join(" ")
        : `Aujourd'hui : ${tq} max${tq > 0 ? `, première à ${fmtMin(firstTime)}` : ""}. Une envie dure 5 minutes, pas plus.`,
      url: "#bilan", tag: "bilan",
    };
    return { key, ok, n, q, base, saved, health, headline, closing, todayQuota: tq, daysLeft: left, streak: ok ? st : 0, push };
  }

  const api = { DEFAULTS, settingsOf, zeroTarget, dayKey, minutesInto, toMin, fmtMin, quota, zeroDate, idealTimes, schedule, smoked, perCig, money, streak, zeroRun, totals, report, addDays, diffDays, parse, iso };
  root.Souffle = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

const P = globalThis.Souffle;
const VAPID_PUBLIC_KEY = "BO67--Fy4TjmV936flvXOAOwJv2eO4tqsHZDygQmeTtGUtSRfHtC2mHmLAcKRWpzIU1E84H8mCwIUqULEOQf5eg"; // clé partagée avec Shredlog
const VAPID_SUBJECT = "https://alexseo91.github.io/souffle/";
const GENERIC = { title: "Nouveau jour 🌅", body: "Ton bilan d'hier et ton quota du jour t'attendent dans Souffle.", url: "#bilan", tag: "bilan" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const msg = (e) => (e && e.message) || String(e);
function sameSecret(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < b.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode;
    const userFromJwt = async () => {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data, error } = await db.auth.getUser(jwt);
      return error || !data || !data.user ? null : data.user;
    };

    if (mode === "signup") {
      const email = String(body.email || "").trim().toLowerCase(), password = String(body.password || "");
      const { data: code, error } = await db.rpc("souffle_invite_code"); if (error) throw error;
      if (!sameSecret(String(body.code || "").trim().toUpperCase(), String(code || "").toUpperCase())) return json({ error: "Code d'invitation incorrect." }, 403);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Email invalide." }, 400);
      if (password.length < 8) return json({ error: "Mot de passe : 8 caractères minimum." }, 400);
      const { error: ce } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (ce) return json({ error: /already|registered|exists/i.test(ce.message) ? "Un compte existe déjà avec cet email." : ce.message }, 400);
      return json({ ok: true });
    }
    if (mode === "recover") {
      // Mot de passe oublié : l'app envoie le SHA-256 du code de secours (jamais le code). Si ça correspond, nouveau mot de passe.
      const email = String(body.email || "").trim().toLowerCase(), password = String(body.password || ""), recHash = String(body.recHash || "");
      if (password.length < 8) return json({ error: "Mot de passe : 8 caractères minimum." }, 400);
      const { data: uid } = await db.rpc("souffle_user_by_email", { p_email: email });
      const { data: row } = uid ? await db.from("souffle_state").select("rec_hash").eq("user_id", uid).maybeSingle() : { data: null };
      if (!uid || !row || !row.rec_hash || !sameSecret(recHash, row.rec_hash)) return json({ error: "Email ou code de secours incorrect." }, 403);
      const { error } = await db.auth.admin.updateUserById(uid, { password }); if (error) throw error;
      return json({ ok: true });
    }
    if (mode === "delete") {
      const u = await userFromJwt(); if (!u) return json({ error: "Unauthorized" }, 401);
      await db.from("souffle_push_subscriptions").delete().eq("user_id", u.id);
      await db.from("souffle_notification_log").delete().eq("user_id", u.id);
      await db.from("souffle_state").delete().eq("user_id", u.id);
      const hasShred = await db.from("docs").select("path", { count: "exact", head: true }).eq("user_id", u.id);
      if (!hasShred.count) { const { error } = await db.auth.admin.deleteUser(u.id); if (error) throw error; }
      return json({ ok: true, accountDeleted: !hasShred.count });
    }

    let users;
    if (mode === "tick") {
      const { data: secret, error } = await db.rpc("souffle_cron_secret"); if (error) throw error;
      if (!sameSecret(req.headers.get("x-cron-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
      const { data, error: e2 } = await db.from("souffle_push_subscriptions").select("user_id"); if (e2) throw e2;
      users = [...new Set((data || []).map((r) => r.user_id))];
    } else if (mode === "test") {
      const u = await userFromJwt(); if (!u) return json({ error: "Unauthorized" }, 401);
      users = [u.id];
    } else return json({ error: "mode inconnu" }, 400);

    const priv = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!priv) throw new Error("Secret VAPID_PRIVATE_KEY manquant (Edge Functions → Secrets).");
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, priv);

    const now = Date.now(); const report = [];
    for (const uid of users) {
      const { data: subs, error: se } = await db.from("souffle_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", uid);
      if (se) throw se;
      if (!subs || !subs.length) { report.push({ skipped: "aucun appareil abonné" }); continue; }
      let message = null, logKey = null, today = null;
      if (mode === "test") message = { title: "Souffle", body: "Les notifications fonctionnent sur cet appareil.", url: "#today", tag: "test" };
      else {
        const { data: row } = await db.from("souffle_state").select("wake, tz_offset, preview").eq("user_id", uid).maybeSingle();
        if (!row || !row.wake) { report.push({ skipped: "pas encore configuré" }); continue; }
        const tz = row.tz_offset || 0;
        today = P.dayKey(now, tz);
        const minutes = P.minutesInto(today, now, tz);
        if (minutes < P.toMin(row.wake) || minutes > 14 * 60) { report.push({ skipped: "pas l'heure" }); continue; }
        logKey = "bilan:" + today;
        const { data: done } = await db.from("souffle_notification_log").select("key").eq("user_id", uid).eq("key", logKey).maybeSingle();
        if (done) { report.push({ skipped: "déjà envoyé" }); continue; }
        const pv = row.preview;
        message = pv && pv.forKey === P.addDays(today, -1) && pv.push ? pv.push : GENERIC;
      }
      let sent = 0; const errors = [];
      for (const sub of subs) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(message), { TTL: 6 * 3600, urgency: "normal" });
          sent++; await db.from("souffle_push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", sub.id);
        } catch (e) {
          const st = e && e.statusCode;
          if (st === 404 || st === 410) await db.from("souffle_push_subscriptions").delete().eq("id", sub.id);
          else errors.push(`${st || ""} ${msg(e)}`.trim());
        }
      }
      if (sent && logKey) await db.from("souffle_notification_log").upsert({ user_id: uid, key: logKey, last_sent: today }, { onConflict: "user_id,key" });
      report.push({ sent, errors });
    }
    return json({ mode, report });
  } catch (e) { return json({ error: msg(e) }, 500); }
});

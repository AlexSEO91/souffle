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

  // Repères de l'arrêt complet (OMS, Santé publique France), affichés une fois à 0.
  const QUIT = [
    { d: 1, label: "Monoxyde de carbone éliminé", when: "24 h" },
    { d: 2, label: "Goût et odorat reviennent", when: "48 h" },
    { d: 3, label: "Bronches relâchées, souffle facile", when: "72 h" },
    { d: 14, label: "Circulation, capacité pulmonaire", when: "2 sem." },
    { d: 30, label: "Toux et essoufflement en baisse", when: "1 mois" },
    { d: 74, label: "Cycle de spermatozoïdes sans tabac", when: "74 j" },
    { d: 365, label: "Risque d'infarctus divisé par 2", when: "1 an" },
  ];
  const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
  const fmtLife = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? " " + pad(min % 60) : ""}` : `${min} min`);
  const dayName = (fromKey, k) => {
    const n = diffDays(fromKey, k);
    if (n === 1) return "demain";
    const d = parse(k);
    return n < 7 ? "dès " + d.toLocaleDateString("fr-FR", { timeZone: "UTC", weekday: "long" }) : "le " + d.toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "short" });
  };

  /** Bilan du jour `key` (en général hier), vu depuis `todayKey`. Données structurées pour la fiche + texte de notification.
      Chiffres santé approximatifs, sourcés dans l'app : poumon ≈ baisse × 55 % (Godtfredsen 2005), CO proportionnel,
      ≈ 20 min de vie par cigarette (UCL 2025), cœur : bénéfice réel seulement à 0 (Hackshaw 2018). */
  function report(state, key, todayKey) {
    const s = settingsOf(state), log = (state && state.log && state.log[key]) || [];
    const q = quota(s, key), n = log.length, base = s.start;
    const kind = n === 0 ? "zero" : n <= q ? "ok" : "over";
    const red = Math.max(0, Math.min(1, (base - n) / base));
    const day = Math.max(0, base - n) * perCig(s);
    const saved = { day, month: day * 30, year: day * 365, dayTxt: money(day, s), monthTxt: money(day * 30, s), yearTxt: money(day * 365, s) };
    const tq = quota(s, todayKey), first = schedule(s, tq, [])[0];
    const tot = totals(state, key);
    const zr = zeroRun(state, key), st = kind === "over" ? 0 : streak(state, key);
    // palier suivant (à partir d'aujourd'hui)
    let nk = todayKey; for (let i = 0; i < 400 && quota(s, nk) >= tq && tq > 0; i++) nk = addDays(nk, 1);
    const next = tq > 0 ? { value: quota(s, nk), when: dayName(todayKey, nk) } : null;
    const out = {
      key, kind, ok: kind !== "over", n, q, base, saved, streak: st, zeroRun: zr, todayQuota: tq,
      firstTxt: first != null ? fmtMin(first) : null, next, daysLeft: Math.max(0, diffDays(todayKey, s.endDate)),
      totals: { savedTxt: money(tot.saved, s), avoided: tot.avoided, lifeTxt: fmtLife(Math.round(tot.lifeHours * 60)) },
    };
    if (kind === "ok") {
      out.metrics = [
        { icon: "🫁", name: "Risque cancer du poumon", value: `−${Math.round(red * 55)} %`, pct: red, left: "aujourd'hui", right: "−55 % à zéro" },
        { icon: "🩸", name: "Monoxyde de carbone", value: `−${Math.round(red * 100)} %`, pct: red, left: "plus d'oxygène aux muscles", right: "−100 % à zéro" },
        { icon: "❤️", name: "Cœur", value: "à zéro", locked: true, left: "même 1/jour garde la moitié du risque", right: "débloqué à 0" },
        { icon: "⏳", name: "Vie préservée", value: "+" + fmtLife((base - n) * 20), left: "hier", right: `${out.totals.lifeTxt} depuis le début` },
      ];
    }
    if (kind === "over") {
      const extra = log.slice().sort((x, y) => x - y)[q];
      out.overTxt = extra ? fmtMin(minutesInto(key, extra, s.tzOffset)) : null;
      out.belowBase = n < base;
      out.tips = [
        ["⏱️", "Une envie dure <b>3 à 5 minutes</b>. Eau, 10 respirations lentes, tu bouges."],
        ["🎯", "Suis les heures de l'app : elles sont calculées pour tenir jusqu'au coucher."],
      ];
      if (out.overTxt) out.tips.push(["🔍", `Ta cigarette en trop d'hier était à <b>${out.overTxt}</b>. Ce soir, prévois autre chose à cette heure-là.`]);
    }
    if (kind === "zero") {
      out.milestones = QUIT.map((m) => ({ label: m.label, done: zr >= m.d, when: zr >= m.d ? m.when : `dans ${m.d - zr} j` }));
      const ci = out.milestones.findIndex((m) => !m.done); if (ci >= 0) out.milestones[ci].current = true;
      const lastDone = QUIT.filter((m) => zr >= m.d).pop();
      out.lastMilestone = lastDone ? lastDone.label : null;
    }
    // Notification (écran verrouillé)
    const plan = tq > 0 ? `Aujourd'hui : ${tq} max${out.firstTxt ? `, première à ${out.firstTxt}` : ""}.` : "Aujourd'hui : zéro.";
    if (kind === "ok") out.push = { title: `+${saved.dayTxt} hier · ${n}/${q} ✅`, body: `${saved.monthTxt}/mois à ce rythme. Poumons −${Math.round(red * 55)} %. ${plan}` };
    else if (kind === "over") out.push = { title: `Hier : ${n}/${q}. On repart 💪`, body: `${n < base ? `Encore ${plural(base - n, "cigarette")} de moins que ton départ. ` : ""}${plan}` };
    else out.push = { title: `${plural(zr, "jour")} sans tabac 🏆`, body: `+${saved.dayTxt} hier.${out.lastMilestone ? " " + out.lastMilestone + "." : ""} ${plan}`.trim() };
    out.push.url = "#bilan"; out.push.tag = "bilan";
    return out;
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

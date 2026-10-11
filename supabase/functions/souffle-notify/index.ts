// @ts-nocheck — Souffle · notifications push. plan.js (partagé avec l'app) est embarqué par tools/build_edge.sh.
// Modes : "tick" (cron toutes les 15 min, secret x-cron-secret) → bilan du matin une fois par jour après l'heure de réveil.
//         "test" / "bilan" (appelés depuis l'app avec le jeton de l'utilisateur) → notif de test / bilan d'hier tout de suite.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
const window = globalThis;
// @@EMBED@@
const P = globalThis.Souffle;
const VAPID_PUBLIC_KEY = "BO67--Fy4TjmV936flvXOAOwJv2eO4tqsHZDygQmeTtGUtSRfHtC2mHmLAcKRWpzIU1E84H8mCwIUqULEOQf5eg"; // clé partagée avec Shredlog
const VAPID_SUBJECT = "https://alexseo91.github.io/souffle/";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const msg = (e) => (e && e.message) || String(e);
function sameSecret(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < b.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  try {
    const { mode } = await req.json().catch(() => ({}));
    let users;
    if (mode === "tick") {
      const { data: secret, error } = await db.rpc("souffle_cron_secret"); if (error) throw error;
      if (!sameSecret(req.headers.get("x-cron-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
      const { data, error: e2 } = await db.from("souffle_push_subscriptions").select("user_id"); if (e2) throw e2;
      users = [...new Set((data || []).map((r) => r.user_id))];
    } else if (mode === "test" || mode === "bilan") {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data, error } = await db.auth.getUser(jwt);
      if (error || !data || !data.user) return json({ error: "Unauthorized" }, 401);
      users = [data.user.id];
    } else return json({ error: "mode inconnu" }, 400);

    const priv = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!priv) throw new Error("Secret VAPID_PRIVATE_KEY manquant (Edge Functions → Secrets).");
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, priv);

    const now = Date.now(); const report = [];
    for (const uid of users) {
      const { data: subs, error: se } = await db.from("souffle_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", uid);
      if (se) throw se;
      if (!subs || !subs.length) { report.push({ skipped: "aucun appareil abonné" }); continue; }
      const { data: row } = await db.from("souffle_state").select("data").eq("user_id", uid).maybeSingle();
      const state = (row && row.data) || {};
      const s = P.settingsOf(state);
      const today = P.dayKey(now, s.tzOffset); const yesterday = P.addDays(today, -1);
      const minutes = P.minutesInto(today, now, s.tzOffset);

      let message = null, logKey = null;
      if (mode === "test") message = { title: "Souffle", body: "Les notifications fonctionnent sur cet appareil.", url: "#today", tag: "test" };
      else {
        if (yesterday < s.startDate) { report.push({ skipped: "plan pas encore commencé hier" }); continue; }
        if (mode === "tick") {
          if (minutes < P.toMin(s.wake) || minutes > 14 * 60) { report.push({ skipped: "pas l'heure du bilan" }); continue; }
          logKey = "bilan:" + today;
          const { data: done } = await db.from("souffle_notification_log").select("key").eq("user_id", uid).eq("key", logKey).maybeSingle();
          if (done) { report.push({ skipped: "bilan déjà envoyé" }); continue; }
        }
        message = P.report(state, yesterday, today).push;
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
      report.push({ sent, title: message.title, errors });
    }
    return json({ mode, report });
  } catch (e) { return json({ error: msg(e) }, 500); }
});

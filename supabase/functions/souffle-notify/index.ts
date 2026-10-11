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
// @@EMBED@@
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

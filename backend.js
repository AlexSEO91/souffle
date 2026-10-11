/* Souffle — backend Supabase en REST direct (même modèle que Shredlog).
   Même origine que Shredlog (alexseo91.github.io) : si tu es déjà connecté à Shredlog sur le téléphone, la session est reprise. */
window.SouffleBackend = (function () {
  const C = window.SOUFFLE_CONFIG || {};
  const configured = !!(C.supabaseUrl && C.supabaseAnonKey);
  const LS = "souffle.session";
  let session = null;
  try { session = JSON.parse(localStorage.getItem(LS) || "null") || JSON.parse(localStorage.getItem("shredlog.session") || "null"); } catch (e) { session = null; }
  const save = () => { try { if (session) localStorage.setItem(LS, JSON.stringify(session)); else localStorage.removeItem(LS); } catch (e) {} };
  if (session) save();
  const headers = (extra = {}) => ({ apikey: C.supabaseAnonKey, Authorization: "Bearer " + (session ? session.access_token : C.supabaseAnonKey), "Content-Type": "application/json", ...extra });
  function setSession(j) { session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: j.user ? { id: j.user.id, email: j.user.email } : session && session.user }; save(); }
  async function refreshIfNeeded() {
    if (!session) return;
    if (Date.now() / 1000 < (session.expires_at || 0) - 60) return;
    const r = await fetch(`${C.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: C.supabaseAnonKey, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) { session = null; save(); throw new Error("session expirée"); }
    setSession(await r.json());
  }
  async function login(email, password) {
    const r = await fetch(`${C.supabaseUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: C.supabaseAnonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error_description || j.msg || "connexion refusée");
    setSession(j); return session.user;
  }
  function logout() { session = null; save(); }
  async function rest(path, opts = {}) {
    await refreshIfNeeded();
    const r = await fetch(`${C.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers || {}) });
    if (r.status === 401) { session = null; save(); throw new Error("non connecté"); }
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
  async function getState() { const rows = await rest("souffle_state?select=data,updated_at"); return rows && rows[0] ? rows[0].data : null; }
  async function putState(data) { await rest("souffle_state?on_conflict=user_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ data, updated_at: new Date().toISOString() }) }); }
  async function savePushSub(row) { await rest("souffle_push_subscriptions?on_conflict=endpoint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) }); }
  async function deletePushSub(endpoint) { await rest(`souffle_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); }
  async function invoke(name, body) {
    await refreshIfNeeded();
    const r = await fetch(`${C.supabaseUrl}/functions/v1/${name}`, { method: "POST", headers: headers(), body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || j.message || `erreur ${r.status}`);
    return j;
  }
  return { configured, get user() { return session ? session.user : null; }, get connected() { return !!session; }, login, logout, getState, putState, savePushSub, deletePushSub, invoke };
})();

/* Souffle — backend Supabase (REST direct) + chiffrement de bout en bout.
   Les données de l'utilisateur sont chiffrées SUR LE TÉLÉPHONE (AES-GCM 256) avec une clé aléatoire,
   elle-même emballée par une clé tirée du mot de passe (PBKDF2-SHA256, 310 000 itérations).
   La base ne reçoit que du chiffré : ni l'admin du projet ni personne d'autre ne peut lire les données.
   En clair côté serveur : email (compte), heure de réveil et fuseau (pour la notif du matin), et l'aperçu de notif
   uniquement si l'utilisateur active « notifications détaillées ». */
window.SouffleBackend = (function () {
  const C = window.SOUFFLE_CONFIG || {};
  const configured = !!(C.supabaseUrl && C.supabaseAnonKey);
  const LS = "souffle.session", LK = "souffle.dek";
  const te = new TextEncoder(), td = new TextDecoder();
  let session = null, dekRaw = null, dek = null;
  try { session = JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) {}
  try { const k = JSON.parse(localStorage.getItem(LK) || "null"); if (k && session && session.user && k.uid === session.user.id) dekRaw = b64d(k.key); } catch (e) {}

  function b64e(buf) { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }
  function b64d(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const ITER = 310000;

  async function passKey(password, salt, iter) {
    const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter || ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function wrap(raw, password) {
    const salt = rand(16), iv = rand(12), k = await passKey(password, salt, ITER);
    return { v: 1, iter: ITER, salt: b64e(salt), iv: b64e(iv), wrapped: b64e(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, raw)) };
  }
  async function unwrap(kdf, password) {
    const k = await passKey(password, b64d(kdf.salt), kdf.iter);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(kdf.iv) }, k, b64d(kdf.wrapped)));
  }
  const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function newRecoveryCode() { const r = rand(20); let c = ""; for (let i = 0; i < 20; i++) { c += ALPHA[r[i] % 32]; if (i % 4 === 3 && i < 19) c += "-"; } return c; }
  const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  async function sha256(t) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
  /** Emballe la clé avec un nouveau code de secours ; renvoie { code, fields } (le code n'est jamais envoyé). */
  async function recoveryFields(raw) { const code = newRecoveryCode(); return { code, fields: { kdf_rec: await wrap(raw, normCode(code)), rec_hash: await sha256(normCode(code)) } }; }
  async function dataKey() { if (!dek && dekRaw) dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["encrypt", "decrypt"]); return dek; }
  async function seal(obj) { const iv = rand(12); return { iv: b64e(iv), ct: b64e(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await dataKey(), te.encode(JSON.stringify(obj)))) }; }
  async function unseal(box) { return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(box.iv) }, await dataKey(), b64d(box.ct)))); }
  function keepKey(raw) { dekRaw = raw; dek = null; try { localStorage.setItem(LK, JSON.stringify({ uid: session.user.id, key: b64e(raw) })); } catch (e) {} }

  const save = () => { try { if (session) localStorage.setItem(LS, JSON.stringify(session)); else localStorage.removeItem(LS); } catch (e) {} };
  const headers = (extra = {}) => ({ apikey: C.supabaseAnonKey, Authorization: "Bearer " + (session ? session.access_token : C.supabaseAnonKey), "Content-Type": "application/json", ...extra });
  function setSession(j) { session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: j.user ? { id: j.user.id, email: j.user.email } : session && session.user }; save(); }
  async function refreshIfNeeded() {
    if (!session) return;
    if (Date.now() / 1000 < (session.expires_at || 0) - 60) return;
    const r = await fetch(`${C.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: C.supabaseAnonKey, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) { session = null; save(); throw new Error("Session expirée, reconnecte-toi."); }
    setSession(await r.json());
  }
  async function rest(path, opts = {}) {
    await refreshIfNeeded();
    const r = await fetch(`${C.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers || {}) });
    if (r.status === 401) { session = null; save(); throw new Error("non connecté"); }
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
  async function invoke(name, body, anon) {
    if (!anon) await refreshIfNeeded();
    const h = anon ? { apikey: C.supabaseAnonKey, Authorization: "Bearer " + C.supabaseAnonKey, "Content-Type": "application/json" } : headers();
    const r = await fetch(`${C.supabaseUrl}/functions/v1/${name}`, { method: "POST", headers: h, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || j.message || `erreur ${r.status}`);
    return j;
  }
  const upsert = (body) => rest("souffle_state?on_conflict=user_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body) });
  const row = async () => { const rows = await rest("souffle_state?select=enc,kdf,kdf_rec,updated_at"); return rows && rows[0] ? rows[0] : null; };

  /** Connexion + déverrouillage de la clé. Renvoie { state, recoveryCode? }.
      recoveryCode : fourni par « mot de passe oublié » → on déverrouille avec le code et on ré-emballe avec le nouveau mot de passe. */
  async function login(email, password, recoveryCode) {
    const r = await fetch(`${C.supabaseUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: C.supabaseAnonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(/invalid/i.test(j.error_description || j.msg || j.error || "") ? "Email ou mot de passe incorrect." : j.error_description || j.msg || "Connexion refusée.");
    setSession(j);
    const cur = await row();
    if (cur && cur.kdf) {
      try {
        if (recoveryCode) { keepKey(await unwrap(cur.kdf_rec, normCode(recoveryCode))); await upsert({ kdf: await wrap(dekRaw, password) }); }
        else keepKey(await unwrap(cur.kdf, password));
      } catch (e) { session = null; save(); throw new Error(recoveryCode ? "Code de secours incorrect." : "Impossible de déchiffrer tes données avec ce mot de passe."); }
      const out = { state: cur.enc ? await unseal(cur.enc) : null };
      if (!cur.kdf_rec) { const rec = await recoveryFields(dekRaw); await upsert(rec.fields); out.recoveryCode = rec.code; } // comptes créés avant le code de secours
      return out;
    }
    const raw = rand(32); keepKey(raw);
    const rec = await recoveryFields(raw);
    await upsert({ kdf: await wrap(raw, password), ...rec.fields, updated_at: new Date().toISOString() });
    return { state: null, recoveryCode: rec.code };
  }
  async function signup(email, password, code) {
    await invoke("souffle-notify", { mode: "signup", email, password, code }, true);
    return login(email, password);
  }
  /** Mot de passe oublié : le serveur ne reçoit que le hash du code ; la clé est ensuite déverrouillée localement avec le code. */
  async function recover(email, code, newPassword) {
    await invoke("souffle-notify", { mode: "recover", email, password: newPassword, recHash: await sha256(normCode(code)) }, true);
    return login(email, newPassword, code);
  }
  async function newRecovery() { const r = await recoveryFields(dekRaw); await upsert(r.fields); return r.code; }
  function logout() { session = null; dekRaw = null; dek = null; save(); try { localStorage.removeItem(LK); } catch (e) {} }

  async function getState() { const cur = await row(); return cur && cur.enc ? await unseal(cur.enc) : null; }
  /** Envoie l'état chiffré + le strict nécessaire en clair pour la notif du matin. */
  async function putState(state, meta) {
    await upsert({ enc: await seal(state), wake: meta.wake, tz_offset: meta.tzOffset, preview: meta.preview || null, updated_at: new Date().toISOString() });
  }
  async function changePassword(oldPw, newPw) {
    const cur = await row();
    if (!cur || !cur.kdf) throw new Error("Compte sans clé.");
    try { await unwrap(cur.kdf, oldPw); } catch (e) { throw new Error("Mot de passe actuel incorrect."); }
    await refreshIfNeeded();
    const r = await fetch(`${C.supabaseUrl}/auth/v1/user`, { method: "PUT", headers: headers(), body: JSON.stringify({ password: newPw }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.msg || j.error_description || "Changement refusé.");
    await upsert({ kdf: await wrap(dekRaw, newPw) });
  }
  async function deleteAccount() { await invoke("souffle-notify", { mode: "delete" }); logout(); }
  async function savePushSub(r) { await rest("souffle_push_subscriptions?on_conflict=endpoint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(r) }); }
  async function deletePushSub(endpoint) { await rest(`souffle_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); }

  return {
    configured,
    get user() { return session ? session.user : null; },
    get connected() { return !!(session && dekRaw); },
    login, signup, recover, newRecovery, logout, getState, putState, changePassword, deleteAccount, savePushSub, deletePushSub, invoke,
  };
})();

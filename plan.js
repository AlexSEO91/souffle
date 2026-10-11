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

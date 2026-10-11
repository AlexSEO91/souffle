# Souffle — arrêt progressif du tabac (PWA)

Même stack que Shredlog (`~/Claude/Shredlog`) : PWA statique sur GitHub Pages + Supabase (projet **ShredLog**, `zucsemhdglkuifqvhusi`, même compte utilisateur) + notifications Web Push via Edge Function + pg_cron.

## Fichiers
- `index.html` (CSS + squelette), `app.js` (UI, local-first + sync), `plan.js` (logique PARTAGÉE app + Edge Function : quota, heures, bilan), `backend.js` (REST Supabase), `config.js`, `sw.js`, `manifest.webmanifest`, `icons/`.
- `supabase/schema.sql` : tables `souffle_state` (1 ligne jsonb / user), `souffle_push_subscriptions`, `souffle_notification_log`, secret Vault `souffle_cron_secret`, fonction `souffle_private.call_notify`, cron `souffle-tick` (*/15 min).
- `supabase/functions/souffle-notify/index.ts` + `tools/build_edge.sh` → `supabase/deploy/souffle-notify.ts` (plan.js embarqué). Déployer avec `verify_jwt = false` (la fonction vérifie elle-même : secret cron ou JWT utilisateur), comme `shredlog-notify`.
- Réutilise la clé VAPID de Shredlog (secret projet `VAPID_PRIVATE_KEY`, déjà en place) et le secret Vault `shredlog_project_url`.

## Données (`souffle_state.data`)
`{ settings:{start,startDate,endDate,packPrice,packSize,currency,wake,sleep,tzOffset}, log:{"AAAA-MM-JJ":[timestamps ms]}, bilanSeen, updatedAt }`. Journée = bascule à 4 h (heure locale, `tzOffset` en minutes).

## Mise en ligne (première fois)
1. Exécuter `supabase/schema.sql` sur le projet `zucsemhdglkuifqvhusi` (jeton : `~/Claude/Shredlog/.secrets/supabase_token`, même méthode que pour Shredlog). Attendu en fin : 1 ligne `souffle-tick`.
2. `bash tools/build_edge.sh` puis déployer `supabase/deploy/souffle-notify.ts` comme fonction `souffle-notify`, verify_jwt désactivé.
3. `git init`, créer le dépôt **public** `AlexSEO91/souffle`, pousser sur `main`, activer GitHub Pages (branche `main`, racine). URL : https://alexseo91.github.io/souffle/
4. Vérifier que la page charge. Sur l'iPhone : Safari → Partager → Sur l'écran d'accueil, ouvrir l'app, Réglages → Activer les notifications → Tester.

## Mises à jour
Toute modif de `plan.js` → relancer `tools/build_edge.sh` et redéployer la fonction. Incrémenter `VERSION` dans `sw.js` et les `?v=` dans `index.html` à chaque publication.

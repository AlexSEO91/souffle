# Souffle — arrêt progressif du tabac (PWA)

Même stack que Shredlog (`~/Claude/Shredlog`) : PWA statique sur GitHub Pages + Supabase (projet **ShredLog**, `zucsemhdglkuifqvhusi`, même compte utilisateur) + notifications Web Push via Edge Function + pg_cron.

## Fichiers
- `index.html` (CSS + squelette), `app.js` (UI, local-first + sync), `plan.js` (logique PARTAGÉE app + Edge Function : quota, heures, bilan), `backend.js` (REST Supabase), `config.js`, `sw.js`, `manifest.webmanifest`, `icons/`.
- `supabase/schema.sql` : tables `souffle_state` (1 ligne jsonb / user), `souffle_push_subscriptions`, `souffle_notification_log`, secret Vault `souffle_cron_secret`, fonction `souffle_private.call_notify`, cron `souffle-tick` (*/15 min).
- `supabase/functions/souffle-notify/index.ts` + `tools/build_edge.sh` → `supabase/deploy/souffle-notify.ts` (plan.js embarqué). Déployer avec `verify_jwt = false` (la fonction vérifie elle-même : secret cron ou JWT utilisateur), comme `shredlog-notify`.
- Réutilise la clé VAPID de Shredlog (secret projet `VAPID_PRIVATE_KEY`, déjà en place) et le secret Vault `shredlog_project_url`.

## Données — chiffrement de bout en bout (v2)
`souffle_state` : `enc` = état chiffré AES-GCM sur le téléphone ; `kdf` = clé de données emballée par le mot de passe (PBKDF2-SHA256 310k).
En clair : uniquement `wake`, `tz_offset` (heure de la notif) et `preview` (texte de notif, seulement si « Notifications détaillées » activé).
Personne, admin compris, ne peut lire les données.
Récupération : la clé est aussi emballée par un code de secours (`kdf_rec`) affiché une fois à l'inscription (régénérable dans Compte). Le serveur ne stocke que `rec_hash` = SHA-256 du code. « Mot de passe oublié » : mode `recover` (hash du code + nouveau mot de passe) puis déverrouillage local avec le code et ré-emballage. Aucune perte de données.
État déchiffré : `{ settings:{start,startDate,endDate,zeroBuffer,packPrice,packSize,currency,wake,sleep,tzOffset,richPush}, log:{"AAAA-MM-JJ":[ms]}, bilanSeen, setupDone, updatedAt }`. Journée = bascule à 4 h.

## Comptes famille
Inscriptions publiques Supabase FERMÉES. Création de compte via `souffle-notify` mode `signup` + code d'invitation (Vault `souffle_invite_code`).
Lire le code : `select public.souffle_invite_code();` (service role / SQL editor). Mode `delete` : suppression du compte par l'utilisateur.
Verrou Shredlog : `docs`, `shredlog_push_subscriptions` et le bucket `photos` réservés à `public.shredlog_owner()` (compte d'Alex).

## Mise en ligne (première fois)
1. Exécuter `supabase/schema.sql` sur le projet `zucsemhdglkuifqvhusi` (jeton : `~/Claude/Shredlog/.secrets/supabase_token`, même méthode que pour Shredlog). Attendu en fin : 1 ligne `souffle-tick`.
2. `bash tools/build_edge.sh` puis déployer `supabase/deploy/souffle-notify.ts` comme fonction `souffle-notify`, verify_jwt désactivé.
3. `git init`, créer le dépôt **public** `AlexSEO91/souffle`, pousser sur `main`, activer GitHub Pages (branche `main`, racine). URL : https://alexseo91.github.io/souffle/
4. Vérifier que la page charge. Sur l'iPhone : Safari → Partager → Sur l'écran d'accueil, ouvrir l'app, Réglages → Activer les notifications → Tester.

## Mise à jour v3 (annonce de version) — à faire une fois
Exécuter `supabase/schema_v3.sql` (fonction `souffle_private.broadcast`).

## Mise à jour v2 (famille + chiffrement) — déjà faite
1. Exécuter `supabase/schema_v2.sql` sur `zucsemhdglkuifqvhusi`.
1b. (schema_v2.sql inclut aussi kdf_rec, rec_hash, souffle_user_by_email.)
2. `bash tools/build_edge.sh`, redéployer `souffle-notify` (verify_jwt off).
3. Commit + push sur main. Vérifier que https://alexseo91.github.io/souffle/backend.js contient "PBKDF2".
4. Afficher le code d'invitation : `select public.souffle_invite_code();`

## Messages à chaque cigarette
`messages.js` : 44 messages santé (paquet mélangé, pas de répétition avant d'avoir tout vu, état dans localStorage `souffle.deck`), 2 messages argent (~1 fois sur 6, jamais 2 d'affilée), 2 messages hors quota (alternés avec les messages santé). Principe : effet sur le corps + ce qu'on récupère, zéro culpabilisation.

## Publier une nouvelle version (procédure à suivre à CHAQUE mise en ligne)
1. Incrémenter `APP_VERSION` dans app.js, `version` dans changelog.json (même nombre), `VERSION` dans sw.js (souffle-vN) et tous les `?v=N` (index.html + sw.js).
2. Mettre à jour `changelog.json` : `headline` (1 phrase, affichée dans le bandeau) + `items` [emoji, titre, description] (fiche « Quoi de neuf »).
3. Si plan.js a changé : `bash tools/build_edge.sh` + redéployer souffle-notify (verify_jwt off).
4. Commit + push, attendre que GitHub Pages serve la nouvelle version (changelog.json en ligne).
5. Prévenir tout le monde : `select souffle_private.broadcast('Nouvelle version de Souffle ✨', '<headline>. Touche ici puis « Mettre à jour ».');`
Les apps ouvertes détectent aussi seules la nouvelle version (changelog.json) et affichent le bandeau « Mettre à jour ».

## Mises à jour
Toute modif de `plan.js` → relancer `tools/build_edge.sh` et redéployer la fonction. Incrémenter `VERSION` dans `sw.js` et les `?v=` dans `index.html` à chaque publication.

-- Souffle v2 · comptes famille chiffrés + verrou Shredlog. Relançable sans risque.
-- 1) Données Souffle chiffrées côté téléphone : la base ne stocke que du chiffré (enc) et la clé emballée par le mot de passe (kdf).
--    En clair côté serveur : uniquement l'heure de réveil et le fuseau (pour envoyer la notif du matin au bon moment).
alter table public.souffle_state drop column if exists data;
alter table public.souffle_state add column if not exists enc jsonb;          -- {iv, ct} AES-GCM
alter table public.souffle_state add column if not exists kdf jsonb;          -- {salt, iv, wrapped, iter} : clé de données emballée (PBKDF2)
alter table public.souffle_state add column if not exists wake text;          -- "08:00"
alter table public.souffle_state add column if not exists tz_offset int;      -- minutes vs UTC
alter table public.souffle_state add column if not exists preview jsonb;      -- notif détaillée, seulement si l'utilisateur l'active

-- 2) Code d'invitation (inscriptions publiques fermées : on crée les comptes via la fonction, avec ce code)
select vault.create_secret('SOUFFLE-' || upper(substr(md5(gen_random_uuid()::text), 1, 8)), 'souffle_invite_code')
 where not exists (select 1 from vault.secrets where name = 'souffle_invite_code');
create or replace function public.souffle_invite_code()
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'souffle_invite_code'
$$;
revoke execute on function public.souffle_invite_code() from public, anon, authenticated;
grant execute on function public.souffle_invite_code() to service_role;

-- 3) Verrou Shredlog : données, abonnements push et photos réservés au compte d'Alex
create or replace function public.shredlog_owner() returns uuid language sql immutable set search_path = '' as $$
  select '522870ea-b66b-4e64-aec8-d7557cfdbb28'::uuid
$$;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all
  using (auth.uid() = user_id and auth.uid() = public.shredlog_owner())
  with check (auth.uid() = user_id and auth.uid() = public.shredlog_owner());
drop policy if exists "own push subscriptions" on public.shredlog_push_subscriptions;
create policy "own push subscriptions" on public.shredlog_push_subscriptions for all
  using (auth.uid() = user_id and auth.uid() = public.shredlog_owner())
  with check (auth.uid() = user_id and auth.uid() = public.shredlog_owner());
drop policy if exists "own photos" on storage.objects;
create policy "own photos" on storage.objects for all
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and auth.uid() = public.shredlog_owner())
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and auth.uid() = public.shredlog_owner());

-- 4) Récupération sans perte : la clé de données est AUSSI emballée par un code de secours (connu du seul utilisateur).
--    Le serveur ne stocke que le SHA-256 du code (pour autoriser le changement de mot de passe), jamais le code lui-même.
alter table public.souffle_state add column if not exists kdf_rec jsonb;
alter table public.souffle_state add column if not exists rec_hash text;
create or replace function public.souffle_user_by_email(p_email text)
returns uuid language sql security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;
revoke execute on function public.souffle_user_by_email(text) from public, anon, authenticated;
grant execute on function public.souffle_user_by_email(text) to service_role;

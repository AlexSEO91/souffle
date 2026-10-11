-- Souffle · à exécuter UNE fois (relançable sans risque). Projet Supabase : zucsemhdglkuifqvhusi (ShredLog, même compte).
-- Réutilise le secret Vault 'shredlog_project_url' et la clé VAPID de Shredlog (secret VAPID_PRIVATE_KEY du projet).

create table if not exists public.souffle_state (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.souffle_state enable row level security;
drop policy if exists "own state" on public.souffle_state;
create policy "own state" on public.souffle_state for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.souffle_state to authenticated;

create table if not exists public.souffle_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.souffle_push_subscriptions enable row level security;
drop policy if exists "own push subscriptions" on public.souffle_push_subscriptions;
create policy "own push subscriptions" on public.souffle_push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.souffle_push_subscriptions to authenticated;

create table if not exists public.souffle_notification_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  last_sent date not null,
  primary key (user_id, key)
);
alter table public.souffle_notification_log enable row level security;
revoke all on public.souffle_notification_log from anon, authenticated;
grant select, insert, update, delete on public.souffle_notification_log to service_role;

select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'souffle_cron_secret')
 where not exists (select 1 from vault.secrets where name = 'souffle_cron_secret');

create or replace function public.souffle_cron_secret()
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'souffle_cron_secret'
$$;
revoke execute on function public.souffle_cron_secret() from public, anon, authenticated;
grant execute on function public.souffle_cron_secret() to service_role;

create schema if not exists souffle_private;
revoke all on schema souffle_private from public, anon, authenticated;
create or replace function souffle_private.call_notify(p_mode text)
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'shredlog_project_url') || '/functions/v1/souffle-notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'souffle_cron_secret')),
    body := jsonb_build_object('mode', p_mode),
    timeout_milliseconds := 60000)
$$;
revoke execute on function souffle_private.call_notify(text) from public, anon, authenticated;

-- Toutes les 15 min (UTC, peu importe) : la fonction envoie le bilan une seule fois par jour,
-- au premier passage après l'heure de réveil réglée dans l'app, dans le fuseau du téléphone.
select cron.schedule('souffle-tick', '*/15 * * * *', $$ select souffle_private.call_notify('tick') $$);

-- Vérification : 1 ligne attendue
select jobname, schedule from cron.job where jobname = 'souffle-tick';

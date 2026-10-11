-- Souffle v3 · annonce de mise à jour à tous les appareils. Relançable.
-- Usage après chaque publication :
--   select souffle_private.broadcast('Nouvelle version de Souffle ✨', '<nouveauté en une phrase>. Touche ici puis « Mettre à jour ».');
create or replace function souffle_private.broadcast(p_title text, p_body text)
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'shredlog_project_url') || '/functions/v1/souffle-notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'souffle_cron_secret')),
    body := jsonb_build_object('mode', 'broadcast', 'title', p_title, 'body', p_body),
    timeout_milliseconds := 60000)
$$;
revoke execute on function souffle_private.broadcast(text, text) from public, anon, authenticated;

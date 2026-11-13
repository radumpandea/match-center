-- Match Center: "refresh the referee delegation" button.
-- Idempotent. Applied by .github/workflows/supabase-sql.yml (mode "apply"; "test" runs it in a transaction that is
-- rolled back, with supabase/tests/delegations_test.sql).
--
-- The match page cannot start a GitHub workflow itself (that needs a token). Like the favourite -> deep build
-- trigger in docs/supabase.sql, this function does it from the database with the fine-grained PAT stored in Vault
-- as 'github_actions_pat' (Actions: write on this repo only): it dispatches fetch-delegations.yml with the match's
-- slug, and that job reads the FRF CCA delegations page again for the round of this match and updates the pack.
--
-- Guards, because anyone with the public page can call it: a signed-in user only (anonymous sign-in counts), one
-- request per user per minute, at most 40 per day in total; the slug is checked for shape and by the workflow
-- against fixtures.json. Everything else the function returns as { ok: false, reason }.

create extension if not exists pg_net;

create table if not exists public.mc_dispatch_log (
  id bigserial primary key,
  kind text not null,
  slug text,
  user_id uuid,
  at timestamptz not null default now()
);
create index if not exists mc_dispatch_log_kind_at on public.mc_dispatch_log (kind, at desc);
alter table public.mc_dispatch_log enable row level security;   -- no policies: not readable or writable through the API

create or replace function public.mc_request_delegations(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  gh_token text;
  uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  if p_slug is null or p_slug !~ '^[a-z0-9-]{3,120}$' then return jsonb_build_object('ok', false, 'reason', 'bad_slug'); end if;
  if exists (select 1 from public.mc_dispatch_log where kind = 'delegations' and user_id = uid and at > now() - interval '60 seconds') then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;
  if (select count(*) from public.mc_dispatch_log where kind = 'delegations' and at > now() - interval '24 hours') >= 40 then
    return jsonb_build_object('ok', false, 'reason', 'daily_limit');
  end if;

  select decrypted_secret into gh_token from vault.decrypted_secrets where name = 'github_actions_pat' limit 1;
  if gh_token is null then return jsonb_build_object('ok', false, 'reason', 'not_configured'); end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/radumpandea/match-center/actions/workflows/fetch-delegations.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || gh_token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'X-GitHub-Api-Version', '2022-11-28'
    ),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('slug', p_slug))
  );
  insert into public.mc_dispatch_log (kind, slug, user_id) values ('delegations', p_slug, uid);
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'reason', 'error');
end;
$$;

revoke all on function public.mc_request_delegations(text) from public, anon;
grant execute on function public.mc_request_delegations(text) to authenticated;

-- Match Center: live score and events (goals, cards, VAR, substitutions) from API-Football.
-- Idempotent. Applied by .github/workflows/supabase-sql.yml (mode "apply"; "test" runs it in a transaction that is
-- rolled back, together with supabase/tests/live_test.sql).
--
-- How it works: pg_cron calls the Edge Function `live-poll` every 30 s. The function holds the API key (secret
-- APIFOOTBALL_KEY, the same one api-lineups uses), asks API-Football for the matches in progress in the watched
-- leagues, and writes what it gets into these tables. The match page reads them with the public anon key (select only).
--
-- The function is public (verify_jwt = false: the database calls it without a user), so it protects the daily request
-- quota itself through mc_live_claim(): at most one poll per 20 s while something is being played (per 170 s otherwise)
-- and at most p_daily_cap polls per UTC day, however many times it is called.
-- Events are mutable (scorer filled in later, minute corrected, goals cancelled by VAR), see
-- supabase/functions/_shared/live-reconcile.mjs.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---- what to watch: league ids as API-Football numbers them. Add a row to follow another competition.
create table if not exists public.mc_live_leagues (
  league_id int primary key,
  name text
);
insert into public.mc_live_leagues (league_id, name) values
  (39, 'Premier League'), (61, 'Ligue 1'), (140, 'LaLiga'), (135, 'Serie A'), (78, 'Bundesliga'), (79, '2. Bundesliga'),
  (283, 'Superliga'), (284, 'Liga 2'), (5, 'UEFA Nations League'), (2, 'Champions League'),
  (3, 'Europa League'), (848, 'Conference League'), (94, 'Primeira Liga'), (285, 'Cupa României'), (137, 'Coppa Italia'),
  (17, 'AFC Champions League')
on conflict (league_id) do nothing;

create table if not exists public.mc_live_fixtures (
  fixture_id bigint primary key,
  league_id int,
  home_team_id int,
  away_team_id int,
  home_name text,
  away_name text,
  kickoff timestamptz,
  status text,                       -- API short status: NS 1H HT 2H ET BT P FT AET PEN SUSP INT PST CANC ABD ...
  elapsed int,
  extra int,
  home_goals int,
  away_goals int,
  finished boolean not null default false,
  empty_polls int not null default 0,  -- consecutive polls that returned no events while some are stored
  fetched_at timestamptz not null default now(),   -- last time the API confirmed this fixture
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mc_live_fixtures_open on public.mc_live_fixtures (finished) where not finished;

create table if not exists public.mc_live_events (
  id bigserial primary key,
  fixture_id bigint not null references public.mc_live_fixtures (fixture_id) on delete cascade,
  type text not null,                -- Goal | Card | subst | Var
  detail text,                       -- Normal Goal | Own Goal | Penalty | Missed Penalty | Yellow Card | Red Card | ...
  minute int,
  extra int,
  team_id int,
  player_id int,
  player_name text,
  assist_id int,                     -- for subst: the player coming on
  assist_name text,
  comments text,
  present boolean not null default true,   -- false = the API took it away (VAR, correction): kept so it can be shown as cancelled
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  edited_at timestamptz,             -- last time a stored field was changed by a later poll
  edits int not null default 0,
  removed_at timestamptz
);
create index if not exists mc_live_events_fixture on public.mc_live_events (fixture_id, minute, id);

create table if not exists public.mc_live_state (
  id int primary key check (id = 1),
  last_poll_at timestamptz not null default 'epoch',
  active_until timestamptz not null default 'epoch',   -- a match was in progress recently: poll fast until then
  day date not null default (now() at time zone 'utc')::date,
  requests_today int not null default 0,
  last_ok_at timestamptz,
  last_error text
);
insert into public.mc_live_state (id) values (1) on conflict (id) do nothing;

-- Readable by everyone through the API, writable only by the function (service role bypasses RLS).
alter table public.mc_live_leagues enable row level security;
alter table public.mc_live_fixtures enable row level security;
alter table public.mc_live_events enable row level security;
alter table public.mc_live_state enable row level security;
drop policy if exists mc_live_read on public.mc_live_fixtures;
create policy mc_live_read on public.mc_live_fixtures for select to anon, authenticated using (true);
drop policy if exists mc_live_read on public.mc_live_events;
create policy mc_live_read on public.mc_live_events for select to anon, authenticated using (true);
-- mc_live_leagues and mc_live_state: no policy = not readable through the API.
-- Supabase grants everything to the API roles by default; keep them to select only, and only on the two public tables.
revoke all on public.mc_live_leagues, public.mc_live_fixtures, public.mc_live_events, public.mc_live_state from anon, authenticated;
grant select on public.mc_live_fixtures, public.mc_live_events to anon, authenticated;

-- One poll at a time, and not more often than the quota allows. Returns { ok, reason, leagues? }.
create or replace function public.mc_live_claim(p_active_gap int default 20, p_idle_gap int default 170, p_daily_cap int default 3500)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.mc_live_state%rowtype;
  gap int;
begin
  select * into s from public.mc_live_state where id = 1 for update;
  if s.day <> (now() at time zone 'utc')::date then
    s.day := (now() at time zone 'utc')::date; s.requests_today := 0;
  end if;
  gap := case when s.active_until > now() then p_active_gap else p_idle_gap end;
  if now() - s.last_poll_at < make_interval(secs => gap) then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;
  if s.requests_today >= p_daily_cap then
    return jsonb_build_object('ok', false, 'reason', 'daily_cap');
  end if;
  update public.mc_live_state
     set last_poll_at = now(), day = s.day, requests_today = s.requests_today + 1
   where id = 1;
  return jsonb_build_object('ok', true, 'leagues', (select coalesce(jsonb_agg(league_id), '[]'::jsonb) from public.mc_live_leagues));
end;
$$;

-- Called by the function when it is done: extra API requests it made, whether something is in progress, any error.
create or replace function public.mc_live_done(p_extra_requests int default 0, p_active boolean default false, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mc_live_state
     set requests_today = requests_today + greatest(p_extra_requests, 0),
         active_until = case when p_active then now() + interval '10 minutes' else active_until end,
         last_error = p_error,
         last_ok_at = case when p_error is null then now() else last_ok_at end
   where id = 1;
end;
$$;

revoke all on function public.mc_live_claim(int, int, int) from public, anon, authenticated;
revoke all on function public.mc_live_done(int, boolean, text) from public, anon, authenticated;
grant execute on function public.mc_live_claim(int, int, int) to service_role;
grant execute on function public.mc_live_done(int, boolean, text) to service_role;

-- ---- schedule: the poll every 30 s, and a daily cleanup of the cron history (2880 runs/day otherwise pile up)
select cron.unschedule(jobname) from cron.job where jobname in ('mc-live-poll', 'mc-live-cron-cleanup');

select cron.schedule('mc-live-poll', '30 seconds', $job$
  select net.http_post(
    url := 'https://jcanxrqtlaemyklxnoit.supabase.co/functions/v1/live-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
$job$);

select cron.schedule('mc-live-cron-cleanup', '17 4 * * *', $job$
  delete from cron.job_run_details where end_time < now() - interval '2 days';
$job$);

-- Run by .github/workflows/supabase-sql.yml in "test" mode, after supabase/live.sql, inside a transaction that is
-- rolled back. The workflow looks for the exact phrase printed at the end.
do $$
declare
  r jsonb;
begin
  -- first claim goes through and returns the watched leagues
  update public.mc_live_state set last_poll_at = 'epoch', active_until = 'epoch', requests_today = 0 where id = 1;
  r := public.mc_live_claim();
  if (r->>'ok')::boolean is not true then raise exception 'first claim should pass: %', r; end if;
  if jsonb_array_length(r->'leagues') < 1 then raise exception 'leagues must be returned'; end if;

  -- an immediate second claim is refused (idle gap 170 s)
  r := public.mc_live_claim();
  if r->>'reason' <> 'too_soon' then raise exception 'second claim should be too_soon: %', r; end if;

  -- while something is in progress the gap is 20 s: 10 s ago is refused, 30 s ago passes
  perform public.mc_live_done(0, true, null);
  update public.mc_live_state set last_poll_at = now() - interval '10 seconds' where id = 1;
  if (public.mc_live_claim()->>'reason') <> 'too_soon' then raise exception 'active gap: 10 s must be too soon'; end if;
  update public.mc_live_state set last_poll_at = now() - interval '30 seconds' where id = 1;
  if (public.mc_live_claim()->>'ok')::boolean is not true then raise exception 'active gap: 30 s must pass'; end if;

  -- the daily cap
  update public.mc_live_state set last_poll_at = 'epoch', requests_today = 3500 where id = 1;
  if (public.mc_live_claim()->>'reason') <> 'daily_cap' then raise exception 'cap must stop the poll'; end if;
  -- a new day resets the counter
  update public.mc_live_state set day = (now() at time zone 'utc')::date - 1 where id = 1;
  if (public.mc_live_claim()->>'ok')::boolean is not true then raise exception 'a new day must reset the counter'; end if;

  -- anon / signed-in users cannot run the polling functions; the tables are read-only for them
  if has_function_privilege('anon', 'public.mc_live_claim(int,int,int)', 'execute')
     or has_function_privilege('authenticated', 'public.mc_live_claim(int,int,int)', 'execute') then
    raise exception 'only service_role may claim';
  end if;
  if has_function_privilege('anon', 'public.mc_live_done(int,boolean,text)', 'execute') then raise exception 'anon must not call mc_live_done'; end if;
  if has_table_privilege('anon', 'public.mc_live_events', 'insert') or has_table_privilege('authenticated', 'public.mc_live_fixtures', 'update') then
    raise exception 'live tables must not be writable through the API';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.mc_live_events'::regclass) then raise exception 'RLS on mc_live_events'; end if;
  if (select relrowsecurity from pg_class where oid = 'public.mc_live_state'::regclass) is not true then raise exception 'RLS on mc_live_state'; end if;

  -- the cron job is registered
  if not exists (select 1 from cron.job where jobname = 'mc-live-poll' and schedule = '30 seconds') then raise exception 'mc-live-poll must be scheduled'; end if;
end
$$;

select 'ALL ACCESS TESTS PASSED' as result;

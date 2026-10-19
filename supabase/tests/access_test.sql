-- Tests for supabase/access.sql. Run by .github/workflows/supabase-sql.yml in mode "test", which wraps
-- access.sql + this file in BEGIN ... ROLLBACK, so nothing is ever kept. Any failed check raises an exception
-- (the workflow then fails); the last statement returns "ALL ACCESS TESTS PASSED".

create or replace function public._t_as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

create or replace function public._t_check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'TEST FAILED: %', p_what; end if;
end;
$$;

-- two test users (rolled back with everything else)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'test-a@example.invalid'),
  ('00000000-0000-0000-0000-0000000000b2', 'test-b@example.invalid');

-- three packs: one standard, two premium
insert into public.mc_packs (slug, premium, doc, hash) values
  ('t-standard', false, '{"teams":{"home":{"name":"H1"},"away":{"name":"A1"}},"kickoff":"2026-10-20T20:00:00+03:00","competition":{"name":"Liga"}}', 'h1'),
  ('t-premium-1', true,  '{"teams":{"home":{"name":"H2"},"away":{"name":"A2"}},"kickoff":"2026-10-21T20:00:00+03:00","competition":{"name":"Liga"}}', 'h2'),
  ('t-premium-2', true,  '{"teams":{"home":{"name":"H3"},"away":{"name":"A3"}},"kickoff":"2026-10-22T20:00:00+03:00","competition":{"name":"Liga"}}', 'h3');

set local role authenticated;

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  r jsonb;
begin
  perform public._t_as_user(a);

  -- ---------- devices: two slots
  r := public.mc_device_heartbeat('device-0001', 'Chrome, Windows');
  perform public._t_check((r->>'ok')::boolean, 'first device registers');
  r := public.mc_device_heartbeat('device-0002', 'Safari, iPhone');
  perform public._t_check((r->>'ok')::boolean, 'second device registers');
  r := public.mc_device_heartbeat('device-0003', 'Firefox, Mac');
  perform public._t_check(not (r->>'ok')::boolean and r->>'reason' = 'limit', 'third device is refused');
  perform public._t_check(jsonb_array_length(r->'devices') = 2, 'the refusal lists the two active devices');
  r := public.mc_device_heartbeat('device-0001', 'Chrome, Windows');
  perform public._t_check((r->>'ok')::boolean, 'a registered device keeps its slot on heartbeat');

  -- ---------- takeover
  r := public.mc_device_takeover('device-0003', 'device-0001', 'Firefox, Mac');
  perform public._t_check((r->>'ok')::boolean, 'takeover registers the new device');
  r := public.mc_device_heartbeat('device-0001', 'Chrome, Windows');
  perform public._t_check(not (r->>'ok')::boolean and r->>'reason' = 'limit', 'the taken-over device is out');
  r := public.mc_device_takeover('device-0003', 'nope-nope-1', 'Firefox, Mac');
  perform public._t_check((r->>'ok')::boolean and jsonb_array_length(r->'devices') = 2, 'taking over an unknown device changes nothing');

  -- ---------- release + stale
  r := public.mc_device_release('device-0002');
  perform public._t_check((r->>'ok')::boolean, 'release works');
  r := public.mc_device_heartbeat('device-0001', 'Chrome, Windows');
  perform public._t_check((r->>'ok')::boolean, 'a freed slot can be used again');
end $$;

reset role;
update public.mc_devices set last_seen = now() - interval '200 seconds' where device_id = 'device-0003';
set local role authenticated;

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  r jsonb;
begin
  perform public._t_as_user(a);
  r := public.mc_device_heartbeat('device-0004', 'Edge, Windows');
  perform public._t_check((r->>'ok')::boolean, 'a device silent for 200 s no longer holds a slot');
  perform public._t_check(jsonb_array_length(r->'devices') = 2, 'only the two live devices remain');
  r := public.mc_device_heartbeat('x', 'bad');
  perform public._t_check(r->>'reason' = 'bad_device', 'a too-short device id is rejected');
end $$;

-- ---------- packs: standard, free month, locked, subscriber
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  r jsonb;
begin
  perform public._t_as_user(a);
  r := public.mc_get_pack('t-standard', 'device-0001');
  perform public._t_check((r->>'ok')::boolean and r->>'access' = 'standard' and r->'doc' is not null, 'standard pack opens');
  r := public.mc_get_pack('t-standard', 'unknown-device-1');
  perform public._t_check(not (r->>'ok')::boolean and r->>'error' = 'device', 'a device without a slot gets nothing');
  r := public.mc_get_pack('t-premium-1', 'device-0001');
  perform public._t_check((r->>'ok')::boolean and r->>'access' = 'free_month', 'first premium pack of the month is free');
  r := public.mc_get_pack('t-premium-1', 'device-0001');
  perform public._t_check((r->>'ok')::boolean and r->>'access' = 'free_month', 'the same premium pack can be reopened');
  r := public.mc_get_pack('t-premium-2', 'device-0001');
  perform public._t_check(not (r->>'ok')::boolean and r->>'error' = 'locked' and r->>'free_slug' = 't-premium-1', 'a second premium pack is locked');
  perform public._t_check(r->'teaser'->>'home' = 'H3' and (r -> 'doc') is null, 'the locked answer has a teaser and no pack');
  r := public.mc_get_pack('missing', 'device-0001');
  perform public._t_check(r->>'error' = 'not_found', 'unknown slug');
  r := public.mc_my_access();
  perform public._t_check(not (r->>'subscriber')::boolean and (r->>'free_used')::boolean, 'my_access reflects the free use');
end $$;

-- next month the free right is back
reset role;
update public.mc_free_premium_use set month = (month - interval '1 month')::date;
set local role authenticated;

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  r jsonb;
begin
  perform public._t_as_user(a);
  r := public.mc_get_pack('t-premium-2', 'device-0001');
  perform public._t_check((r->>'ok')::boolean and r->>'access' = 'free_month', 'a new month gives a new free premium pack');
end $$;

-- subscribers
reset role;
insert into public.mc_entitlements (user_id, status, current_period_end) values ('00000000-0000-0000-0000-0000000000a1', 'active', now() + interval '20 days');
set local role authenticated;

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  r jsonb;
begin
  perform public._t_as_user(a);
  r := public.mc_get_pack('t-premium-1', 'device-0001');
  perform public._t_check((r->>'ok')::boolean and r->>'access' = 'subscriber', 'an active subscriber opens any premium pack');
end $$;

reset role;
update public.mc_entitlements set status = 'canceled', current_period_end = now() - interval '1 day';
delete from public.mc_free_premium_use;
insert into public.mc_free_premium_use (user_id, month, slug) values ('00000000-0000-0000-0000-0000000000a1', (date_trunc('month', now() at time zone 'Europe/Bucharest'))::date, 't-premium-2');
set local role authenticated;

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  r jsonb;
begin
  perform public._t_as_user(a);
  r := public.mc_get_pack('t-premium-1', 'device-0001');
  perform public._t_check(r->>'error' = 'locked', 'a canceled subscription past its end date is locked again');
end $$;

reset role;
update public.mc_entitlements set current_period_end = now() + interval '5 days';
set local role authenticated;

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  r jsonb;
begin
  perform public._t_as_user(a);
  r := public.mc_get_pack('t-premium-1', 'device-0001');
  perform public._t_check((r->>'ok')::boolean and r->>'access' = 'subscriber', 'a canceled subscription still works until the paid period ends');
end $$;

-- ---------- the API itself must not reach the tables or the other user's data
do $$
declare
  b constant uuid := '00000000-0000-0000-0000-0000000000b2';
  r jsonb;
  denied boolean;
begin
  perform public._t_as_user(b);
  begin
    perform 1 from public.mc_packs limit 1;
    denied := false;
  exception when insufficient_privilege then denied := true;
  end;
  perform public._t_check(denied, 'authenticated users cannot select from mc_packs');
  begin
    perform 1 from public.mc_devices limit 1;
    denied := false;
  exception when insufficient_privilege then denied := true;
  end;
  perform public._t_check(denied, 'authenticated users cannot select from mc_devices');
  r := public.mc_my_access();
  perform public._t_check(not (r->>'subscriber')::boolean, 'user B does not inherit user A''s subscription');
  r := public.mc_get_pack('t-standard', 'device-0001');
  perform public._t_check(r->>'error' = 'device', 'user B cannot use user A''s device id');
  begin
    insert into public.mc_entitlements (user_id, status) values ('00000000-0000-0000-0000-0000000000b2', 'active');
    denied := false;
  exception when others then denied := true;
  end;
  perform public._t_check(denied, 'a user cannot grant himself a subscription');
end $$;

reset role;
set local role anon;

do $$
declare
  denied boolean;
begin
  begin
    perform public.mc_get_pack('t-standard', 'device-0001');
    denied := false;
  exception when insufficient_privilege then denied := true;
  end;
  perform public._t_check(denied, 'anonymous visitors cannot call mc_get_pack');
  begin
    perform public.mc_device_heartbeat('device-0009', 'x');
    denied := false;
  exception when insufficient_privilege then denied := true;
  end;
  perform public._t_check(denied, 'anonymous visitors cannot register devices');
end $$;

reset role;
select 'ALL ACCESS TESTS PASSED' as result;

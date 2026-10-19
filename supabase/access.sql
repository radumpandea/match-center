-- Match Center: access control (who may open which match pack, from how many devices).
-- Idempotent: safe to run again. Applied by .github/workflows/supabase-sql.yml (mode "apply"); the same
-- workflow can first run supabase/tests/access_test.sql against it inside a transaction that is rolled back.
--
-- Rules (decided 2026-10-19):
--   * Standard packs: any signed-in user.
--   * Premium (deep) packs: subscribers; everybody else gets ONE premium match per calendar month
--     (Europe/Bucharest), reopenable that month.
--   * A user can have at most 2 devices open at the same time (a device counts while its heartbeat is
--     less than 150 s old).
--   * The packs live in mc_packs, which the API cannot read: only mc_get_pack() hands them out.

-- ---------------------------------------------------------------- subscriptions
create table if not exists public.mc_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'none' check (status in ('none', 'active', 'past_due', 'canceled', 'expired')),
  current_period_end timestamptz,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  updated_at timestamptz not null default now()
);
alter table public.mc_entitlements enable row level security;
drop policy if exists "users read own entitlement" on public.mc_entitlements;
create policy "users read own entitlement" on public.mc_entitlements for select to authenticated using (auth.uid() = user_id);
-- no insert/update policy: only the service role (the payment webhook) writes here

-- ---------------------------------------------------------------- packs
create table if not exists public.mc_packs (
  slug text primary key,
  premium boolean not null default false,
  doc jsonb not null,
  i18n jsonb,
  hash text not null,
  kickoff timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.mc_packs enable row level security;
revoke all on public.mc_packs from anon, authenticated;

-- ---------------------------------------------------------------- devices, free use, opens
create table if not exists public.mc_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  label text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.mc_devices enable row level security;
revoke all on public.mc_devices from anon, authenticated;

create table if not exists public.mc_free_premium_use (
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null,
  slug text not null,
  opened_at timestamptz not null default now(),
  primary key (user_id, month)
);
alter table public.mc_free_premium_use enable row level security;
revoke all on public.mc_free_premium_use from anon, authenticated;

create table if not exists public.mc_pack_opens (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  opened_at timestamptz not null default now()
);
create index if not exists mc_pack_opens_user_time on public.mc_pack_opens (user_id, opened_at);
alter table public.mc_pack_opens enable row level security;
revoke all on public.mc_pack_opens from anon, authenticated;

-- ---------------------------------------------------------------- functions
create or replace function public.mc_is_subscriber(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.mc_entitlements e
    where e.user_id = p_uid
      and (
        (e.status = 'active' and (e.current_period_end is null or e.current_period_end > now() - interval '3 days'))
        or (e.status in ('canceled', 'past_due') and e.current_period_end is not null and e.current_period_end > now())
      )
  );
$$;

create or replace function public._mc_devices_json(p_uid uuid, p_me text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('device_id', device_id, 'label', label, 'last_seen', last_seen, 'is_me', device_id = p_me) order by first_seen), '[]'::jsonb)
  from public.mc_devices where user_id = p_uid and last_seen > now() - interval '150 seconds';
$$;

-- Heartbeat + registration. Called when the page opens and every ~60 s. Returns
--   {ok:true, devices:[...]}                         this device holds a slot
--   {ok:false, reason:'limit', devices:[...]}        two OTHER devices are active
--   {ok:false, reason:'auth' | 'bad_device'}
create or replace function public.mc_device_heartbeat(p_device text, p_label text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  mine boolean;
  active int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if p_device is null or length(p_device) < 8 or length(p_device) > 80 then return jsonb_build_object('ok', false, 'reason', 'bad_device'); end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  delete from public.mc_devices where user_id = uid and last_seen < now() - interval '150 seconds';
  select exists (select 1 from public.mc_devices where user_id = uid and device_id = p_device) into mine;
  if mine then
    update public.mc_devices set last_seen = now(), label = coalesce(nullif(left(p_label, 80), ''), label) where user_id = uid and device_id = p_device;
  else
    select count(*) into active from public.mc_devices where user_id = uid;
    if active >= 2 then
      return jsonb_build_object('ok', false, 'reason', 'limit', 'devices', public._mc_devices_json(uid, p_device));
    end if;
    insert into public.mc_devices (user_id, device_id, label) values (uid, p_device, left(coalesce(p_label, ''), 80));
  end if;
  return jsonb_build_object('ok', true, 'devices', public._mc_devices_json(uid, p_device));
end;
$$;

-- "Use it here instead": drops p_target and registers this device.
create or replace function public.mc_device_takeover(p_device text, p_target text, p_label text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if p_device is null or length(p_device) < 8 or length(p_device) > 80 then return jsonb_build_object('ok', false, 'reason', 'bad_device'); end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  delete from public.mc_devices where user_id = uid and device_id = p_target and device_id <> p_device;
  return public.mc_device_heartbeat(p_device, p_label);
end;
$$;

-- Frees the slot (sign-out, tab closing).
create or replace function public.mc_device_release(p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  delete from public.mc_devices where user_id = uid and device_id = p_device;
  return jsonb_build_object('ok', true);
end;
$$;

-- What the signed-in user may do right now (for the UI).
create or replace function public.mc_my_access() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_month date := (date_trunc('month', now() at time zone 'Europe/Bucharest'))::date;
  v_slug text;
  v_end timestamptz;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  select slug into v_slug from public.mc_free_premium_use where user_id = uid and month = v_month;
  select current_period_end into v_end from public.mc_entitlements where user_id = uid;
  return jsonb_build_object('ok', true, 'subscriber', public.mc_is_subscriber(uid), 'period_end', v_end, 'free_slug', v_slug, 'free_used', v_slug is not null);
end;
$$;

-- The only way to read a pack.
--   {ok:true, access:'standard'|'subscriber'|'free_month', doc:{...}, i18n:{...}|null}
--   {ok:false, error:'auth'|'device'|'rate'|'not_found'}
--   {ok:false, error:'locked', free_slug:'..'|null, teaser:{home,away,kickoff,competition}}   premium, no right to it
create or replace function public.mc_get_pack(p_slug text, p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pk public.mc_packs%rowtype;
  v_month date := (date_trunc('month', now() at time zone 'Europe/Bucharest'))::date;
  v_used text;
  v_access text;
  v_n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  if not exists (select 1 from public.mc_devices where user_id = uid and device_id = p_device and last_seen > now() - interval '300 seconds') then
    return jsonb_build_object('ok', false, 'error', 'device');
  end if;
  select * into pk from public.mc_packs where slug = p_slug;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  -- scraping brake: at most 60 distinct packs per rolling day
  select count(distinct slug) into v_n from public.mc_pack_opens where user_id = uid and opened_at > now() - interval '24 hours';
  if v_n >= 60 and not exists (select 1 from public.mc_pack_opens where user_id = uid and slug = p_slug and opened_at > now() - interval '24 hours') then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;

  if not pk.premium then
    v_access := 'standard';
  elsif public.mc_is_subscriber(uid) then
    v_access := 'subscriber';
  else
    select slug into v_used from public.mc_free_premium_use where user_id = uid and month = v_month;
    if v_used is null then
      insert into public.mc_free_premium_use (user_id, month, slug) values (uid, v_month, p_slug);
      v_access := 'free_month';
    elsif v_used = p_slug then
      v_access := 'free_month';
    else
      return jsonb_build_object('ok', false, 'error', 'locked', 'free_slug', v_used, 'teaser', jsonb_build_object(
        'home', pk.doc #>> '{teams,home,name}', 'away', pk.doc #>> '{teams,away,name}',
        'kickoff', pk.doc ->> 'kickoff', 'competition', pk.doc #>> '{competition,name}'));
    end if;
  end if;

  insert into public.mc_pack_opens (user_id, slug) values (uid, p_slug);
  delete from public.mc_pack_opens where user_id = uid and opened_at < now() - interval '3 days';
  return jsonb_build_object('ok', true, 'access', v_access, 'doc', pk.doc, 'i18n', pk.i18n);
end;
$$;

-- who may call what
revoke execute on function public.mc_is_subscriber(uuid) from public, anon, authenticated;
revoke execute on function public._mc_devices_json(uuid, text) from public, anon, authenticated;
revoke execute on function public.mc_device_heartbeat(text, text) from public, anon;
revoke execute on function public.mc_device_takeover(text, text, text) from public, anon;
revoke execute on function public.mc_device_release(text) from public, anon;
revoke execute on function public.mc_my_access() from public, anon;
revoke execute on function public.mc_get_pack(text, text) from public, anon;
grant execute on function public.mc_device_heartbeat(text, text) to authenticated;
grant execute on function public.mc_device_takeover(text, text, text) to authenticated;
grant execute on function public.mc_device_release(text) to authenticated;
grant execute on function public.mc_my_access() to authenticated;
grant execute on function public.mc_get_pack(text, text) to authenticated;

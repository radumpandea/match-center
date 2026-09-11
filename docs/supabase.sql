-- Run once in Supabase Dashboard -> SQL Editor. Users authenticate with their
-- email magic link, so favourites and edits travel between their devices.
create table if not exists public.mc_match_state (
  match_slug text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_by_name text not null default 'Utilizator',
  updated_at timestamptz not null default now()
);

create table if not exists public.mc_match_changes (
  id bigint generated always as identity primary key,
  match_slug text not null,
  user_id uuid not null references auth.users(id),
  display_name text not null,
  summary text not null,
  changed_at timestamptz not null default now()
);

create table if not exists public.mc_favourites (
  user_id uuid not null references auth.users(id),
  match_slug text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, match_slug)
);

alter table public.mc_match_state enable row level security;
alter table public.mc_match_changes enable row level security;
alter table public.mc_favourites enable row level security;

-- drop-then-create so this whole file can be re-run safely on a project that
-- already has these (e.g. to pick up the cap trigger / RPC added below).
drop policy if exists "authenticated users read shared match state" on public.mc_match_state;
create policy "authenticated users read shared match state" on public.mc_match_state for select to authenticated using (true);
drop policy if exists "authenticated users write shared match state" on public.mc_match_state;
create policy "authenticated users write shared match state" on public.mc_match_state for insert to authenticated with check (auth.uid() = updated_by);
drop policy if exists "authenticated users update shared match state" on public.mc_match_state;
create policy "authenticated users update shared match state" on public.mc_match_state for update to authenticated using (true) with check (auth.uid() = updated_by);
drop policy if exists "authenticated users read change log" on public.mc_match_changes;
create policy "authenticated users read change log" on public.mc_match_changes for select to authenticated using (true);
drop policy if exists "authors add their change log entries" on public.mc_match_changes;
create policy "authors add their change log entries" on public.mc_match_changes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "users manage own favourites" on public.mc_favourites;
create policy "users manage own favourites" on public.mc_favourites for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ALTER PUBLICATION ... ADD TABLE errors if the table is already a member,
-- so guard it instead of a bare statement.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mc_match_state'
  ) then
    alter publication supabase_realtime add table public.mc_match_state;
  end if;
end $$;

-- Hard cap of 4 favourites per user, enforced server-side (the client also
-- checks this before writing, but this is the real guard — bypassing the
-- client can't get around it). Keeps the "build the deep pack for every
-- favourited match" Action bounded per user.
create or replace function public.mc_enforce_favourite_cap()
returns trigger
language plpgsql
security definer
as $$
begin
  if (select count(*) from public.mc_favourites where user_id = new.user_id) >= 4 then
    raise exception 'Poți avea cel mult 4 meciuri favorite.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists mc_favourites_cap on public.mc_favourites;
create trigger mc_favourites_cap
  before insert on public.mc_favourites
  for each row execute function public.mc_enforce_favourite_cap();

-- Lets the (unauthenticated) Build Match Data Action ask "which match slugs
-- does ANYONE have favourited?" without being able to read who favourited
-- what — the only hole poked in mc_favourites' otherwise-private RLS. Used
-- to auto-escalate favourited matches to the deep editorial pass.
create or replace function public.mc_favourite_slugs()
returns table(match_slug text)
language sql
security definer
set search_path = public
as $$
  select match_slug from public.mc_favourites group by match_slug;
$$;

grant execute on function public.mc_favourite_slugs() to anon, authenticated;

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

-- ============================================================================
-- Canonical entities: teams, players, coaches, referees.
--
-- Today every match-data JSON file carries its own copy of a coach's career,
-- a referee's averages, a player's height/nat/etc. — the same real person's
-- facts pasted into every match file that mentions them. That is the direct
-- cause of the 2026-09 bugs where a coach change (Wagner -> Baum at
-- Augsburg) or a shirt-number correction had to be re-found and re-applied
-- file by file (one bulk patch alone touched 60 files for a single coach-name
-- bug class). One row per real person/team, keyed by API-Football's own id,
-- removes that class of bug at the root: fix it once, every match referencing
-- that person picks it up.
--
-- `base` is the last API-Football-sourced snapshot (refreshed by a sync
-- script, the same role scripts/prefetch-preview.mjs already plays per
-- match). `overrides` is a shallow, same-shaped partial object of
-- user-submitted corrections, applied over `base` at read time with
-- `base || overrides`. Public (anon) read, since match.html is a public page
-- with no login wall; authenticated write, exactly like mc_match_state.
-- ============================================================================
-- `entity_key` (not a bare integer) because API-Football gives players,
-- coaches and teams a real numeric id, but NOT referees — fixture.referee is
-- just a free-text name. So the key is a text tag that fits both:
--   player/coach/team -> 'af:<api-football id>'   e.g. 'af:1234'
--   referee           -> 'name:<slugified name>'  e.g. 'name:fabio-maresca'
-- `api_id` is kept alongside as a plain integer (null for referees) purely
-- for convenience joins/filters — `entity_key` stays the actual identity.
create table if not exists public.mc_entities (
  kind text not null check (kind in ('team', 'player', 'coach', 'referee')),
  entity_key text not null,
  api_id integer,                                  -- API-Football id, null for referees
  base jsonb not null default '{}'::jsonb,        -- last known-good API-Football snapshot
  base_synced_at timestamptz,                      -- when `base` was last refreshed from the API
  overrides jsonb not null default '{}'::jsonb,    -- user corrections, same shape as `base`, shallow-merged on top
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz not null default now(),
  primary key (kind, entity_key)
);

-- Append-only audit trail for `overrides` changes, mirroring mc_match_changes
-- — lets a moderator see who claimed a coach/player fact was wrong and why,
-- since these rows are shared across every match that references the entity
-- (a bad edit here has a much wider blast radius than a per-match note).
create table if not exists public.mc_entity_changes (
  id bigint generated always as identity primary key,
  kind text not null,
  entity_key text not null,
  field text not null,               -- e.g. "name", "career", "ycPerMatch"
  old_value jsonb,
  new_value jsonb,
  user_id uuid not null references auth.users(id),
  display_name text not null,
  note text,                          -- optional free-text justification, e.g. a source URL
  changed_at timestamptz not null default now()
);

alter table public.mc_entities enable row level security;
alter table public.mc_entity_changes enable row level security;

drop policy if exists "anyone reads entities" on public.mc_entities;
create policy "anyone reads entities" on public.mc_entities for select to anon, authenticated using (true);
drop policy if exists "authenticated users edit entities" on public.mc_entities;
create policy "authenticated users edit entities" on public.mc_entities for update to authenticated using (true) with check (auth.uid() = updated_by);
drop policy if exists "authenticated users add entities" on public.mc_entities;
create policy "authenticated users add entities" on public.mc_entities for insert to authenticated with check (true);

drop policy if exists "anyone reads entity change log" on public.mc_entity_changes;
create policy "anyone reads entity change log" on public.mc_entity_changes for select to anon, authenticated using (true);
drop policy if exists "authors add entity change log entries" on public.mc_entity_changes;
create policy "authors add entity change log entries" on public.mc_entity_changes for insert to authenticated with check (auth.uid() = user_id);

-- Server-side merge helper: base || overrides, both defaulting to '{}' so a
-- row with no overrides yet still returns base as-is. Kept as SQL (not just
-- client-side JS) so any future server job (e.g. the build Action) can read
-- the merged view too without reimplementing the merge.
create or replace function public.mc_entity_merged(p_kind text, p_entity_key text)
returns jsonb
language sql
stable
as $$
  select coalesce(base, '{}'::jsonb) || coalesce(overrides, '{}'::jsonb)
  from public.mc_entities
  where kind = p_kind and entity_key = p_entity_key;
$$;

grant execute on function public.mc_entity_merged(text, text) to anon, authenticated;

-- Run once in Supabase Dashboard -> SQL Editor. Anonymous users get a stable
-- browser identity; their chosen display name is stored with every change.
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

create policy "authenticated users read shared match state" on public.mc_match_state for select to authenticated using (true);
create policy "authenticated users write shared match state" on public.mc_match_state for insert to authenticated with check (auth.uid() = updated_by);
create policy "authenticated users update shared match state" on public.mc_match_state for update to authenticated using (true) with check (auth.uid() = updated_by);
create policy "authenticated users read change log" on public.mc_match_changes for select to authenticated using (true);
create policy "authors add their change log entries" on public.mc_match_changes for insert to authenticated with check (auth.uid() = user_id);
create policy "users manage own favourites" on public.mc_favourites for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter publication supabase_realtime add table public.mc_match_state;

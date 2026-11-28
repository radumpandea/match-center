-- Match Center: guests (anonymous sign-ins, switched on for an evening on 2026-11-28 so nobody needs the e-mail link).
-- Idempotent. Applied by .github/workflows/supabase-sql.yml.
--
-- A guest is "authenticated" for the database, so shared notes, events and name corrections work for them like for
-- anybody. What they must not get is favourites: every favourite starts a premium ("deep") build on the owner's
-- Claude subscription (trigger mc_favourites_trigger_deep_build in docs/supabase.sql), and anyone can create any
-- number of guest sessions.
create or replace function public.mc_no_guest_favourites()
returns trigger
language plpgsql
as $$
begin
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Favoritele cer conectare cu email.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists mc_favourites_no_guests on public.mc_favourites;
create trigger mc_favourites_no_guests
  before insert on public.mc_favourites
  for each row execute function public.mc_no_guest_favourites();

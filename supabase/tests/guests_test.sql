-- Run by .github/workflows/supabase-sql.yml in "test" mode, after supabase/guests.sql, inside a transaction that is
-- rolled back. The workflow looks for the exact phrase printed at the end.
do $$
declare
  guest constant uuid := '00000000-0000-0000-0000-00000000f001';
  refused boolean := false;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', guest, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  begin
    insert into public.mc_favourites (user_id, match_slug) values (guest, 'test-guest-slug');
  exception when others then
    refused := sqlerrm like 'Favoritele cer conectare%';
    if not refused then raise exception 'a guest favourite failed for another reason: %', sqlerrm; end if;
  end;
  if not refused then raise exception 'a guest must not be able to add a favourite'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'mc_favourites_no_guests' and not tgisinternal) then
    raise exception 'trigger missing';
  end if;
end
$$;

select 'ALL ACCESS TESTS PASSED' as result;

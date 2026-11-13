-- Run by .github/workflows/supabase-sql.yml in "test" mode, after supabase/delegations.sql, inside a transaction
-- that is rolled back. The workflow looks for the exact phrase printed at the end.
do $$
begin
  -- not signed in (no JWT in this session): refused, nothing dispatched or logged
  if (public.mc_request_delegations('sl-e16-test-match')->>'reason') <> 'not_signed_in' then
    raise exception 'expected not_signed_in';
  end if;
  if (select count(*) from public.mc_dispatch_log where kind = 'delegations') <> 0 then
    raise exception 'a refused call must not be logged';
  end if;
  -- the table is closed to the API roles
  if has_table_privilege('anon', 'public.mc_dispatch_log', 'select') or has_table_privilege('authenticated', 'public.mc_dispatch_log', 'select') then
    -- privileges can exist without a policy; RLS is what closes it
    if not (select relrowsecurity from pg_class where oid = 'public.mc_dispatch_log'::regclass) then
      raise exception 'mc_dispatch_log must have row level security';
    end if;
  end if;
  -- anon cannot run the function
  if has_function_privilege('anon', 'public.mc_request_delegations(text)', 'execute') then
    raise exception 'anon must not execute mc_request_delegations';
  end if;
  if not has_function_privilege('authenticated', 'public.mc_request_delegations(text)', 'execute') then
    raise exception 'authenticated must execute mc_request_delegations';
  end if;
end
$$;

select 'ALL ACCESS TESTS PASSED' as result;

-- Packet C2 (0048): get_party_ledger_v2 must run under PostgREST's safeupdate (no unqualified DELETE,
-- no temp state) and keep its contract. Behaviour (balances, ordering) stays covered by the C1 suite.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);
select is((select provolatile::text from pg_proc where oid='public.get_party_ledger_v2(uuid,uuid,date,date)'::regprocedure),'s','ledger function is STABLE');
select ok((select prosrc !~* '(delete|create\s+temp|_c1_ledger)' from pg_proc where oid='public.get_party_ledger_v2(uuid,uuid,date,date)'::regprocedure),'ledger function has no DELETE or temp table');
select ok((select prosecdef from pg_proc where oid='public.get_party_ledger_v2(uuid,uuid,date,date)'::regprocedure),'ledger function stays SECURITY DEFINER');
select ok(has_function_privilege('authenticated','public.get_party_ledger_v2(uuid,uuid,date,date)','EXECUTE')
  and not has_function_privilege('anon','public.get_party_ledger_v2(uuid,uuid,date,date)','EXECUTE'),'grants unchanged');
select ok((select proconfig::text like '%search_path=public%' from pg_proc where oid='public.get_party_ledger_v2(uuid,uuid,date,date)'::regprocedure),'search_path pinned');
select * from finish();
rollback;

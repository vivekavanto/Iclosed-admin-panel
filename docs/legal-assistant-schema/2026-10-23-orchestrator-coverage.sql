-- Apply after the base register schema. Adds coverage metadata only; no client rows change.
begin;
create or replace function public.orchestrator_snapshot() returns jsonb
language sql security invoker set search_path=public as $$
  select jsonb_build_object(
    'revision',s.revision,'sourceDate',s.source_date,
    'coverageStart',(select coverage_start from public.orchestrator_imports order by revision desc limit 1),
    'coverageEnd',(select coverage_end from public.orchestrator_imports order by revision desc limit 1),
    'matters',coalesce((select jsonb_agg(details order by file_number) from public.orchestrator_files),'[]'::jsonb)
  ) from public.orchestrator_state s where singleton=true;
$$;
revoke all on function public.orchestrator_snapshot() from public,anon,authenticated;
grant execute on function public.orchestrator_snapshot() to service_role;
commit;

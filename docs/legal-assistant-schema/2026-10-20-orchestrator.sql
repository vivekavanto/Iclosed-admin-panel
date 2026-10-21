-- Additive, manually applied only after review. No changes to existing app tables.
begin;
create table public.orchestrator_state (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 0,
  source_date date
);
insert into public.orchestrator_state(singleton) values(true);
create table public.orchestrator_files (
  id text primary key,
  file_number text not null unique,
  details jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.orchestrator_imports (
  checksum text primary key,
  filename text not null,
  source_date date not null,
  coverage_start date,
  coverage_end date not null,
  actor text not null,
  revision bigint not null,
  imported_at timestamptz not null default now()
);
create table public.orchestrator_file_changes (
  id bigint generated always as identity primary key,
  file_id text not null,
  revision bigint not null,
  previous_details jsonb,
  new_details jsonb not null,
  changed_at timestamptz not null default now()
);
alter table public.orchestrator_state enable row level security;
alter table public.orchestrator_files enable row level security;
alter table public.orchestrator_imports enable row level security;
alter table public.orchestrator_file_changes enable row level security;
revoke all on public.orchestrator_state, public.orchestrator_files, public.orchestrator_imports, public.orchestrator_file_changes from anon, authenticated;
grant all on public.orchestrator_state, public.orchestrator_files, public.orchestrator_imports, public.orchestrator_file_changes to service_role;
grant usage, select on sequence public.orchestrator_file_changes_id_seq to service_role;
create function public.orchestrator_snapshot() returns jsonb language sql security invoker set search_path = public as $$
  select jsonb_build_object('revision', s.revision, 'sourceDate', s.source_date,
    'matters', coalesce((select jsonb_agg(details order by file_number) from public.orchestrator_files), '[]'::jsonb))
  from public.orchestrator_state s where singleton=true;
$$;
create function public.orchestrator_apply_import(
  p_checksum text, p_expected_revision bigint, p_source_date date, p_filename text,
  p_actor text, p_coverage_start date, p_coverage_end date, p_matters jsonb
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare s public.orchestrator_state; r jsonb; old jsonb;
begin
  select * into s from public.orchestrator_state where singleton=true for update;
  if exists(select 1 from public.orchestrator_imports where checksum=p_checksum) then
    return jsonb_build_object('duplicate',true,'revision',s.revision);
  end if;
  if s.revision <> p_expected_revision then raise exception 'STALE_REVISION'; end if;
  if s.source_date > p_source_date then raise exception 'OLDER_EXTRACT'; end if;
  if jsonb_typeof(p_matters) <> 'array' or jsonb_array_length(p_matters)=0 then raise exception 'EMPTY_IMPORT'; end if;
  for r in select value from jsonb_array_elements(p_matters) loop
    select details into old from public.orchestrator_files where id=r->>'id';
    if old is distinct from r then
      insert into public.orchestrator_file_changes(file_id,revision,previous_details,new_details)
        values(r->>'id',s.revision+1,old,r);
    end if;
    insert into public.orchestrator_files(id,file_number,details) values(r->>'id',r->>'number',r)
      on conflict(id) do update set file_number=excluded.file_number,details=excluded.details,updated_at=now();
  end loop;
  insert into public.orchestrator_imports(checksum,filename,source_date,coverage_start,coverage_end,actor,revision)
    values(p_checksum,p_filename,p_source_date,p_coverage_start,p_coverage_end,p_actor,s.revision+1);
  update public.orchestrator_state set revision=s.revision+1,source_date=p_source_date where singleton=true;
  return jsonb_build_object('duplicate',false,'revision',s.revision+1);
end;
$$;
revoke all on function public.orchestrator_snapshot() from public,anon,authenticated;
revoke all on function public.orchestrator_apply_import(text,bigint,date,text,text,date,date,jsonb) from public,anon,authenticated;
grant execute on function public.orchestrator_snapshot() to service_role;
grant execute on function public.orchestrator_apply_import(text,bigint,date,text,text,date,date,jsonb) to service_role;
commit;

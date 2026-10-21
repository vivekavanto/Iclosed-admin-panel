-- Apply only after the base Orchestrator schema, in the reviewed target database.
begin;
create table public.orchestrator_folder_links (
  file_id text primary key references public.orchestrator_files(id),
  folder_id text not null unique,
  folder_name text not null,
  root_id text not null,
  actor text not null,
  verified_at timestamptz not null default now()
);
alter table public.orchestrator_folder_links enable row level security;
revoke all on public.orchestrator_folder_links from anon,authenticated;
grant all on public.orchestrator_folder_links to service_role;
create function public.orchestrator_link_folder(
 p_file_id text,p_folder_id text,p_name text,p_root_id text,p_actor text,p_expected_revision bigint
) returns void language plpgsql security invoker set search_path=public as $$
declare s public.orchestrator_state; old jsonb; current_details jsonb;
begin
 select * into s from public.orchestrator_state where singleton=true for update;
 if s.revision <> p_expected_revision then raise exception 'STALE_REVISION'; end if;
 select details into old from public.orchestrator_files where id=p_file_id;
 if old is null then raise exception 'FILE_NOT_FOUND'; end if;
 current_details=jsonb_set(old,'{driveFolderId}',to_jsonb(p_folder_id));
 insert into public.orchestrator_folder_links(file_id,folder_id,folder_name,root_id,actor)
 values(p_file_id,p_folder_id,p_name,p_root_id,p_actor)
 on conflict(file_id) do update set folder_id=excluded.folder_id,folder_name=excluded.folder_name,root_id=excluded.root_id,actor=excluded.actor,verified_at=now();
 update public.orchestrator_files set details=current_details,updated_at=now() where id=p_file_id;
 insert into public.orchestrator_file_changes(file_id,revision,previous_details,new_details) values(p_file_id,s.revision+1,old,current_details);
 update public.orchestrator_state set revision=s.revision+1 where singleton=true;
end;
$$;
revoke all on function public.orchestrator_link_folder(text,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.orchestrator_link_folder(text,text,text,text,text,bigint) to service_role;
commit;

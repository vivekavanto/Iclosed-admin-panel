-- REVIEWED MANUAL DEPLOYMENT ONLY. Apply to the dedicated DEV workflow project.
-- No existing Admin/Customer tables, records, grants or functions are changed.
begin;
create table public.legal_assistant_documents (
 namespace text not null check(namespace ~ '^dev-[a-z0-9-]{1,48}$'),
 name text not null check(length(name) between 1 and 181),
 revision bigint not null check(revision > 0),
 value jsonb not null,
 updated_at timestamptz not null default now(),
 primary key(namespace,name)
);
alter table public.legal_assistant_documents enable row level security;
revoke all on public.legal_assistant_documents from public, anon, authenticated;
grant select,insert,update on public.legal_assistant_documents to service_role;
create function public.legal_assistant_document_cas(p_namespace text,p_name text,p_revision bigint,p_value jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed bigint;
begin
 if p_namespace !~ '^dev-[a-z0-9-]{1,48}$' or p_revision < 0 or p_value is null
    or p_name !~ '^[a-z0-9][a-z0-9/._-]{0,180}$' or position('..' in p_name)>0
 then raise exception 'INVALID_DOCUMENT'; end if;
 if p_revision=0 then
  insert into public.legal_assistant_documents(namespace,name,revision,value)
   values(p_namespace,p_name,1,p_value) on conflict do nothing;
 else
  update public.legal_assistant_documents set revision=revision+1,value=p_value,updated_at=now()
   where namespace=p_namespace and name=p_name and revision=p_revision;
 end if;
 get diagnostics changed = row_count;
 return changed=1;
end $$;
revoke all on function public.legal_assistant_document_cas(text,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.legal_assistant_document_cas(text,text,bigint,jsonb) to service_role;
commit;

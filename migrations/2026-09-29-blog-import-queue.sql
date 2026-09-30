-- Blog import queue — multi-article document imports run in the background.
--
-- Before: the admin's browser tab drove every Gemini call (extract, then
-- format + SEO + cover image per article) and nothing was saved until the end,
-- so a 10-article document held the page for minutes and a closed tab lost it.
--
-- Now: POST /api/admin/blog/batches writes a blog_import_batches row and
-- returns at once. A server worker (src/lib/blogImportQueue.ts) claims one job
-- at a time through claim_blog_import_job():
--   * an "extract" job  = a queued batch  → splits the document, creates one
--                         draft blog_posts row + one blog_import_items row each
--   * an "item" job     = a queued item   → format + SEO + cover image for that
--                         one article, written to its own draft
-- The Blogs page polls the two tables for its progress bar.
--
-- Apply BEFORE deploying the code that uses it. Both tables are service-role
-- only (RLS on, no policies), and the GRANTs are load-bearing: CREATE TABLE
-- does not inherit them here, and without them every call is a 42501.

create table if not exists public.blog_import_batches (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by_email   text,
  file_name          text not null,
  -- Scratch copy of the uploaded document; deleted once extraction is done.
  blob_url           text,
  status             text not null default 'queued'
                     check (status in ('queued','extracting','processing','completed','failed','cancelled')),
  publish_when_ready boolean not null default false,
  total              integer not null default 0,
  published          integer not null default 0,
  error              text,
  attempts           integer not null default 0,
  run_after          timestamptz not null default now(),
  locked_until       timestamptz,
  finished_at        timestamptz,
  dismissed_at       timestamptz
);

create table if not exists public.blog_import_items (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  batch_id      uuid not null references public.blog_import_batches(id) on delete cascade,
  post_id       uuid references public.blog_posts(id) on delete set null,
  idx           integer not null,
  title         text not null default '',
  char_count    integer not null default 0,
  is_duplicate  boolean not null default false,
  -- Oversized or possible duplicate: saved as a draft, never auto-published.
  needs_review  boolean not null default false,
  status        text not null default 'queued'
                check (status in ('queued','processing','done','failed','cancelled')),
  format_status text not null default 'pending' check (format_status in ('pending','done','failed','skipped')),
  seo_status    text not null default 'pending' check (seo_status    in ('pending','done','failed','skipped')),
  image_status  text not null default 'pending' check (image_status  in ('pending','done','failed','skipped')),
  warnings      jsonb not null default '[]'::jsonb,
  last_error    text,
  attempts      integer not null default 0,
  run_after     timestamptz not null default now(),
  locked_until  timestamptz,
  finished_at   timestamptz
);

create index if not exists blog_import_batches_status_idx on public.blog_import_batches (status, run_after);
create index if not exists blog_import_items_batch_idx    on public.blog_import_items (batch_id, idx);
create index if not exists blog_import_items_status_idx   on public.blog_import_items (status, run_after);

alter table public.blog_import_batches enable row level security;
alter table public.blog_import_items   enable row level security;

grant select, insert, update, delete on public.blog_import_batches to service_role;
grant select, insert, update, delete on public.blog_import_items   to service_role;

-- ── claim_blog_import_job ───────────────────────────────────────────────
-- Hands out at most ONE job per call, and never more than p_max_in_flight
-- running at once across every serverless instance — that cap is what keeps a
-- batch from tripping Gemini's per-project rate limit. The advisory lock
-- serialises claimers so the in-flight count cannot be read stale by two at once.
--
-- It also recovers jobs whose worker died mid-run (lease expired): back to
-- queued, or failed once they have used up p_max_attempts.
create or replace function public.claim_blog_import_job(
  p_max_in_flight  integer default 3,
  p_lease_seconds  integer default 330,
  p_max_attempts   integer default 3
)
returns table (job_kind text, job_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_in_flight integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('blog_import_claim'));

  -- Stale leases → retry, or give up.
  update blog_import_batches
     set status = case when attempts >= p_max_attempts then 'failed' else 'queued' end,
         error = case when attempts >= p_max_attempts
                      then 'Reading the document timed out repeatedly.' else error end,
         finished_at = case when attempts >= p_max_attempts then now() else finished_at end,
         locked_until = null, updated_at = now()
   where status = 'extracting' and locked_until < now();

  update blog_import_items
     set status = case when attempts >= p_max_attempts then 'failed' else 'queued' end,
         last_error = case when attempts >= p_max_attempts
                           then 'Processing timed out repeatedly.' else last_error end,
         finished_at = case when attempts >= p_max_attempts then now() else finished_at end,
         locked_until = null, updated_at = now()
   where status = 'processing' and locked_until < now();

  select (select count(*) from blog_import_batches where status = 'extracting')
       + (select count(*) from blog_import_items   where status = 'processing')
    into v_in_flight;
  if v_in_flight >= p_max_in_flight then
    return;
  end if;

  -- Extraction first: it is what makes the drafts appear.
  select b.id into v_id
    from blog_import_batches b
   where b.status = 'queued' and b.run_after <= now()
   order by b.created_at
   limit 1
   for update skip locked;

  if v_id is not null then
    update blog_import_batches
       set status = 'extracting', attempts = attempts + 1,
           locked_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
     where id = v_id;
    job_kind := 'extract'; job_id := v_id;
    return next;
    return;
  end if;

  select i.id into v_id
    from blog_import_items i
    join blog_import_batches b on b.id = i.batch_id
   where i.status = 'queued' and i.run_after <= now() and b.status = 'processing'
   order by b.created_at, i.idx
   limit 1
   for update of i skip locked;

  if v_id is not null then
    update blog_import_items
       set status = 'processing', attempts = attempts + 1,
           locked_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
     where id = v_id;
    job_kind := 'item'; job_id := v_id;
    return next;
  end if;
end;
$$;

-- ── finish_blog_import_batch ────────────────────────────────────────────
-- Flips a batch to completed once none of its items is still queued or
-- running. A single conditional UPDATE, so when two workers finish the last
-- two items at the same moment only one of them gets `true` back — and only
-- that one sends the notification / runs the auto-publish.
create or replace function public.finish_blog_import_batch(p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update blog_import_batches b
     set status = 'completed', finished_at = now(), updated_at = now()
   where b.id = p_batch_id
     and b.status = 'processing'
     and not exists (
       select 1 from blog_import_items i
        where i.batch_id = b.id and i.status in ('queued','processing')
     )
  returning b.id into v_id;
  return v_id is not null;
end;
$$;

revoke execute on function public.claim_blog_import_job(integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.finish_blog_import_batch(uuid) from public, anon, authenticated;
grant execute on function public.claim_blog_import_job(integer, integer, integer) to service_role;
grant execute on function public.finish_blog_import_batch(uuid) to service_role;

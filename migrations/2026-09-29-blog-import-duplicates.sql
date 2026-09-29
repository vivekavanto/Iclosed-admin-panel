-- Blog import: hold duplicates for the admin instead of saving them as drafts.
--
-- Follows 2026-09-29-blog-import-queue.sql (apply that one first).
--
-- An article whose title matches an existing blog — or an earlier article in
-- the same document — no longer becomes a "-2" draft. Its item is parked as
-- 'held' with NO blog_posts row and no Gemini work spent, and the progress
-- panel asks the admin: Remove (→ 'removed') or Import anyway (→ a draft is
-- created then, and the item is queued like any other).
--
-- Because nothing is in blog_posts yet, the item has to carry the article's
-- own text until the admin decides; it is cleared once they have.

alter table public.blog_import_items
  add column if not exists content_source       text,
  add column if not exists preformatted_html    text,
  add column if not exists duplicate_of_post_id uuid references public.blog_posts(id) on delete set null,
  add column if not exists duplicate_of_title   text;

alter table public.blog_import_items drop constraint if exists blog_import_items_status_check;
alter table public.blog_import_items
  add constraint blog_import_items_status_check
  check (status in ('queued','processing','done','failed','cancelled','held','removed'));

-- A batch with a held duplicate is not finished: the admin still owes a
-- decision, and the progress panel only shows unfinished imports.
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
        where i.batch_id = b.id and i.status in ('queued','processing','held')
     )
  returning b.id into v_id;
  return v_id is not null;
end;
$$;

revoke execute on function public.finish_blog_import_batch(uuid) from public, anon, authenticated;
grant execute on function public.finish_blog_import_batch(uuid) to service_role;

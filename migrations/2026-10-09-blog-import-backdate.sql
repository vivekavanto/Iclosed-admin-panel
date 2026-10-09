-- Blog import: spread a document's blogs over past dates, N blogs per date.
--
-- blog_import_batches.blogs_per_date
--   NULL  = off (the current behaviour: published blogs are dated when they publish).
--   N     = the blogs of the document are dated in groups of N, the first group on
--           the oldest day and the last group on YESTERDAY. See
--           src/lib/blogImportDates.ts. The date is stored on each draft's
--           published_at at import time, so it survives a manual publish too
--           (publish keeps an existing published_at).
--
-- Apply BEFORE deploying the code: the upload would otherwise fail to insert the
-- new column. Idempotent: safe to re-run.

ALTER TABLE public.blog_import_batches
  ADD COLUMN IF NOT EXISTS blogs_per_date integer;

ALTER TABLE public.blog_import_batches
  DROP CONSTRAINT IF EXISTS blog_import_batches_blogs_per_date_check;
ALTER TABLE public.blog_import_batches
  ADD CONSTRAINT blog_import_batches_blogs_per_date_check
  CHECK (blogs_per_date IS NULL OR blogs_per_date BETWEEN 1 AND 100);

-- Verification: one row.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'blog_import_batches' AND column_name = 'blogs_per_date';

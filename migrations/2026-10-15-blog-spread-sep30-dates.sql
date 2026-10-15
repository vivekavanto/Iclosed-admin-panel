-- Spread the blogs that were all imported with the single date 2026-09-30 over
-- 2026-09-19 .. 2026-09-30, TWO blogs per date.
--
-- Why: the first multi-blog import (29-30 Sept) predates import backdating, so
-- every blog got the same published_at day. This gives them one date per pair.
--
-- Rules
--   * Only rows whose published_at falls on 2026-09-30 (Toronto time) are touched.
--     Blogs dated Oct 1 onwards, or any other day, are NOT changed.
--   * The order the blogs already have on the site is kept: sorted by their
--     CURRENT published_at (then id), so the blog published first today
--     ("What Should My Home Insurance Policy Include?") gets the earliest date.
--     The NEWEST pair lands on Sep 30, going back one day per pair; with an odd
--     count the single leftover (the oldest blog) gets the earliest date.
--   * The two blogs of a pair get 09:00 and 09:05 Toronto time so they sort the
--     same way every time (the portal reads posts oldest-first as a series).
--   * Everything stays before Oct 1, so it stays older than the October imports.
--
-- Run the steps IN ORDER in the Supabase SQL editor. Nothing changes until
-- step 2 (the UPDATE). Step 1 is a preview; step 2 also keeps a backup table.

-- ── Step 1: PREVIEW (changes nothing) ──────────────────────────────────
WITH ranked AS (
  SELECT id, title, published_at AS old_published_at,
         ROW_NUMBER() OVER (ORDER BY published_at DESC, id DESC) AS rn_desc
    FROM public.blog_posts
   WHERE (published_at AT TIME ZONE 'America/Toronto')::date = DATE '2026-09-30'
)
SELECT rn_desc,
       old_published_at,
       ((DATE '2026-09-30' - ((rn_desc - 1) / 2)::int)
         + CASE WHEN (rn_desc - 1) % 2 = 1 THEN TIME '09:00' ELSE TIME '09:05' END)
         AT TIME ZONE 'America/Toronto' AS new_published_at,
       title
  FROM ranked
 ORDER BY rn_desc DESC;

-- ── Step 2: BACKUP + UPDATE ────────────────────────────────────────────
-- Keep the old values so this can be undone (see the end of this file).
CREATE TABLE IF NOT EXISTS public.blog_posts_published_at_backup_20261015 (
  id uuid PRIMARY KEY,
  published_at timestamptz
);
ALTER TABLE public.blog_posts_published_at_backup_20261015 ENABLE ROW LEVEL SECURITY;

INSERT INTO public.blog_posts_published_at_backup_20261015 (id, published_at)
SELECT id, published_at
  FROM public.blog_posts
 WHERE (published_at AT TIME ZONE 'America/Toronto')::date = DATE '2026-09-30'
ON CONFLICT (id) DO NOTHING;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY published_at DESC, id DESC) AS rn_desc
    FROM public.blog_posts
   WHERE (published_at AT TIME ZONE 'America/Toronto')::date = DATE '2026-09-30'
)
UPDATE public.blog_posts p
   SET published_at =
         ((DATE '2026-09-30' - ((r.rn_desc - 1) / 2)::int)
           + CASE WHEN (r.rn_desc - 1) % 2 = 1 THEN TIME '09:00' ELSE TIME '09:05' END)
           AT TIME ZONE 'America/Toronto'
  FROM ranked r
 WHERE p.id = r.id;

-- ── Step 3: VERIFY — blogs per Toronto date ────────────────────────────
SELECT (published_at AT TIME ZONE 'America/Toronto')::date AS day, COUNT(*) AS blogs
  FROM public.blog_posts
 WHERE published_at IS NOT NULL
 GROUP BY 1
 ORDER BY 1;

-- ── UNDO (only if needed) ──────────────────────────────────────────────
-- UPDATE public.blog_posts p
--    SET published_at = b.published_at
--   FROM public.blog_posts_published_at_backup_20261015 b
--  WHERE p.id = b.id;

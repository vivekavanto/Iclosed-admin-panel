-- 2026-09-11 — Drop backup/duplicate tables from public schema
--
-- The backup tables (deals_duplicate, milestones_duplicate, tasks_duplicate)
-- are triggering RLS errors because they are in the public schema (exposed to
-- PostgREST) but cannot have RLS disabled. Since these are unused backups,
-- the cleanest solution is to drop them entirely.

BEGIN;

DROP TABLE IF EXISTS public.deals_duplicate CASCADE;
DROP TABLE IF EXISTS public.milestones_duplicate CASCADE;
DROP TABLE IF EXISTS public.tasks_duplicate CASCADE;

COMMIT;

-- 2026-09-11 — Fix rls_auto_enable() function permissions
--
-- The rls_auto_enable() function is a utility function that should not be
-- callable via REST API. Previous REVOKE attempts may not have worked due to
-- Supabase default grants being re-applied. This migration uses explicit
-- REVOKE ALL + GRANT only to postgres.

BEGIN;

-- First, revoke all privileges from all roles
REVOKE ALL PRIVILEGES ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated, postgres;

-- Then grant only to postgres (needed for internal triggers/operations)
GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO postgres;

COMMIT;

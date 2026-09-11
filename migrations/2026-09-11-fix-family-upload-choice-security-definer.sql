-- 2026-09-11 — Fix SECURITY DEFINER on family_upload_choice view
--
-- Supabase Security Advisor flagged the family_upload_choice view as using
-- SECURITY DEFINER, which bypasses RLS policies. This view should use the
-- querying user's permissions instead.
--
-- Since the view is no longer referenced in the codebase and has no incoming
-- dependencies, we simply drop it. If it needs to be restored, it should be
-- recreated without SECURITY DEFINER (or with SECURITY INVOKER explicitly).

BEGIN;

DROP VIEW IF EXISTS public.family_upload_choice;

COMMIT;

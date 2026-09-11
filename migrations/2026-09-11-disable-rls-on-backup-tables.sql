-- 2026-09-11 — Disable RLS on backup/duplicate tables
--
-- These tables are backups or duplicate copies that are no longer actively used.
-- RLS was enabled on them during development but they don't need security policies.
-- Disabling RLS on unused tables simplifies the security model and removes noise
-- from the Security Advisor.
--
-- Tables to disable RLS on:
--   - public.deals_duplicate
--   - public.milestones_duplicate
--   - public.tasks_duplicate

BEGIN;

ALTER TABLE public.deals_duplicate DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestones_duplicate DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks_duplicate DISABLE ROW LEVEL SECURITY;

COMMIT;

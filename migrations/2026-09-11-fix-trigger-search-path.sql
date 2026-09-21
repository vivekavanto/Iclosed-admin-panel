-- 2026-09-11-fix-trigger-search-path.sql
--
-- Purpose: fix Supabase linter warning 0011_function_search_path_mutable
--
-- Issue: trigger functions that don't set search_path are vulnerable to
-- SQL injection if a malicious search_path is injected. Even simple operations
-- like NOW() or comparisons can resolve to unexpected functions if the schema
-- order is tampered with.
--
-- Fix: add `SET search_path = public` to both updated_at trigger functions.

-- 1. Fix users_set_updated_at
CREATE OR REPLACE FUNCTION public.users_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 2. Fix clients_set_updated_at
CREATE OR REPLACE FUNCTION public.clients_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

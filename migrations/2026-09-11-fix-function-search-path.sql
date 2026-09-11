-- 2026-09-11 — Fix function search_path for timestamp triggers
--
-- Supabase Security Advisor flagged two trigger functions for having a
-- mutable (role-dependent) search_path, which is a security risk. These
-- functions should explicitly set search_path = public to avoid ambiguity
-- and ensure consistent behavior regardless of the calling role.
--
-- Functions affected:
--   - public.users_set_updated_at()
--   - public.clients_set_updated_at()

BEGIN;

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

COMMIT;

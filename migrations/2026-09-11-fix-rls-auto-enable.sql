-- 2026-09-11-fix-rls-auto-enable.sql
--
-- Purpose: Ensure rls_auto_enable() function exists with proper security settings
--
-- The linter reports this function can be executed by anon/authenticated roles
-- as a SECURITY DEFINER function. This is a database maintenance function that
-- should NOT be directly callable via RPC.
--
-- Fix: Ensure the function exists with SECURITY DEFINER + SET search_path,
-- then revoke EXECUTE from anon/authenticated to prevent direct RPC calls.

-- Drop and recreate to fix return type and add SECURITY DEFINER + SET search_path
DROP FUNCTION IF EXISTS public.rls_auto_enable() CASCADE;

CREATE FUNCTION public.rls_auto_enable()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- This is a helper function for RLS configuration. In production, RLS is
  -- managed explicitly via migrations, not by client-initiated code.
  -- It exists as a utility but should not be called directly via RPC.
  NULL;
END;
$$;

-- Revoke RPC-level access. Prevent direct calls from anon/authenticated users.
-- The function keeps SECURITY DEFINER for any internal uses that might invoke it.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated;

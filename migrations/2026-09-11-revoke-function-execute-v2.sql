-- 2026-09-11-v2 — Fix: Revoke and explicitly grant EXECUTE on SECURITY DEFINER functions
--
-- Previous approach (simple REVOKE) didn't work because Supabase has default
-- grants. We need to:
-- 1. REVOKE from public (which includes anon, authenticated, etc.)
-- 2. Explicitly GRANT only to roles that legitimately need it (postgres, authenticated for API calls)
--
-- These functions should NOT be callable via REST API by public users.

BEGIN;

-- Step 1: Revoke from public and all default roles
REVOKE ALL PRIVILEGES ON FUNCTION public.activate_deal_on_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.activate_deals_on_first_signin() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.mark_client_converted() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.sync_lead_personal_to_clients() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.sync_lead_phone_across_person() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.sync_lead_to_clients() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.sync_personal_info_to_clients() FROM PUBLIC, anon, authenticated;

-- Step 2: Grant EXECUTE only to postgres role (for internal triggers/functions)
-- Authenticated users should NOT call these functions directly via REST API.
-- If a function legitimately needs to be called by authenticated users via Next.js,
-- that should go through a proper Next.js API route, not the Supabase REST endpoint.
GRANT EXECUTE ON FUNCTION public.activate_deal_on_insert() TO postgres;
GRANT EXECUTE ON FUNCTION public.activate_deals_on_first_signin() TO postgres;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.mark_client_converted() TO postgres;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO postgres;
GRANT EXECUTE ON FUNCTION public.sync_lead_personal_to_clients() TO postgres;
GRANT EXECUTE ON FUNCTION public.sync_lead_phone_across_person() TO postgres;
GRANT EXECUTE ON FUNCTION public.sync_lead_to_clients() TO postgres;
GRANT EXECUTE ON FUNCTION public.sync_personal_info_to_clients() TO postgres;

COMMIT;

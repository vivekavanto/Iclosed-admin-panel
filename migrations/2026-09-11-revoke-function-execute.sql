-- 2026-09-11 — Revoke EXECUTE permissions on internal SECURITY DEFINER functions
--
-- Supabase Security Advisor flagged 9 SECURITY DEFINER functions as being
-- callable by anon and authenticated users via the REST API (/rest/v1/rpc/*).
--
-- These are INTERNAL database functions (triggers, utility functions) that
-- should NOT be called directly by users or clients. They are dangerous when
-- exposed because:
--   1. SECURITY DEFINER runs with elevated privileges (admin role)
--   2. Exposing them allows users to invoke admin-level operations
--
-- Fix: Revoke EXECUTE from both anon and authenticated; keep it for ONLY
-- the roles that truly need to invoke them (postgres/authenticated for
-- triggers, or authenticated for legit API endpoints).
--
-- Functions to revoke from anon and authenticated:
--   - activate_deal_on_insert() - trigger function
--   - activate_deals_on_first_signin() - trigger function
--   - check_rate_limit() - called directly, can be re-added to authenticated if needed
--   - mark_client_converted() - called directly, can be re-added to authenticated if needed
--   - rls_auto_enable() - internal utility
--   - sync_lead_personal_to_clients() - trigger function
--   - sync_lead_phone_across_person() - trigger function
--   - sync_lead_to_clients() - trigger function
--   - sync_personal_info_to_clients() - trigger function

BEGIN;

-- Revoke from both roles on all 9 functions
REVOKE EXECUTE ON FUNCTION public.activate_deal_on_insert() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.activate_deals_on_first_signin() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_client_converted() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_lead_personal_to_clients() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_lead_phone_across_person() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_lead_to_clients() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_personal_info_to_clients() FROM anon, authenticated;

-- NOTE: If any of these functions (e.g., check_rate_limit, mark_client_converted)
-- are legitimately called by the Next.js API, they should be re-added via explicit
-- GRANT statements with proper authorization logic IN THE API CODE, not exposed
-- directly via Supabase REST. This prevents bypassing Next.js authentication.

COMMIT;

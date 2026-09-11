-- 2026-09-11 — Fix overly permissive RLS policies
--
-- Supabase Security Advisor flagged two INSERT policies with `WITH CHECK (true)`,
-- which allows unrestricted INSERT access. These policies should require
-- authentication to prevent abuse.
--
-- Tables affected:
--   - public.lead_corporate_docs: INSERT policy
--   - public.leads: INSERT policy
--
-- New policy logic:
--   - For authenticated users: allows INSERT (portal intake + admin APIs)
--   - For anon users: denies INSERT (prevents public abuse)

BEGIN;

-- Fix lead_corporate_docs INSERT policy
DROP POLICY IF EXISTS "Allow insert lead_corporate_docs" ON public.lead_corporate_docs;
CREATE POLICY "Allow insert lead_corporate_docs"
  ON public.lead_corporate_docs
  FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- Fix leads INSERT policy
DROP POLICY IF EXISTS "Allow insert leads" ON public.leads;
CREATE POLICY "Allow insert leads"
  ON public.leads
  FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

COMMIT;

-- 2026-09-11 — Fix overly permissive RLS INSERT/UPDATE policies
--
-- Three tables have existing RLS policies with WITH CHECK (true), which
-- allows unrestricted INSERT/UPDATE by authenticated users. While this
-- reflects the current access model (all authenticated users can edit
-- all data), it should be explicit and documented, not use always-true.
--
-- Replace with auth.role() = 'authenticated' to be explicit about the
-- permission check while maintaining the existing access model.

BEGIN;

-- ========== public.clients ==========
DROP POLICY IF EXISTS "Authenticated users can insert clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can update clients" ON public.clients;

CREATE POLICY "clients_insert" ON public.clients
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "clients_update" ON public.clients
  FOR UPDATE USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- ========== public.leads ==========
DROP POLICY IF EXISTS "Allow insert leads" ON public.leads;
DROP POLICY IF EXISTS "Allow update leads" ON public.leads;

CREATE POLICY "leads_insert" ON public.leads
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "leads_update" ON public.leads
  FOR UPDATE USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- ========== public.lead_corporate_docs ==========
DROP POLICY IF EXISTS "Allow insert lead_corporate_docs" ON public.lead_corporate_docs;
DROP POLICY IF EXISTS "Allow update lead_corporate_docs" ON public.lead_corporate_docs;

CREATE POLICY "lead_corporate_docs_insert" ON public.lead_corporate_docs
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "lead_corporate_docs_update" ON public.lead_corporate_docs
  FOR UPDATE USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

COMMIT;

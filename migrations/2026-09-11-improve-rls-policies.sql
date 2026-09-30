-- 2026-09-11-improve-rls-policies.sql
--
-- Purpose: Improve RLS policies to address linter warnings 0024_permissive_rls_policy
--
-- Context (from CLAUDE.md SEC-004): "every authenticated admin can see and edit
-- every deal/lead — there is intentionally NO per-deal or per-team scoping. All
-- admins are trusted staff."
--
-- The warning: policies with `WITH CHECK (true)` for INSERT/UPDATE/DELETE are
-- overly permissive. The design is intentional, but we can at least:
-- 1. Restrict INSERT/UPDATE policies to authenticated users (not anon)
-- 2. Document the trusted-staff access model

-- ════════════════════════════════════════════════════════════════════════════
-- CLIENTS table - restrict to authenticated admins only
-- ════════════════════════════════════════════════════════════════════════════

-- Remove old overly-permissive policies
DROP POLICY IF EXISTS "Authenticated users can insert clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can update clients" ON public.clients;

-- Restrict INSERT to authenticated users (admin middleware gates to admins)
CREATE POLICY "Authenticated users can insert clients"
  ON public.clients
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Restrict UPDATE to authenticated users
CREATE POLICY "Authenticated users can update clients"
  ON public.clients
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Keep SELECT for authenticated (read-only access)
DROP POLICY IF EXISTS "Enable read for authenticated users" ON public.clients;
CREATE POLICY "Enable read for authenticated users"
  ON public.clients
  FOR SELECT
  TO authenticated
  USING (true);

-- ════════════════════════════════════════════════════════════════════════════
-- LEAD_CORPORATE_DOCS table - restrict to authenticated only
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow insert lead_corporate_docs" ON public.lead_corporate_docs;

-- Restrict to authenticated users (anon should not insert documents)
CREATE POLICY "Allow insert lead_corporate_docs"
  ON public.lead_corporate_docs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Allow authenticated to read and update
DROP POLICY IF EXISTS "Allow update lead_corporate_docs" ON public.lead_corporate_docs;
DROP POLICY IF EXISTS "Allow select lead_corporate_docs" ON public.lead_corporate_docs;

CREATE POLICY "Allow read lead_corporate_docs"
  ON public.lead_corporate_docs
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow update lead_corporate_docs"
  ON public.lead_corporate_docs
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════════════
-- LEADS table - restrict to authenticated only
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow insert leads" ON public.leads;

-- Restrict to authenticated (public intake uses portal repo, not admin)
CREATE POLICY "Allow insert leads"
  ON public.leads
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Allow authenticated to read and update
DROP POLICY IF EXISTS "Allow update leads" ON public.leads;
DROP POLICY IF EXISTS "Allow select leads" ON public.leads;

CREATE POLICY "Allow read leads"
  ON public.leads
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow update leads"
  ON public.leads
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════════════
-- NOTE: These policies intentionally allow all authenticated users full access
-- (INSERT, UPDATE, DELETE). This reflects the design decision that all staff
-- admins are trusted to see and edit every file. Per-deal authorization would
-- require changes to the middleware + RLS policy structure, which is not
-- currently in scope. If per-user or per-team scoping is ever added, these
-- policies must be updated to enforce that at the RLS level.
-- ════════════════════════════════════════════════════════════════════════════

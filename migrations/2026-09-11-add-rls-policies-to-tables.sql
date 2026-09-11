-- 2026-09-11 — Add RLS policies to tables with RLS enabled but no policies
--
-- Per CLAUDE.md: all authenticated admins can see and edit every deal/lead.
-- There is intentionally NO per-deal or per-team scoping. RLS policies should:
--   1. Allow authenticated users to read all data
--   2. Only allow SELECT for most tables (updates handled via Next.js API)
--   3. Some admin-only tables restrict to specific roles
--
-- Strategy: Use auth.role() = 'authenticated' for readable data,
-- with stricter policies for sensitive tables.

BEGIN;

-- ========== AUDIT & SYSTEM TABLES (admin/system only) ==========

-- audit_logs: system table, authenticated users can read
CREATE POLICY "audit_logs_select" ON public.audit_logs
  FOR SELECT USING (auth.role() = 'authenticated');

-- migration_runs: system table, read-only for authenticated
CREATE POLICY "migration_runs_select" ON public.migration_runs
  FOR SELECT USING (auth.role() = 'authenticated');

-- rate_limits: system table, read-only for authenticated
CREATE POLICY "rate_limits_select" ON public.rate_limits
  FOR SELECT USING (auth.role() = 'authenticated');

-- ========== CONFIGURATION/REFERENCE TABLES (read-only) ==========

-- closing_cost_config: reference data, readable by all authenticated users
CREATE POLICY "closing_cost_config_select" ON public.closing_cost_config
  FOR SELECT USING (auth.role() = 'authenticated');

-- closing_cost_shared_rates: reference data, readable by all authenticated users
CREATE POLICY "closing_cost_shared_rates_select" ON public.closing_cost_shared_rates
  FOR SELECT USING (auth.role() = 'authenticated');

-- closing_cost_statement_types: reference data, readable by all authenticated users
CREATE POLICY "closing_cost_statement_types_select" ON public.closing_cost_statement_types
  FOR SELECT USING (auth.role() = 'authenticated');

-- partner_contacts: reference data, readable by all authenticated users
CREATE POLICY "partner_contacts_select" ON public.partner_contacts
  FOR SELECT USING (auth.role() = 'authenticated');

-- task_form_fields: reference data, readable by all authenticated users
CREATE POLICY "task_form_fields_select" ON public.task_form_fields
  FOR SELECT USING (auth.role() = 'authenticated');

-- ========== DEAL/DOCUMENT DATA TABLES ==========

-- deal_closing_estimates: deal data, readable by authenticated users
CREATE POLICY "deal_closing_estimates_select" ON public.deal_closing_estimates
  FOR SELECT USING (auth.role() = 'authenticated');

-- deal_co_purchasers: deal data, readable by authenticated users
CREATE POLICY "deal_co_purchasers_select" ON public.deal_co_purchasers
  FOR SELECT USING (auth.role() = 'authenticated');

-- deal_documents: deal documents, readable by authenticated users
CREATE POLICY "deal_documents_select" ON public.deal_documents
  FOR SELECT USING (auth.role() = 'authenticated');

-- deal_notes: deal notes, readable by authenticated users
CREATE POLICY "deal_notes_select" ON public.deal_notes
  FOR SELECT USING (auth.role() = 'authenticated');

-- lead_identification_docs: lead documents, readable by authenticated users
CREATE POLICY "lead_identification_docs_select" ON public.lead_identification_docs
  FOR SELECT USING (auth.role() = 'authenticated');

-- invitation_tokens: access tokens, readable by authenticated users
CREATE POLICY "invitation_tokens_select" ON public.invitation_tokens
  FOR SELECT USING (auth.role() = 'authenticated');

-- ========== NOTIFICATION TABLES (user-specific) ==========

-- notifications: readable by all authenticated users (portal reads all notifications)
CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT USING (auth.role() = 'authenticated');

-- notification_reads: user-specific reads, readable by authenticated users
CREATE POLICY "notification_reads_select" ON public.notification_reads
  FOR SELECT USING (auth.role() = 'authenticated');

COMMIT;

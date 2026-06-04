-- 2026-06-03-phaseE-drop-personal-from-leads.sql
--
-- ⚠️ GATED / DESTRUCTIVE — RUN LAST.
-- Run this ONLY AFTER both apps are deployed with the Phase E code:
--   * admin repo (iclosed_admin_dev)
--   * customer portal repo (iclosed_web_dev)
-- and you have verified intake / deal views / Personal Info / non-citizen flag
-- all work in BOTH apps. Until both are deployed, the live (old) code still
-- reads/writes these columns — dropping early would break it.
--
-- Scope: drops the 4 PERSONAL fields from leads. They now live only on
-- public.clients (the source of truth), kept in sync by triggers + the
-- migrated read/write code.
--   marital_status, citizenship_status, occupation, employer_phone
--
-- NOT dropped: the corporate fields (is_corporate, corporate_name, inc_number,
-- corporate_email) stay on leads — they are written at intake and mirrored to
-- clients by the sync_lead_to_clients trigger. Address fields stay (property).

-- 1. Remove the transitional lead-edit→clients trigger (it reads the columns
--    being dropped). Lead edits now write straight to clients via the API.
DROP TRIGGER IF EXISTS sync_lead_personal_to_clients ON public.leads;
DROP FUNCTION IF EXISTS public.sync_lead_personal_to_clients();

-- 2. Drop the 4 personal columns. Their CHECK constraints
--    (leads_marital_status_check, leads_citizenship_status_check) are dropped
--    automatically with the columns.
ALTER TABLE public.leads
  DROP COLUMN IF EXISTS marital_status,
  DROP COLUMN IF EXISTS citizenship_status,
  DROP COLUMN IF EXISTS occupation,
  DROP COLUMN IF EXISTS employer_phone;

-- 2026-06-03-add-person-fields-to-clients.sql
--
-- Purpose: enrich public.clients (the customer/person table) with the person's
-- personal details, so it becomes a CRM-ready customer record — WITHOUT renaming
-- the table and WITHOUT dropping anything from leads.
--
-- Why additive only: the `clients` table is shared by BOTH apps on the same
-- database — the admin portal (iclosed_admin_dev) AND the customer portal
-- (iclosed_web_dev). Renaming it or dropping lead columns would break the live
-- customer portal. Adding columns is safe: existing code in both apps is
-- unaffected; the new columns are simply available for future CRM use.
--
-- NOTE: `address_*` is deliberately NOT copied here — on leads it is the
-- PROPERTY/file address (used as deal.property_address), not the person's home
-- address. Address stays on leads.

-- 1. Add the personal columns (plain text/boolean, no CHECK — kept flexible for CRM).
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS marital_status     text,
  ADD COLUMN IF NOT EXISTS citizenship_status text,
  ADD COLUMN IF NOT EXISTS occupation         text,
  ADD COLUMN IF NOT EXISTS employer_phone     text,
  ADD COLUMN IF NOT EXISTS is_corporate       boolean,
  ADD COLUMN IF NOT EXISTS corporate_name     text,
  ADD COLUMN IF NOT EXISTS inc_number         text,
  ADD COLUMN IF NOT EXISTS corporate_email    text;

-- 2. Backfill from the most-recent lead per email, so every existing customer
--    carries their personal details immediately.
UPDATE public.clients c
SET marital_status     = src.marital_status,
    citizenship_status = src.citizenship_status,
    occupation         = src.occupation,
    employer_phone     = src.employer_phone,
    is_corporate       = src.is_corporate,
    corporate_name     = src.corporate_name,
    inc_number         = src.inc_number,
    corporate_email    = src.corporate_email
FROM (
  SELECT DISTINCT ON (lower(email))
    email, marital_status, citizenship_status, occupation, employer_phone,
    is_corporate, corporate_name, inc_number, corporate_email
  FROM public.leads
  WHERE email IS NOT NULL AND btrim(email) <> ''
  ORDER BY lower(email), created_at DESC NULLS LAST
) src
WHERE lower(c.email) = lower(src.email);

-- Going forward: leads remain the system of record that both apps read/write
-- for these fields. To keep clients' copy fresh for new/edited leads is an
-- optional follow-up (a leads->clients sync trigger) — intentionally NOT added
-- here to keep this change purely additive and risk-free.

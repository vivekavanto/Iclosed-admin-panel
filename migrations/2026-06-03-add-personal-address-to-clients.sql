-- 2026-06-03-add-personal-address-to-clients.sql
--
-- Purpose: store the CUSTOMER'S OWN (current/residential) address on
-- public.clients — distinct from the property address.
--
-- Important source note:
--   * leads.address_* = the PROPERTY being bought/sold (used as
--     deal.property_address) — NOT the person's address. Do NOT use it here.
--   * The customer's real current address is what they enter in the
--     "Personal Information" task ("Current address": street / city / postal),
--     stored in public.task_responses. That is the correct source.
--
-- ADDITIVE only: adds columns to clients + backfills. The `clients` table is
-- shared by the admin AND customer portals; adding columns breaks neither.

-- 1. Personal/current address columns (clients = the person, so these are the
--    person's address — not the property).
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS address_street      text,
  ADD COLUMN IF NOT EXISTS address_unit        text,
  ADD COLUMN IF NOT EXISTS address_city        text,
  ADD COLUMN IF NOT EXISTS address_province    text,
  ADD COLUMN IF NOT EXISTS address_postal_code text;

-- 2. Backfill from each customer's latest "Personal Information" task responses.
--    Path: clients -> deals(client_id) -> tasks(personal info) -> task_responses.
WITH pi_tasks AS (
  SELECT t.id AS task_id, d.client_id, t.created_at
  FROM public.tasks t
  JOIN public.deals d ON d.id = t.deal_id
  WHERE d.client_id IS NOT NULL
    AND lower(COALESCE(t.title, '')) LIKE '%personal info%'
),
latest_pi AS (
  SELECT DISTINCT ON (client_id) client_id, task_id
  FROM pi_tasks
  ORDER BY client_id, created_at DESC NULLS LAST
),
addr AS (
  SELECT
    lp.client_id,
    MAX(CASE WHEN lower(r.field_label) LIKE '%street%'  THEN r.value END) AS street,
    MAX(CASE WHEN lower(r.field_label) =   'city'
              OR lower(r.field_label) LIKE 'city%'       THEN r.value END) AS city,
    MAX(CASE WHEN lower(r.field_label) LIKE '%postal%'  THEN r.value END) AS postal
  FROM latest_pi lp
  JOIN public.task_responses r ON r.task_id = lp.task_id
  GROUP BY lp.client_id
)
UPDATE public.clients c
SET address_street      = COALESCE(NULLIF(btrim(a.street), ''), c.address_street),
    address_city        = COALESCE(NULLIF(btrim(a.city), ''),   c.address_city),
    address_postal_code = COALESCE(NULLIF(btrim(a.postal), ''), c.address_postal_code)
FROM addr a
WHERE c.id = a.client_id;

-- Note: the Personal Information task collects street / city / postal only, so
-- address_unit and address_province stay NULL (available for future manual/CRM
-- entry). Going forward, new submissions write to task_responses; syncing those
-- into clients.address_* is an optional follow-up (kept out to stay additive).

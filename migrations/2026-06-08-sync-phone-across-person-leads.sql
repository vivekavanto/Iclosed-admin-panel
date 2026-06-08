-- 2026-06-08-sync-phone-across-person-leads.sql
--
-- A person can have several deals, and each deal is its own public.leads row
-- with its own `phone` column. Historically those copies drifted: the same
-- client (same email) could show different phone numbers on different deals,
-- and public.clients (the customer record the portal reads) could be stale too.
--
-- This migration makes phone behave as a per-PERSON attribute (keyed by email):
--   1. One-time BACKFILL — converge every person's leads + client record to a
--      single canonical phone (the most-recent non-empty lead phone per email).
--   2. A TRIGGER — going forward, any phone change on a lead propagates to that
--      person's other leads and their clients row, so they can never drift again.
--
-- The trigger is null/empty-safe and SECURITY DEFINER, mirroring
-- sync_lead_personal_to_clients (2026-06-03-phaseD), and skips admin accounts.

-- ── 1. Backfill ───────────────────────────────────────────────────────────
-- Canonical phone per email = the phone from the row that (a) has a non-empty
-- phone and (b) was created most recently. Deterministic and sourced purely
-- from existing lead data.
WITH canonical AS (
  SELECT email_key, phone
  FROM (
    SELECT
      lower(email) AS email_key,
      phone,
      row_number() OVER (
        PARTITION BY lower(email)
        ORDER BY (NULLIF(btrim(COALESCE(phone, '')), '') IS NOT NULL) DESC,
                 created_at DESC NULLS LAST
      ) AS rn
    FROM public.leads
    WHERE email IS NOT NULL AND btrim(email) <> ''
  ) ranked
  WHERE rn = 1
    AND NULLIF(btrim(COALESCE(phone, '')), '') IS NOT NULL
)
UPDATE public.leads l
SET phone = c.phone
FROM canonical c
WHERE lower(l.email) = c.email_key
  AND l.phone IS DISTINCT FROM c.phone;

WITH canonical AS (
  SELECT email_key, phone
  FROM (
    SELECT
      lower(email) AS email_key,
      phone,
      row_number() OVER (
        PARTITION BY lower(email)
        ORDER BY (NULLIF(btrim(COALESCE(phone, '')), '') IS NOT NULL) DESC,
                 created_at DESC NULLS LAST
      ) AS rn
    FROM public.leads
    WHERE email IS NOT NULL AND btrim(email) <> ''
  ) ranked
  WHERE rn = 1
    AND NULLIF(btrim(COALESCE(phone, '')), '') IS NOT NULL
)
UPDATE public.clients cl
SET phone = c.phone
FROM canonical c
WHERE lower(cl.email) = c.email_key
  AND cl.phone IS DISTINCT FROM c.phone;

-- ── 2. Forward-sync trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_lead_phone_across_person()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when phone actually changed and we have an email to key on.
  IF NEW.phone IS NOT DISTINCT FROM OLD.phone THEN RETURN NEW; END IF;
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_users a WHERE lower(a.email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;

  -- Propagate to the person's OTHER leads. The `phone IS DISTINCT FROM`
  -- guard means once every row matches, the recursive re-fire updates zero
  -- rows and the cascade terminates.
  UPDATE public.leads
  SET phone = NEW.phone
  WHERE lower(email) = lower(NEW.email)
    AND id <> NEW.id
    AND phone IS DISTINCT FROM NEW.phone;

  -- Keep the single customer record in sync too (the portal reads this).
  UPDATE public.clients
  SET phone = NEW.phone
  WHERE lower(email) = lower(NEW.email)
    AND phone IS DISTINCT FROM NEW.phone;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_lead_phone_across_person ON public.leads;
CREATE TRIGGER sync_lead_phone_across_person
  AFTER UPDATE OF phone ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_lead_phone_across_person();

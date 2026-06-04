-- 2026-06-03-phase0-clients-source-prep.sql
--
-- Phase 0 of making public.clients the source of truth for the 8 personal
-- fields. DB-only, additive, safe — no app behavior changes yet. Prepares
-- clients to be complete + consistent BEFORE any code starts reading from it.
--
-- 1. Extend the intake trigger to also copy corporate fields into the client.
-- 2. Backfill any client rows missing corporate fields.
-- 3. Normalize citizenship_status to lowercase (the non-citizen flag depends on
--    lowercase codes).

-- 1. Intake trigger now also seeds corporate fields on the new client row.
--    Stays SECURITY DEFINER + conflict/null-safe so intake can never break.
CREATE OR REPLACE FUNCTION public.sync_lead_to_clients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;
  -- Staff/admin emails belong in admin_users, not clients.
  IF EXISTS (SELECT 1 FROM public.admin_users a WHERE lower(a.email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.clients (
    email, first_name, last_name, phone, converted,
    is_corporate, corporate_name, inc_number, corporate_email
  )
  VALUES (
    NEW.email, NEW.first_name, NEW.last_name, NEW.phone, false,
    NEW.is_corporate, NEW.corporate_name, NEW.inc_number, NEW.corporate_email
  )
  ON CONFLICT (lower(email)) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 2. Backfill corporate fields onto existing clients that don't have them yet
--    (fill-if-missing — never clobber an existing value).
UPDATE public.clients c
SET is_corporate    = COALESCE(c.is_corporate, src.is_corporate),
    corporate_name  = COALESCE(c.corporate_name, src.corporate_name),
    inc_number      = COALESCE(c.inc_number, src.inc_number),
    corporate_email = COALESCE(c.corporate_email, src.corporate_email)
FROM (
  SELECT DISTINCT ON (lower(email))
    email, is_corporate, corporate_name, inc_number, corporate_email
  FROM public.leads
  WHERE email IS NOT NULL AND btrim(email) <> ''
  ORDER BY lower(email), created_at DESC NULLS LAST
) src
WHERE lower(c.email) = lower(src.email)
  AND (c.corporate_name IS NULL AND c.inc_number IS NULL AND c.corporate_email IS NULL
       AND c.is_corporate IS NULL);

-- 3. Normalize citizenship_status to lowercase codes (flag relies on this).
UPDATE public.clients
SET citizenship_status = lower(citizenship_status)
WHERE citizenship_status IS NOT NULL
  AND citizenship_status <> lower(citizenship_status);

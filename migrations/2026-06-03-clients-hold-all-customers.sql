-- 2026-06-03-clients-hold-all-customers.sql
--
-- Purpose: make public.clients show EVERY customer in one place — both
-- not-yet-converted people and converted customers — so the clients table
-- itself is the single customer list for a future CRM.
--
-- How: WITHOUT changing any application code or the convert flow. Achieved with
-- a one-time backfill + DB triggers on public.leads that auto-create / update a
-- clients row. The convert flow keeps working: it looks up the client by email
-- (case-insensitive) and now simply FINDS the row the trigger already made and
-- reuses it.
--
-- A boolean `converted` column tells the two apart:
--   converted = false  -> lead, not yet converted to a deal
--   converted = true   -> converted customer (has / will have a file)
--
-- Trade-off (accepted): a lead's contact info now lives in both leads and
-- clients. To avoid clobbering, the insert trigger uses ON CONFLICT DO NOTHING —
-- clients is treated as the master record once created.
--
-- Safety: triggers are null-safe and conflict-safe so a lead INSERT can never
-- be blocked by them (intake never breaks). Prereq: run the customer-registry
-- migration first (customer_code + unique lower(email) index + updated_at).

-- 1. converted flag: false = lead, true = converted customer.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS converted boolean NOT NULL DEFAULT false;

-- Every client that already exists was created at conversion → mark converted.
UPDATE public.clients SET converted = true WHERE converted <> true;

-- 2. Backfill: create a clients row for each existing (active) lead that isn't
--    already in clients. DISTINCT ON avoids inserting the same email twice when
--    multiple leads share it. customer_code / updated_at fill via their defaults.
INSERT INTO public.clients (email, first_name, last_name, phone, converted)
SELECT DISTINCT ON (lower(l.email))
  l.email, l.first_name, l.last_name, l.phone, false
FROM public.leads l
WHERE l.email IS NOT NULL
  AND btrim(l.email) <> ''
  AND COALESCE(l.is_deleted, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM public.clients c WHERE lower(c.email) = lower(l.email)
  )
ORDER BY lower(l.email), l.created_at NULLS LAST;

-- 3. New lead -> auto-create a clients row (converted = false). Conflict/null
--    safe so it can never block a lead insert.
CREATE OR REPLACE FUNCTION public.sync_lead_to_clients()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.clients (email, first_name, last_name, phone, converted)
  VALUES (NEW.email, NEW.first_name, NEW.last_name, NEW.phone, false)
  ON CONFLICT (lower(email)) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_lead_to_clients ON public.leads;
CREATE TRIGGER sync_lead_to_clients
  AFTER INSERT ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_lead_to_clients();

-- 4. When a lead is converted, flip its clients row to converted = true.
CREATE OR REPLACE FUNCTION public.mark_client_converted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'Converted'
     AND COALESCE(OLD.status, '') <> 'Converted'
     AND NEW.email IS NOT NULL THEN
    UPDATE public.clients
    SET converted = true
    WHERE lower(email) = lower(NEW.email);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mark_client_converted ON public.leads;
CREATE TRIGGER mark_client_converted
  AFTER UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_client_converted();

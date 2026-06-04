-- 2026-06-03-phaseD-lead-edit-sync-to-clients.sql
--
-- Keep public.clients fresh when a lead's personal/corporate fields are EDITED
-- (e.g. admin Leads page PUT). Reads now come from clients, so clients must
-- reflect the latest. Intake + Personal-Info edits already sync; this closes the
-- remaining gap: direct lead edits.
--
-- Only fields that ACTUALLY CHANGED in the update AND are non-empty are
-- propagated — so an unrelated lead update never overwrites a fresher client
-- value (e.g. one already set via the Personal Information task).
--
-- SECURITY DEFINER + null/empty-safe → a lead update can never be blocked.

CREATE OR REPLACE FUNCTION public.sync_lead_personal_to_clients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id uuid;
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_users a WHERE lower(a.email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;

  v_client_id := NEW.client_id;
  IF v_client_id IS NULL THEN
    SELECT id INTO v_client_id FROM public.clients WHERE lower(email) = lower(NEW.email) LIMIT 1;
  END IF;
  IF v_client_id IS NULL THEN RETURN NEW; END IF;

  UPDATE public.clients SET
    marital_status = CASE
      WHEN NEW.marital_status IS DISTINCT FROM OLD.marital_status
       AND NULLIF(btrim(COALESCE(NEW.marital_status, '')), '') IS NOT NULL
      THEN NEW.marital_status ELSE marital_status END,
    citizenship_status = CASE
      WHEN NEW.citizenship_status IS DISTINCT FROM OLD.citizenship_status
       AND NULLIF(btrim(COALESCE(NEW.citizenship_status, '')), '') IS NOT NULL
      THEN lower(NEW.citizenship_status) ELSE citizenship_status END,
    occupation = CASE
      WHEN NEW.occupation IS DISTINCT FROM OLD.occupation
       AND NULLIF(btrim(COALESCE(NEW.occupation, '')), '') IS NOT NULL
      THEN NEW.occupation ELSE occupation END,
    employer_phone = CASE
      WHEN NEW.employer_phone IS DISTINCT FROM OLD.employer_phone
       AND NULLIF(btrim(COALESCE(NEW.employer_phone, '')), '') IS NOT NULL
      THEN NEW.employer_phone ELSE employer_phone END,
    is_corporate = CASE
      WHEN NEW.is_corporate IS DISTINCT FROM OLD.is_corporate
      THEN NEW.is_corporate ELSE is_corporate END,
    corporate_name = CASE
      WHEN NEW.corporate_name IS DISTINCT FROM OLD.corporate_name
       AND NULLIF(btrim(COALESCE(NEW.corporate_name, '')), '') IS NOT NULL
      THEN NEW.corporate_name ELSE corporate_name END,
    inc_number = CASE
      WHEN NEW.inc_number IS DISTINCT FROM OLD.inc_number
       AND NULLIF(btrim(COALESCE(NEW.inc_number, '')), '') IS NOT NULL
      THEN NEW.inc_number ELSE inc_number END,
    corporate_email = CASE
      WHEN NEW.corporate_email IS DISTINCT FROM OLD.corporate_email
       AND NULLIF(btrim(COALESCE(NEW.corporate_email, '')), '') IS NOT NULL
      THEN NEW.corporate_email ELSE corporate_email END
  WHERE id = v_client_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_lead_personal_to_clients ON public.leads;
CREATE TRIGGER sync_lead_personal_to_clients
  AFTER UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_lead_personal_to_clients();

-- 2026-06-03-sync-personal-info-to-clients.sql
--
-- Purpose: when a customer's "Personal Information" task is saved/edited (in
-- EITHER the admin portal or the customer portal), keep the matching row in
-- public.clients up to date — so clients always reflects the latest personal
-- details, not just the one-time backfill.
--
-- How: a trigger on public.task_responses. The Personal Info form stores each
-- field as a task_responses row; on insert/update we resolve the task -> deal ->
-- client and copy the field into the matching clients column.
--
-- Safety:
--   * SECURITY DEFINER + fixed search_path → runs with owner rights (no
--     "permission denied for sequence/table" like the intake bug); the caller's
--     role (portal/admin) does not need direct rights on clients.
--   * Fully null-safe / no-op-safe: if anything doesn't resolve, it RETURNs
--     without error, so a response save is NEVER blocked.
--   * Only NON-EMPTY values are written, so saving a draft with blank fields
--     never wipes existing client data.
--   * Only fields that map to a clients column are synced; everything else is
--     ignored. Property/transaction fields are untouched.

CREATE OR REPLACE FUNCTION public.sync_personal_info_to_clients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title     text;
  v_deal_id   uuid;
  v_client_id uuid;
  v_label     text;
  v_value     text;
  v_col       text;
BEGIN
  IF NEW.task_id IS NULL OR NEW.field_label IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only sync for Personal Information tasks.
  SELECT t.title, t.deal_id INTO v_title, v_deal_id
  FROM public.tasks t WHERE t.id = NEW.task_id;

  IF v_title IS NULL OR lower(v_title) NOT LIKE '%personal info%' THEN
    RETURN NEW;
  END IF;

  -- Resolve the customer this task belongs to.
  SELECT d.client_id INTO v_client_id
  FROM public.deals d WHERE d.id = v_deal_id;

  IF v_client_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Never overwrite a client field with an empty value (protects drafts).
  v_value := NULLIF(btrim(COALESCE(NEW.value, '')), '');
  IF v_value IS NULL THEN
    RETURN NEW;
  END IF;

  -- Map the response's field label to a clients column.
  v_label := lower(btrim(NEW.field_label));
  IF    v_label LIKE '%street%'                                          THEN v_col := 'address_street';
  ELSIF v_label = 'city' OR v_label LIKE 'city%'                         THEN v_col := 'address_city';
  ELSIF v_label LIKE '%postal%'                                          THEN v_col := 'address_postal_code';
  ELSIF v_label LIKE '%marital%'                                         THEN v_col := 'marital_status';
  ELSIF v_label LIKE '%citizenship%'                                     THEN v_col := 'citizenship_status';
  ELSIF v_label LIKE '%occupation%'                                      THEN v_col := 'occupation';
  ELSIF (v_label LIKE '%employer%' OR v_label LIKE '%business%')
        AND v_label LIKE '%phone%'                                       THEN v_col := 'employer_phone';
  ELSIF v_label LIKE '%phone%'                                           THEN v_col := 'phone';
  ELSE
    RETURN NEW;  -- field has no matching clients column (e.g. source of funds)
  END IF;

  -- Update only the one mapped column. v_col is from a fixed allowlist above,
  -- so the dynamic SQL is safe.
  EXECUTE format('UPDATE public.clients SET %I = $1 WHERE id = $2', v_col)
  USING v_value, v_client_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_personal_info_to_clients ON public.task_responses;
CREATE TRIGGER sync_personal_info_to_clients
  AFTER INSERT OR UPDATE ON public.task_responses
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_personal_info_to_clients();
